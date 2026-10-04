const $ = s => document.querySelector(s);
const L = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } };
const S = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const FREE_SAVES = 10;
let dev = false, price = 1500, priceUsd = 2, priceDay = 300, priceDayUsd = 1, usdOn = false, wa = '';
let doc = L('doc', { id: null, pages: [] });
let notices = L('notices', []), token = L('token', null), file = null, stream = null;
let device = L('device', null) || (() => { const d = crypto.randomUUID(); S('device', d); return d })();
const isPro = () => token && token.exp > Date.now();
const status = m => $('#status').textContent = m || '';

// ---------- Plan / payments ----------
function renderPlan() { $('#alt').classList.toggle('hide', !!isPro()); $('#plan').textContent = isPro() ? (dev ? 'PRO (test) ✓' : 'PRO ✓') : (dev ? 'Free (test)' : 'Free · Go Pro'); $('#plan').classList.toggle('pro', isPro()) }
// Nigerians (Lagos time zone) pay in naira; everyone else pays in dollars once USD is enabled on the server.
function cur() { return usdOn && Intl.DateTimeFormat().resolvedOptions().timeZone !== 'Africa/Lagos' ? 'USD' : 'NGN' }
function priceTxt(p = 'month') { const u = cur() === 'USD'; return u ? '$' + (p === 'day' ? priceDayUsd : priceUsd) : '₦' + (p === 'day' ? priceDay : price).toLocaleString() }
async function upgrade(plan = 'month') {
  const email = prompt('Enter your email to pay (your receipt goes here):'); if (!email) return;
  try {
    window.track?.('begin_checkout');
    const j = await (await fetch('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, currency: cur(), plan }) })).json();
    j.url ? location.href = j.url : alert(j.error);
  } catch { alert('Server not reachable.') }
}
function needPro(what) {
  if (isPro()) return true;
  $('#planWhat').textContent = what + ' is a Pro feature';
  $('#pDay').textContent = '24-hour pass · ' + priceTxt('day'); $('#pMonth').textContent = '30 days · ' + priceTxt('month');
  $('#planSheet').classList.remove('hide'); return false;
}
$('#plan').onclick = async () => {
  if (dev) { // test mode: tap the badge to switch between Free and Pro
    if (isPro()) { token = null; localStorage.removeItem('token'); S('devFree', true) }
    else { token = await (await fetch('/api/dev-pro', { method: 'POST' })).json(); S('token', token); S('devFree', false) }
    return renderPlan();
  }
  if (!isPro()) needPro('Pro');
};
(async () => {
  const sid = new URLSearchParams(location.search).get('reference');
  if (sid) { const r = await fetch('/api/verify?reference=' + encodeURIComponent(sid)); if (r.ok) { token = await r.json(); S('token', token); window.track?.('purchase') } history.replaceState({}, '', '/') }
  try { const cf = await (await fetch('/api/config')).json(); dev = cf.dev; price = cf.price; priceUsd = cf.priceUsd; usdOn = cf.usdOn; priceDay = cf.priceDay; priceDayUsd = cf.priceDayUsd; wa = cf.wa } catch {}
  if (dev && !isPro() && !L('devFree', false)) { try { token = await (await fetch('/api/dev-pro', { method: 'POST' })).json(); S('token', token) } catch {} }
  renderPlan();
})();

// ---------- Step 1: image (camera / upload) ----------
function setImage(f) {
  file = f;
  $('#preview').src = URL.createObjectURL(f);
  $('#preview').classList.remove('hide'); $('#dropHint').classList.add('hide');
  $('#rmImg').classList.remove('hide'); $('#extract').disabled = false;
  $('#result').classList.add('hide'); status('Image ready. Tap "Extract text".');
}
function clearImage() {
  file = null; $('#preview').removeAttribute('src');
  $('#preview').classList.add('hide'); $('#dropHint').classList.remove('hide');
  $('#rmImg').classList.add('hide'); $('#extract').disabled = true; status('');
  $('#up').value = ''; $('#camFallback').value = '';
}
$('#up').onchange = e => e.target.files[0] && setImage(e.target.files[0]);
$('#camFallback').onchange = e => e.target.files[0] && setImage(e.target.files[0]);
$('#rmImg').onclick = clearImage;

async function openCam() {
  // Live camera needs HTTPS or localhost; otherwise fall back to the phone's camera app.
  if (!navigator.mediaDevices?.getUserMedia) return $('#camFallback').click();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    $('#video').srcObject = stream; $('#camModal').classList.remove('hide');
  } catch { $('#camFallback').click() }
}
function closeCam() { stream?.getTracks().forEach(t => t.stop()); stream = null; $('#camModal').classList.add('hide') }
$('#camBtn').onclick = openCam; $('#camCancel').onclick = closeCam;
$('#shot').onclick = () => {
  const v = $('#video'), c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
  c.toBlob(b => { setImage(new File([b], 'snap.jpg', { type: 'image/jpeg' })); closeCam() }, 'image/jpeg', .92);
};

// ---------- Step 2: extract ----------
const loadImg = f => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = URL.createObjectURL(f) });
async function toJpeg(f, max = 1600) {  // resized copy for AI (smaller upload)
  const i = await loadImg(f), s = Math.min(1, max / Math.max(i.width, i.height)), c = document.createElement('canvas');
  c.width = i.width * s; c.height = i.height * s; c.getContext('2d').drawImage(i, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', .85).split(',')[1];
}
async function prep(f) {  // grayscale + contrast + upscale small images: helps Tesseract
  const i = await loadImg(f), m = Math.max(i.width, i.height), s = m > 1800 ? 1800 / m : (i.width < 1000 ? 1200 / i.width : 1), c = document.createElement('canvas');
  c.width = i.width * s; c.height = i.height * s;
  const x = c.getContext('2d'); x.filter = 'grayscale(1) contrast(1.35)'; x.drawImage(i, 0, 0, c.width, c.height);
  return c;
}
async function accurateOcr() {
  const r = await fetch('/api/ocr', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pro-token': token?.t || '' }, body: JSON.stringify({ image: await toJpeg(file), device }) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
}
$('#extract').onclick = async () => {
  if (!file) return; window.track?.('extract');
  $('#extract').disabled = true; $('#extract').classList.add('working'); $('#extract').textContent = 'Reading…'; $('#ai').classList.add('hide'); $('#bar').classList.remove('hide'); $('#fill').style.width = '0';
  let text = null, note = '';
  if ($('#acc').checked) {
    status('Reading with AI…'); $('#fill').style.width = '60%';
    try { const j = await accurateOcr(); text = j.result; note = j.left != null ? ` (${j.left} free Accurate scans left today)` : ''; }
    catch (e) { status((e.message || 'AI unavailable') + ' Using standard mode…'); }
  }
  if (text === null) {
    try {
      const { data } = await Tesseract.recognize(await prep(file), $('#ocrLang').value, {
        logger: m => { if (m.status === 'recognizing text') { $('#fill').style.width = Math.round(m.progress * 100) + '%'; status('Reading text… ' + Math.round(m.progress * 100) + '%') } else status('Loading engine…') }
      });
      text = data.text.trim();
    } catch { status('Could not read the image. Try a clearer photo.') }
  }
  if (text !== null) {
    $('#text').value = text || 'No text found.'; $('#result').classList.remove('hide');
    status('Done. You can edit the text below.' + note); $('#result').scrollIntoView({ behavior: 'smooth' });
  }
  $('#extract').disabled = false; $('#extract').classList.remove('working'); $('#extract').textContent = 'Extract text'; setTimeout(() => $('#bar').classList.add('hide'), 600);
};

// ---------- Step 3: use the text ----------
$('#copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('#text').value) } catch { $('#text').select(); document.execCommand('copy') }
  status('Copied ✔');
};
$('#share').onclick = async () => {
  const t = $('#text').value;
  if (navigator.share) { try { await navigator.share({ text: t }) } catch {} } else window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank');
};
async function ai(task) {
  const text = $('#text').value.trim(); if (!text) return;
  const box = $('#ai'); box.classList.remove('hide'); box.textContent = 'Thinking…';
  try {
    const r = await fetch('/api/ai', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pro-token': token?.t || '' }, body: JSON.stringify({ task, text, lang: $('#trLang').value, device }) });
    const j = await r.json();
    box.textContent = r.ok ? j.result + (j.left != null ? `\n\n(${j.left} free explains left today)` : '') : j.error;
  } catch { box.textContent = 'Network error. Is the server running?' }
}
$('#explain').onclick = () => ai('explain');
$('#translate').onclick = () => needPro('Translation') && ai('translate');
$('#listen').onclick = () => {
  if (!needPro('Voice reading')) return;
  speechSynthesis.cancel();
  const a = $('#ai'), t = !a.classList.contains('hide') && !a.textContent.startsWith('Thinking') ? a.textContent : $('#text').value;
  speechSynthesis.speak(new SpeechSynthesisUtterance(t));
};
// Exports are built on the server (Pro only), so the paywall cannot be skipped from the browser.
async function exportDoc(format, pages) {
  if (!needPro('Export')) return;
  status('Preparing file…');
  try {
    const r = await fetch('/api/export', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pro-token': token?.t || '' }, body: JSON.stringify({ format, pages }) });
    if (!r.ok) return status((await r.json()).error);
    const b = await r.blob();
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(b), download: 'nimbo.' + (format === 'word' ? 'doc' : 'pdf') }).click();
    status('Downloaded ✔');
  } catch { status('Could not export. Try again.') }
}
$('#pdf').onclick = () => exportDoc('pdf', [$('#text').value]);
$('#doc').onclick = () => exportDoc('word', [$('#text').value]);
$('#pDay').onclick = () => { $('#planSheet').classList.add('hide'); upgrade('day') };
$('#pMonth').onclick = () => { $('#planSheet').classList.add('hide'); upgrade('month') };
$('#pCancel').onclick = () => $('#planSheet').classList.add('hide');

// ---------- Multi-page document ----------
function renderDoc() {
  $('#docCard').classList.toggle('hide', !doc.pages.length);
  $('#pgCount').textContent = doc.pages.length + (doc.pages.length === 1 ? ' page' : ' pages');
  const list = $('#pgList'); list.innerHTML = '';
  doc.pages.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'item';
    const t = document.createElement('div'); t.className = 't'; t.innerHTML = '<small></small><span></span>';
    t.children[0].textContent = 'Page ' + (i + 1); t.children[1].textContent = p.replace(/\s+/g, ' ').slice(0, 70);
    const x = Object.assign(document.createElement('button'), { textContent: 'Remove', className: 'btn danger' });
    x.onclick = () => { doc.pages.splice(i, 1); S('doc', doc); renderDoc() };
    d.append(t, x); list.append(d);
  });
}
$('#addPage').onclick = async () => {
  const text = $('#text').value.trim(); if (!text) return;
  if (!doc.id) doc.id = crypto.randomUUID();
  try {
    const r = await fetch('/api/page', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pro-token': token?.t || '' }, body: JSON.stringify({ docId: doc.id, device }) });
    const j = await r.json();
    if (!r.ok) { status(j.error); needPro('More pages'); return }
    doc.pages.push(text); S('doc', doc); renderDoc();
    status('Page ' + doc.pages.length + ' added ✔  Now snap the next page.');
    clearImage(); $('#text').value = ''; $('#result').classList.add('hide'); scrollTo(0, 0);
  } catch { status('Server not reachable.') }
};
$('#dCopy').onclick = async () => {
  const t = doc.pages.join('\n\n');
  try { await navigator.clipboard.writeText(t) } catch { const x = Object.assign(document.createElement('textarea'), { value: t }); document.body.append(x); x.select(); document.execCommand('copy'); x.remove() }
  status('All pages copied ✔');
};
$('#dPdf').onclick = () => doc.pages.length && exportDoc('pdf', doc.pages);
$('#dWord').onclick = () => doc.pages.length && exportDoc('word', doc.pages);
$('#dNew').onclick = () => { if (confirm('Start a new document? Unsaved pages will be cleared.')) { doc = { id: null, pages: [] }; S('doc', doc); renderDoc() } };
$('#dSave').onclick = () => {
  if (!doc.pages.length) return;
  if (!isPro() && notices.some(n => n.pages)) return needPro('Saving more than 1 document');
  const folder = isPro() ? (prompt('Folder name (e.g. Novel):', 'General') || 'General') : 'General';
  notices.unshift({ id: Date.now(), text: doc.pages.join('\n\n'), pages: doc.pages.slice(), folder, date: new Date().toLocaleDateString() });
  S('notices', notices); status('Document saved ✔');
};

$('#delScan').onclick = () => {
  if (!confirm('Delete this scan and its text?')) return;
  $('#text').value = ''; $('#ai').classList.add('hide'); $('#result').classList.add('hide'); speechSynthesis.cancel(); clearImage();
};

// ---------- Saved notices ----------
$('#save').onclick = () => {
  const text = $('#text').value.trim(); if (!text) return;
  if (!isPro() && notices.length >= FREE_SAVES) return needPro(`Saving more than ${FREE_SAVES} notices`);
  const folder = isPro() ? (prompt('Folder name (e.g. School, Church):', 'General') || 'General') : 'General';
  notices.unshift({ id: Date.now(), text, folder, date: new Date().toLocaleDateString() });
  S('notices', notices); status('Saved ✔');
};
function renderSaved() {
  const cur = $('#folderFilter').value || 'All', folders = ['All', ...new Set(notices.map(n => n.folder))];
  $('#folderFilter').innerHTML = folders.map(f => `<option${f === cur ? ' selected' : ''}>${f}</option>`).join('');
  const shown = notices.filter(n => cur === 'All' || n.folder === cur), list = $('#list');
  list.innerHTML = shown.length ? '' : '<p style="color:var(--mu)">No saved notices yet.</p>';
  shown.forEach(n => {
    const d = document.createElement('div'); d.className = 'item';
    const t = document.createElement('div'); t.className = 't'; t.innerHTML = '<small></small><span></span>';
    t.children[0].textContent = (n.pages ? n.pages.length + ' pages · ' : '') + n.folder + ' · ' + n.date; t.children[1].textContent = n.text.replace(/\s+/g, ' ').slice(0, 70);
    const o = Object.assign(document.createElement('button'), { textContent: 'Open', className: 'btn ghost' });
    const x = Object.assign(document.createElement('button'), { textContent: 'Delete', className: 'btn danger' });
    o.onclick = () => { show('scan'); if (n.pages) { doc = { id: null, pages: n.pages.slice() }; S('doc', doc); renderDoc() } else { $('#text').value = n.text; $('#result').classList.remove('hide') } scrollTo(0, 0) };
    x.onclick = () => { if (confirm('Delete this saved notice?')) { notices = notices.filter(m => m.id !== n.id); S('notices', notices); renderSaved() } };
    d.append(t, o, x); list.append(d);
  });
}
$('#folderFilter').onchange = renderSaved;
function show(w) {
  $('#scan').classList.toggle('hide', w !== 'scan'); $('#saved').classList.toggle('hide', w !== 'saved');
  $('#tScan').classList.toggle('on', w === 'scan'); $('#tSaved').classList.toggle('on', w === 'saved');
  if (w === 'saved') renderSaved();
}
$('#tScan').onclick = () => show('scan'); $('#tSaved').onclick = () => show('saved');
$('#wa').onclick = e => {
  e.preventDefault();
  if (!wa) return alert('WhatsApp payment is not set up yet.');
  open('https://wa.me/' + wa + '?text=' + encodeURIComponent('Hi, I want to pay for Nimbo Pro. My card did not work.'), '_blank');
};
$('#code').onclick = async e => {
  e.preventDefault();
  const code = prompt('Enter your access code:'); if (!code) return;
  try {
    const r = await fetch('/api/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const j = await r.json(); if (!r.ok) return alert(j.error);
    token = j; S('token', token); renderPlan(); window.track?.('purchase', { method: 'code' }); alert('Pro unlocked for 30 days ✔');
  } catch { alert('Server not reachable.') }
};
$('#reset').onclick = e => {
  e.preventDefault();
  if (!confirm('Switch this device back to Free? You will lose Pro here unless you have an access code or pay again.')) return;
  token = null; localStorage.removeItem('token'); if (dev) S('devFree', true); renderPlan();
};
let installEvt = null;   // "Install app" link appears when the browser allows installing
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#inst').classList.remove('hide'); $('#instDot').classList.remove('hide') });
$('#inst').onclick = async e => { e.preventDefault(); if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#inst').classList.add('hide'); $('#instDot').classList.add('hide'); window.track?.('install') };
renderDoc();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
