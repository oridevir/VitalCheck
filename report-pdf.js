// A copy of this file runs in the Supabase Edge Function vitalcheck-monthly-report (pdf.js there).
// Keep both in sync when changing the report layout.
// Builds the full VitalCheck report as a PDF (A4), similar to the app's print report.
// pdf-lib has no right-to-left support, so each line is reordered for display
// here (visualOrder): Hebrew runs are reversed, numbers/Latin stay left-to-right.

const HEB = /[֐-׿]/;
const LTR = /[A-Za-z0-9]/;
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '<': '>', '>': '<' };

// Reorder one line of mixed Hebrew / numbers / Latin for left-to-right drawing.
export function visualOrder(text) {
  const chars = [...String(text)];
  // 1 = RTL (Hebrew), 0 = LTR (Latin/digits), null = neutral
  const dir = chars.map(c => (HEB.test(c) ? 1 : LTR.test(c) ? 0 : null));
  // Neutrals between two LTR characters (e.g. "3.11.2026 14:30", "Steri-strip") stay LTR;
  // every other neutral follows the paragraph direction (RTL).
  for (let i = 0; i < chars.length; i++) {
    if (dir[i] !== null) continue;
    let j = i;
    while (j < chars.length && dir[j] === null) j++;
    const before = i > 0 ? dir[i - 1] : 1;
    const after = j < chars.length ? dir[j] : 1;
    // A percent sign right after a number belongs to it ("2%")
    const pct = before === 0 && chars.slice(i, j).every(c => c === '%');
    const d = (before === 0 && after === 0) || pct ? 0 : 1;
    for (let k = i; k < j; k++) dir[k] = d;
  }
  const runs = [];
  for (let i = 0; i < chars.length; i++) {
    if (runs.length && runs[runs.length - 1].d === dir[i]) runs[runs.length - 1].s.push(chars[i]);
    else runs.push({ d: dir[i], s: [chars[i]] });
  }
  return runs.reverse().map(r => (r.d === 1 ? r.s.reverse().map(c => MIRROR[c] || c).join('') : r.s.join(''))).join('');
}

// pdf-lib's font engine (fontkit) reverses every string that contains Hebrew, as a whole
// and without mirroring brackets. Pre-reverse such strings so the visual order survives.
const forDraw = text => {
  const v = visualOrder(text);
  return HEB.test(v) ? [...v].reverse().join('') : v;
};

const MONTHS_SHORT = e => { const [y, m] = e.split('-'); return `${m}.${y.slice(2)}`; };

export async function buildReportPdf({ PDFDocument, rgb, fontkit, regularBytes, boldBytes, title, items, now, generatedAt, brand = 'VitalCheck' }) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(regularBytes, { subset: true });
  const bold = await doc.embedFont(boldBytes, { subset: true });
  doc.setTitle(`VitalCheck - ${title}`);

  const W = 595.28, H = 841.89, M = 36;
  const C = {
    ink: rgb(0.07, 0.07, 0.07), muted: rgb(0.35, 0.35, 0.35), line: rgb(0.85, 0.85, 0.85),
    navy: rgb(0.06, 0.13, 0.27), head: rgb(0.9, 0.91, 0.94),
  };
  const GROUPS = [
    ['danger', 'פג תוקף / פג החודש — לטיפול מיידי', rgb(0.84, 0.27, 0.21), rgb(0.98, 0.88, 0.86), rgb(0.42, 0.11, 0.07)],
    ['warn', 'פג בחודש הבא', rgb(0.91, 0.54, 0.1), rgb(0.99, 0.91, 0.83), rgb(0.42, 0.23, 0.05)],
    ['ok', 'פג בעוד חודשיים', rgb(0.88, 0.71, 0), rgb(0.98, 0.95, 0.8), rgb(0.36, 0.29, 0)],
    ['good', 'תקף (3 חודשים ומעלה)', rgb(0.15, 0.68, 0.38), rgb(0.87, 0.95, 0.91), rgb(0.11, 0.29, 0.22)],
    ['none', 'ללא תוקף', rgb(0.67, 0.67, 0.67), rgb(0.93, 0.93, 0.93), rgb(0.27, 0.27, 0.27)],
  ];

  const monthsUntil = e => { const [y, m] = e.split('-').map(Number); return (y - now.y) * 12 + (m - now.m); };
  const status = it => {
    if (!it.expiry) return 'none';
    const d = monthsUntil(it.expiry);
    return d < 1 ? 'danger' : d < 2 ? 'warn' : d < 3 ? 'ok' : 'good';
  };
  const label = it => {
    if (!it.expiry) return 'ללא תוקף';
    const d = monthsUntil(it.expiry);
    if (d === -1) return 'פג לפני חודש';
    if (d < 0) return `פג לפני ${-d} חודשים`;
    if (d === 0) return 'פג החודש';
    if (d === 1) return 'נותר חודש';
    return `נותרו ${d} חודשים`;
  };

  // Right-aligned text, x = right edge
  const textR = (page, s, xRight, y, size, f = font, color = C.ink, maxW = null) => {
    let v = forDraw(s);
    if (maxW) {
      // shorten from the end of the (logical) text until it fits
      let logical = String(s);
      while (f.widthOfTextAtSize(v, size) > maxW && logical.length > 1) {
        logical = logical.slice(0, -1);
        v = forDraw(logical + '…');
      }
    }
    page.drawText(v, { x: xRight - f.widthOfTextAtSize(v, size), y, size, font: f, color });
  };
  const textC = (page, s, xCenter, y, size, f = font, color = C.ink) => {
    const v = forDraw(s);
    page.drawText(v, { x: xCenter - f.widthOfTextAtSize(v, size) / 2, y, size, font: f, color });
  };

  // Columns, right to left: # | name | qty | expiry | status | category
  const R = W - M;
  const cols = { num: [R, 24], name: [R - 24, 205], qty: [R - 229, 42], exp: [R - 271, 52], st: [R - 323, 110], cat: [R - 433, 90] };
  const ROW = 19, FS = 10;

  let page, y;
  const newPage = first => {
    page = doc.addPage([W, H]);
    y = H - M;
    if (first) {
      textR(page, `${title} — דוח תקפים`, R, y - 16, 17, bold, C.navy);
      page.drawText(brand, { x: M, y: y - 14, size: 10, font, color: C.muted });
      y -= 24;
      page.drawLine({ start: { x: M, y }, end: { x: R, y }, thickness: 1.5, color: C.navy });
      y -= 16;
      textR(page, `הופק: ${generatedAt}  ·  פריטים בדוח: ${items.length}`, R, y, 10, font, C.muted);
      y -= 20;
      const counts = Object.fromEntries(GROUPS.map(g => [g[0], 0]));
      items.forEach(it => counts[status(it)]++);
      const parts = [['פג תוקף / פג החודש', counts.danger, true], ['פג בחודש הבא', counts.warn, true],
        ['פג בעוד חודשיים', counts.ok], ['תקף', counts.good], ['ללא תוקף', counts.none]];
      let x = R;
      for (const [name, n, hot] of parts) {
        const s = `${name}: ${n}`;
        const f = hot && n ? bold : font;
        const w = f.widthOfTextAtSize(forDraw(s), 9.5) + 12;
        page.drawRectangle({ x: x - w, y: y - 5, width: w, height: 17, borderColor: hot && n ? C.ink : C.line, borderWidth: hot && n ? 1.4 : 0.8 });
        textR(page, s, x - 6, y, 9.5, f);
        x -= w + 6;
      }
      y -= 26;
    }
    // table header
    page.drawRectangle({ x: M, y: y - 6, width: R - M, height: ROW, color: C.head });
    const hy = y;
    textC(page, '#', cols.num[0] - cols.num[1] / 2, hy, FS, bold);
    textR(page, 'שם הפריט', cols.name[0] - 4, hy, FS, bold);
    textC(page, 'כמות', cols.qty[0] - cols.qty[1] / 2, hy, FS, bold);
    textR(page, 'תוקף', cols.exp[0] - 4, hy, FS, bold);
    textR(page, 'מצב', cols.st[0] - 4, hy, FS, bold);
    textR(page, 'קטגוריה', cols.cat[0] - 4, hy, FS, bold);
    y -= ROW + 2;
  };
  const ensure = need => { if (y - need < M + 20) newPage(false); };

  newPage(true);
  let n = 0;
  let firstGroup = true;
  for (const [key, gTitle, color, bg, ink] of GROUPS) {
    const list = items.filter(it => status(it) === key)
      .sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999') || a.name.localeCompare(b.name, 'he'));
    if (!list.length) continue;
    if (!firstGroup) y -= 10;
    firstGroup = false;
    ensure(ROW * 3);
    page.drawRectangle({ x: M, y: y - 6, width: R - M, height: ROW + 2, color: bg });
    page.drawRectangle({ x: R - 5, y: y - 6, width: 5, height: ROW + 2, color });
    textR(page, `${gTitle} (${list.length} פריטים)`, R - 12, y, 11, bold, ink);
    y -= ROW + 4;
    for (const it of list) {
      ensure(ROW);
      const urgent = key === 'danger' || key === 'warn';
      textC(page, String(++n), cols.num[0] - cols.num[1] / 2, y, FS, font, C.muted);
      textR(page, it.name, cols.name[0] - 4, y, FS, font, C.ink, cols.name[1] - 8);
      textC(page, it.quantity == null ? '' : String(it.quantity), cols.qty[0] - cols.qty[1] / 2, y, FS);
      textR(page, it.expiry ? MONTHS_SHORT(it.expiry) : '—', cols.exp[0] - 4, y, FS);
      textR(page, label(it), cols.st[0] - 4, y, FS, urgent ? bold : font, key === 'none' ? C.muted : C.ink);
      textR(page, it.category, cols.cat[0] - 4, y, FS, font, C.ink, cols.cat[1] - 8);
      page.drawLine({ start: { x: M, y: y - 6 }, end: { x: R, y: y - 6 }, thickness: 0.5, color: C.line });
      y -= ROW;
    }
  }

  // page numbers + footer
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    textC(p, `עמוד ${i + 1} מתוך ${pages.length}  ·  הופק באמצעות VitalCheck  ·  פותח ע״י ד״ר אורי דביר`, W / 2, 20, 8, font, C.muted);
  });
  return await doc.save();
}
