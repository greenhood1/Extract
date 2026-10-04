// Tiny dependency-free PDF writer: plain text, Helvetica, A4. Each input page starts on a new PDF page.
module.exports = function makePdf(pages) {
  const MAXC = 92, LINES = 52;
  const fix = s => String(s).replace(/\r/g, '').replace(/\t/g, '  ')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...')
    .replace(/[^\n\x20-\x7E\xA0-\xFF]/g, '?');
  const wrap = t => fix(t).split('\n').flatMap(l => {
    const out = [];
    while (l.length > MAXC) { let i = l.lastIndexOf(' ', MAXC); if (i < 1) i = MAXC; out.push(l.slice(0, i)); l = l.slice(i).trimStart(); }
    out.push(l); return out;
  });
  const esc = s => Buffer.from(s.replace(/[\\()]/g, '\\$&'), 'latin1');
  const pg = [];
  pages.forEach(p => { const w = wrap(p); for (let i = 0; i < Math.max(w.length, 1); i += LINES) pg.push(w.slice(i, i + LINES)); });
  if (!pg.length) pg.push([]);
  const parts = [], offs = []; let len = 0;
  const add = b => { b = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); parts.push(b); len += b.length; };
  const obj = (n, body) => { offs[n] = len; add(n + ' 0 obj\n'); add(body); add('\nendobj\n'); };
  const n = pg.length;
  add('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pg.map((_, i) => (4 + i * 2) + ' 0 R').join(' ')}] >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  pg.forEach((ls, i) => {
    const body = Buffer.concat([Buffer.from('BT /F1 11 Tf 50 792 Td 14 TL\n'), ...ls.map(l => Buffer.concat([Buffer.from('('), esc(l), Buffer.from(') Tj T*\n')])), Buffer.from('ET')]);
    obj(4 + i * 2, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    obj(5 + i * 2, Buffer.concat([Buffer.from(`<< /Length ${body.length} >>\nstream\n`), body, Buffer.from('\nendstream')]));
  });
  const total = 4 + n * 2, xref = len;
  add(`xref\n0 ${total}\n0000000000 65535 f \n` + offs.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
  add(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return Buffer.concat(parts);
};
