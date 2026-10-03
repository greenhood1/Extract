require('dotenv').config();
const express = require('express'), crypto = require('crypto'), path = require('path');
const E = process.env;
const FREE_DAILY = +E.FREE_DAILY || 5, BASE = E.BASE_URL || 'http://localhost:3000';
const SECRET = E.SECRET || 'dev-secret', MODEL = E.MODEL || 'claude-haiku-4-5-20251001';
const PROD = E.NODE_ENV === 'production', DEV = !PROD && E.DEV_PRO === '1', ACC_FREE = +E.ACCURATE_FREE_DAILY || 3;
if (PROD && !E.SECRET) { console.error('Set SECRET in production.'); process.exit(1); }
const app = express();
const PRICE = +E.PRO_PRICE_NGN || 1500, PRICE_USD = +E.PRO_PRICE_USD || 2, USD_ON = E.USD_ENABLED === '1', usedRefs = new Set();
app.set('trust proxy', 1);
app.get('/health', (req, res) => res.send('ok'));
app.use((req, res, next) => {   // HTTPS only + safe headers
  if (PROD && req.get('x-forwarded-proto') === 'http') return res.redirect(301, 'https://' + req.get('host') + req.originalUrl);
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(self)' });
  next();
});
const hits = new Map();         // simple rate limit: 40 API calls / minute / IP
app.use('/api', (req, res, next) => {
  const now = Date.now(), h = (hits.get(req.ip) || []).filter(t => now - t < 60000);
  if (h.length >= 40) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  h.push(now); hits.set(req.ip, h); next();
});
setInterval(() => hits.clear(), 600000);

// Google Analytics loader (ID comes from .env so it is never hard-coded)
app.get('/ga.js', (req, res) => {   // loaded only after the visitor accepts (see consent.js)
  res.type('js').send(`(function(){var id=${JSON.stringify(E.GA_ID || '')};window.track=function(n,p){window.gtag&&gtag('event',n,p||{})};
window.loadGA=function(){if(!id||window.__ga)return;window.__ga=1;var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id='+id;document.head.appendChild(s);
window.dataLayer=window.dataLayer||[];window.gtag=function(){dataLayer.push(arguments)};gtag('js',new Date());gtag('config',id);}})();`);
});
app.use(express.json({ limit: '8mb' }));
// Flat project (no folders): only these files are ever shared with visitors; server.js and secrets never are.
const PUBLIC = ['index.html', 'app.js', 'style.css', 'consent.js', 'sw.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'privacy.html', 'terms.html', 'admin.html'];
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const f = req.path === '/' ? 'index.html' : req.path.slice(1);
  const hit = PUBLIC.includes(f) ? f : PUBLIC.includes(f + '.html') ? f + '.html' : null;
  hit ? res.sendFile(path.join(__dirname, hit)) : next();
});

// ---- Pro tokens (signed, 35 days) ----
const sign = exp => crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
const makeToken = () => { const exp = Date.now() + 30 * 864e5; return { t: exp + '.' + sign(exp), exp }; };
const isPro = req => {
  const [exp, sig] = String(req.get('x-pro-token') || '').split('.');
  return !!exp && +exp > Date.now() && sig === sign(exp);
};

// ---- Free daily usage (in memory; use Redis/DB in production) ----
const usage = new Map();
const used = (id, inc) => {
  const k = id + new Date().toISOString().slice(0, 10);
  const n = (usage.get(k) || 0) + (inc ? 1 : 0);
  if (inc) usage.set(k, n);
  return n;
};

// ---- AI: explain / translate ----
app.post('/api/ai', async (req, res) => {
  const { task, text = '', lang = 'English', device = 'anon' } = req.body;
  const pro = isPro(req);
  if (!text.trim()) return res.status(400).json({ error: 'No text.' });
  if (task === 'translate' && !pro) return res.status(402).json({ error: 'Translation is a Pro feature.' });
  if (!pro && used(device) >= FREE_DAILY)
    return res.status(429).json({ error: `Free limit reached (${FREE_DAILY}/day). Upgrade to Pro.` });
  if (!E.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server missing ANTHROPIC_API_KEY.' });

  const prompts = {
    explain: 'Explain this notice in 3 short plain sentences, then list any dates, places, deadlines or actions required:\n\n',
    translate: `Translate the following into ${lang}. Output only the translation:\n\n`
  };
  if (!prompts[task]) return res.status(400).json({ error: 'Unknown task.' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1000, messages: [{ role: 'user', content: prompts[task] + text.slice(0, 8000) }] })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j.error?.message || 'AI error' });
    if (!pro) used(device, true);
    res.json({ result: j.content.map(c => c.text || '').join(''), left: pro ? null : FREE_DAILY - used(device) });
  } catch (e) { res.status(502).json({ error: 'AI request failed.' }); }
});

// ---- Test mode (DEV_PRO=1): lets you try Pro without paying. Turn OFF in production. ----
app.get('/api/config', (req, res) => res.json({ dev: DEV, price: PRICE, priceUsd: PRICE_USD, usdOn: USD_ON, wa: E.WHATSAPP_NUMBER || '' }));
app.post('/api/dev-pro', (req, res) => DEV ? res.json(makeToken()) : res.status(403).json({ error: 'Disabled.' }));

// ---- Accurate OCR with AI vision ----
app.post('/api/ocr', async (req, res) => {
  const { image, device = 'anon' } = req.body, pro = isPro(req);
  if (!image) return res.status(400).json({ error: 'No image.' });
  if (!pro && used(device + '-ocr') >= ACC_FREE)
    return res.status(429).json({ error: `Free Accurate scans used up (${ACC_FREE}/day). Upgrade to Pro.` });
  if (!E.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server missing ANTHROPIC_API_KEY.' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
        { type: 'text', text: 'Extract ALL text from this image exactly as written, in reading order, keeping line breaks. Output only the text. If there is no text, output: No text found.' }
      ] }] })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j.error?.message || 'AI error' });
    if (!pro) used(device + '-ocr', true);
    res.json({ result: j.content.map(c => c.text || '').join('').trim(), left: pro ? null : ACC_FREE - used(device + '-ocr') });
  } catch (e) { res.status(502).json({ error: 'AI request failed.' }); }
});

// ---- Manual payments (bank transfer / WhatsApp): you make a code, the customer redeems it ----
const usedCodes = new Set();   // resets on restart; codes also expire after 7 days
const codeSig = (n, x) => crypto.createHmac('sha256', SECRET).update('code:' + n + x).digest('hex').slice(0, 10);
app.post('/api/admin/code', (req, res) => {
  if (!E.ADMIN_KEY || req.get('x-admin-key') !== E.ADMIN_KEY) return res.status(404).end();
  const nonce = crypto.randomBytes(4).toString('hex'), exp36 = (Date.now() + 7 * 864e5).toString(36);
  res.json({ code: `${nonce}-${exp36}-${codeSig(nonce, exp36)}` });
});
app.post('/api/redeem', (req, res) => {
  const [nonce, exp36, sig] = String(req.body.code || '').trim().toLowerCase().split('-');
  if (!nonce || !exp36 || sig !== codeSig(nonce, exp36) || parseInt(exp36, 36) < Date.now())
    return res.status(400).json({ error: 'Invalid or expired code.' });
  if (usedCodes.has(nonce)) return res.status(400).json({ error: 'This code was already used.' });
  usedCodes.add(nonce); res.json(makeToken());
});

// ---- Paystack (Nigeria): one payment = 30 days of Pro ----
const paystack = (p, opt = {}) => fetch('https://api.paystack.co/' + p, {
  ...opt, headers: { Authorization: 'Bearer ' + E.PAYSTACK_SECRET_KEY, 'content-type': 'application/json' }
}).then(r => r.json());

app.post('/api/checkout', async (req, res) => {
  if (!E.PAYSTACK_SECRET_KEY) return res.status(500).json({ error: 'Paystack not configured.' });
  const { email, currency } = req.body, usd = currency === 'USD' && USD_ON;
  if (!/^\S+@\S+\.\S+$/.test(email || '')) return res.status(400).json({ error: 'Enter a valid email.' });
  const j = await paystack('transaction/initialize', { method: 'POST',
    body: JSON.stringify({ email, amount: (usd ? PRICE_USD : PRICE) * 100, currency: usd ? 'USD' : 'NGN', callback_url: BASE + '/' }) });
  j.status ? res.json({ url: j.data.authorization_url }) : res.status(502).json({ error: j.message || 'Paystack error' });
});

app.get('/api/verify', async (req, res) => {
  const ref = String(req.query.reference || '');
  if (!ref || usedRefs.has(ref)) return res.status(402).json({ error: 'Invalid or already used payment.' });
  const j = await paystack('transaction/verify/' + encodeURIComponent(ref));
  if (j.status && j.data?.status === 'success' && j.data.amount >= (j.data.currency === 'USD' ? (USD_ON ? PRICE_USD : Infinity) : PRICE) * 100 && Date.now() - new Date(j.data.paid_at) < 2 * 36e5) { usedRefs.add(ref); return res.json(makeToken()); }
  res.status(402).json({ error: 'Payment not confirmed.' });
});

app.listen(E.PORT || 3000, () => console.log('SnapExplain on ' + BASE));
