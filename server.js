require('dotenv').config();
const express = require('express'), crypto = require('crypto'), path = require('path'), fs = require('fs');
const E = process.env;
const FREE_DAILY = +E.FREE_DAILY || 5, BASE = E.BASE_URL || 'http://localhost:3000';
const SECRET = E.SECRET || 'dev-secret', MODEL = E.MODEL || 'claude-haiku-4-5-20251001';
const PROD = E.NODE_ENV === 'production', DEV = !PROD && E.DEV_PRO === '1', ACC_FREE = +E.ACCURATE_FREE_DAILY || 3;
if (PROD && !E.SECRET) { console.error('Set SECRET in production.'); process.exit(1); }
const app = express();
const PRICE = +E.PRO_PRICE_NGN || 1500, PRICE_USD = +E.PRO_PRICE_USD || 2, PRICE_DAY = +E.PRO_DAY_NGN || 300, PRICE_DAY_USD = +E.PRO_DAY_USD || 1, USD_ON = E.USD_ENABLED === '1', usedRefs = new Set();
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
  if (!hit) return next();
  if (hit === 'privacy.html' || hit === 'terms.html') {   // contact email + date are filled in from settings
    const p = path.join(__dirname, hit), when = fs.statSync(p).mtime.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    return res.type('html').send(fs.readFileSync(p, 'utf8').replace(/YOUR_EMAIL@example\.com/g, E.SUPPORT_EMAIL || 'YOUR_EMAIL@example.com').replace(/\[DATE\]/g, when));
  }
  res.sendFile(path.join(__dirname, hit));
});

// ---- Pro tokens (signed): plan 'day' = 24 hours, 'month' = 30 days ----
const sign = x => crypto.createHmac('sha256', SECRET).update(String(x)).digest('hex');
const makeToken = (plan = 'month') => {
  const exp = Date.now() + (plan === 'day' ? 864e5 : 30 * 864e5);
  return { t: plan + '.' + exp + '.' + sign(plan + '.' + exp), exp, plan };
};
const isPro = req => {
  const [plan, exp, sig] = String(req.get('x-pro-token') || '').split('.');
  return (plan === 'day' || plan === 'month') && +exp > Date.now() && sig === sign(plan + '.' + exp);
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
app.get('/api/config', (req, res) => res.json({ dev: DEV, price: PRICE, priceUsd: PRICE_USD, usdOn: USD_ON, priceDay: PRICE_DAY, priceDayUsd: PRICE_DAY_USD, wa: E.WHATSAPP_NUMBER || '' }));
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

// ---- Multi-page documents: limits are enforced HERE, not in the browser ----
const PAGE_CAP_FREE = 3, PAGE_CAP_PRO = 100;
const docs = new Map();   // docId -> { n, t }
app.post('/api/page', (req, res) => {
  const { docId, device = 'anon' } = req.body, pro = isPro(req);
  if (!/^[\w-]{8,64}$/.test(docId || '')) return res.status(400).json({ error: 'Bad document.' });
  let d = docs.get(docId);
  if (!d) {
    if (!pro) {
      const k = req.ip + '|' + device + '-doc';
      if (used(k) >= 3) return res.status(429).json({ error: 'Free plan: 3 new documents per day. Upgrade for unlimited.' });
      used(k, true);
    }
    d = { n: 0, t: Date.now() }; docs.set(docId, d);
  }
  if (d.n >= (pro ? PAGE_CAP_PRO : PAGE_CAP_FREE))
    return res.status(402).json({ error: pro ? 'Maximum 100 pages per document.' : `Free plan: ${PAGE_CAP_FREE} pages per document. Upgrade for up to ${PAGE_CAP_PRO}.` });
  d.n++; res.json({ n: d.n });
});
setInterval(() => { const x = Date.now() - 2 * 864e5; for (const [k, v] of docs) if (v.t < x) docs.delete(k); }, 36e5);

// ---- Export (Pro only): files are built on the server, so there is no browser code to bypass ----
const makePdf = require('./pdf');
app.post('/api/export', (req, res) => {
  if (!isPro(req)) return res.status(402).json({ error: 'Export is a Pro feature.' });
  const { format, pages } = req.body;
  if (!Array.isArray(pages) || !pages.length || pages.length > PAGE_CAP_PRO || pages.some(p => typeof p !== 'string') || pages.join('').length > 500000)
    return res.status(400).json({ error: 'Invalid pages.' });
  if (format === 'word') {
    const h = pages.map(p => '<div style="page-break-after:always">' + p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>') + '</div>').join('');
    return res.type('application/msword').attachment('nimbo.doc').send('<html><meta charset="utf-8"><body>' + h + '</body></html>');
  }
  res.type('application/pdf').attachment('nimbo.pdf').send(makePdf(pages));
});

// ---- Manual payments (bank transfer / WhatsApp): you make a code, the customer redeems it ----
const usedCodes = new Set();   // resets on restart; codes also expire after 7 days
const codeSig = (n, x, p) => sign('code:' + n + x + p).slice(0, 10);
app.post('/api/admin/code', (req, res) => {
  if (!E.ADMIN_KEY || req.get('x-admin-key') !== E.ADMIN_KEY) return res.status(404).end();
  const p = req.body.plan === 'day' ? 'd' : 'm', nonce = crypto.randomBytes(4).toString('hex'), exp36 = (Date.now() + 7 * 864e5).toString(36);
  res.json({ code: `${nonce}-${exp36}-${p}-${codeSig(nonce, exp36, p)}` });
});
app.post('/api/redeem', (req, res) => {
  const [nonce, exp36, p, sig] = String(req.body.code || '').trim().toLowerCase().split('-');
  if (!nonce || !exp36 || !['d', 'm'].includes(p) || sig !== codeSig(nonce, exp36, p) || parseInt(exp36, 36) < Date.now())
    return res.status(400).json({ error: 'Invalid or expired code.' });
  if (usedCodes.has(nonce)) return res.status(400).json({ error: 'This code was already used.' });
  usedCodes.add(nonce); res.json(makeToken(p === 'd' ? 'day' : 'month'));
});

const planOf = d => d.metadata?.plan === 'day' ? 'day' : 'month';
const priceFor = d => (d.currency === 'USD'
  ? (USD_ON ? (planOf(d) === 'day' ? PRICE_DAY_USD : PRICE_USD) : Infinity)
  : (planOf(d) === 'day' ? PRICE_DAY : PRICE)) * 100;

// ---- Paystack (Nigeria): one payment = 30 days of Pro ----
const paystack = (p, opt = {}) => fetch('https://api.paystack.co/' + p, {
  ...opt, headers: { Authorization: 'Bearer ' + E.PAYSTACK_SECRET_KEY, 'content-type': 'application/json' }
}).then(r => r.json());

app.post('/api/checkout', async (req, res) => {
  if (!E.PAYSTACK_SECRET_KEY) return res.status(500).json({ error: 'Paystack not configured.' });
  const { email, currency, plan } = req.body, usd = currency === 'USD' && USD_ON, day = plan === 'day';
  if (!/^\S+@\S+\.\S+$/.test(email || '')) return res.status(400).json({ error: 'Enter a valid email.' });
  const j = await paystack('transaction/initialize', { method: 'POST',
    body: JSON.stringify({ email, amount: (usd ? (day ? PRICE_DAY_USD : PRICE_USD) : (day ? PRICE_DAY : PRICE)) * 100, currency: usd ? 'USD' : 'NGN', callback_url: BASE + '/', metadata: { plan: day ? 'day' : 'month' } }) });
  j.status ? res.json({ url: j.data.authorization_url }) : res.status(502).json({ error: j.message || 'Paystack error' });
});

app.get('/api/verify', async (req, res) => {
  const ref = String(req.query.reference || '');
  if (!ref || usedRefs.has(ref)) return res.status(402).json({ error: 'Invalid or already used payment.' });
  const j = await paystack('transaction/verify/' + encodeURIComponent(ref));
  if (j.status && j.data?.status === 'success' && j.data.amount >= priceFor(j.data) && Date.now() - new Date(j.data.paid_at) < 2 * 36e5) { usedRefs.add(ref); return res.json(makeToken(planOf(j.data))); }
  res.status(402).json({ error: 'Payment not confirmed.' });
});

app.use((req, res) => req.path.startsWith('/api')
  ? res.status(404).json({ error: 'Not found' })
  : res.status(404).type('html').send('<meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Page not found</h2><a href="/">Back to Nimbo</a>'));
app.listen(E.PORT || 3000, () => console.log('Nimbo on ' + BASE));
