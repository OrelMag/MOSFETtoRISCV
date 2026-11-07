// "Pictures"' explorers: a picture as rows of samples, 2-D filters, resizing, the 8 × 8 DCT and its basis, quantization, zig-zag and Huffman, a real JPEG the browser decodes,
// and the 8-point DCT in gates run over a block. Every number is dsp/pictures.ts's; pictures are generated, or the learner's own file, decoded here and never uploaded.

import { signedOf, wordOf } from '../comm/signals';
import { AC_LUMA, basis, blockAt, category, DC_LUMA, DCT_F, DCT_WI, DCT_WO, dct8Fixed, encodeJpeg, extraBits, fdct, filter2d, filterCost, grow, huffCodes, KERNELS, parsePgm, PHOTO, type Picture, pictureOf, psnr, scene, shrink, SIZE, ZIGZAG, zonePlate } from '../dsp/pictures';
import { dctStage } from '../lib/dct';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { line, mkChips, num, plotOf } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/signals.css';
import '../styles/pictures.css';

const n0 = (x: number) => Math.round(x).toLocaleString('en').replace(/,/g, ' ');
const minus = (t: string) => t.replace(/-/g, '−');
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// ---- drawing pictures --------------------------------------------------------------------------------------------------------------------------

/** A canvas holding a picture at one sample a pixel, shown `scale` times larger without smoothing. */
export function canvasOf(p: Picture, scale = 1, label = 'A grey picture'): HTMLCanvasElement {
  const c = h('canvas', { width: p.w, height: p.h, class: 'pic', role: 'img', 'aria-label': label }) as HTMLCanvasElement;
  c.style.width = `${p.w * scale}px`;
  paintPicture(c, p);
  return c;
}
export function paintPicture(c: HTMLCanvasElement, p: Picture): void {
  if (c.width !== p.w || c.height !== p.h) { const s = parseFloat(c.style.width) / c.width || 1; c.width = p.w; c.height = p.h; c.style.width = `${p.w * s}px`; }
  const g = c.getContext('2d');
  if (!g) return;
  const d = g.createImageData(p.w, p.h);
  for (let i = 0; i < p.px.length; i++) { const v = Math.max(0, Math.min(255, Math.round(p.px[i]))); d.data[4 * i] = d.data[4 * i + 1] = d.data[4 * i + 2] = v; d.data[4 * i + 3] = 255; }
  g.putImageData(d, 0, 0);
}
const fig = (c: HTMLElement, cap: string) => h('figure', { class: 'pic-fig' }, c, h('figcaption', null, cap));
const sel = (label: string, opts: string[], pick: number, on: (i: number) => void) => {
  const s = h('select', { 'aria-label': label }, ...opts.map((o, i) => h('option', { value: String(i), selected: i === pick }, o))) as HTMLSelectElement;
  s.addEventListener('change', () => on(Number(s.value)));
  return h('label', { class: 'mos-sl ln-sel' }, h('span', null, label), s);
};

let sceneMemo: Picture | undefined, zoneMemo: Picture | undefined, photoMemo: Promise<Picture> | undefined;
/** The photograph, fetched once, the first time a step asks for it. */
const thePhoto = () => (photoMemo ??= fetch(PHOTO.file).then((r) => { if (!r.ok) throw new Error(`${PHOTO.file}: ${r.status}`); return r.arrayBuffer(); }).then((a) => parsePgm(new Uint8Array(a))).catch((e) => { photoMemo = undefined; throw e; }));
const theScene = () => (sceneMemo ??= scene());
const theZone = () => (zoneMemo ??= zonePlate());

// ---- a picture is samples -----------------------------------------------------------------------------------------------------------------------

export function pictureWidget(): Widget {
  let row = 140;
  const p = theScene(), c = canvasOf(p, 1.5, 'The generated scene, with a marker on the row plotted below'), mark = h('div', { class: 'pic-mark' });
  const plot = plotOf({ W: 640, H: 180, x: [0, p.w], y: [0, 255], yTicks: [0, 128, 255], xLabel: 'sample along the row', yLabel: 'level', aria: 'The levels along one row of the picture' });
  const chips = mkChips(3);
  const paint = () => {
    const xs = range(p.w), ys = xs.map((x) => p.px[row * p.w + x]);
    plot.clear(); line(plot, xs, ys, 'ln-s real');
    mark.style.top = `${(row / p.h) * 100}%`;
    chips.set(0, `${p.w} × ${p.h}`, 'samples, each one level from 0 to 255');
    chips.set(1, `${n0((p.w * p.h * 8) / 8)} bytes`, 'at 8 bits a sample, with nothing taken out');
    chips.set(2, `${Math.min(...ys)} to ${Math.max(...ys)}`, `the levels along row ${row}`);
  };
  const sr = slider('Row', 0, p.h - 1, 1, row, (x) => String(x), (x) => { row = x; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'A picture is rows of samples'), h('div', { class: 'pic-wrap' }, c, mark), plot.el, chips.el), h('div', { class: 'panel mos-ctl' }, sr.el)) };
}

// ---- filters in two dimensions ---------------------------------------------------------------------------------------------------------------------

const KNAMES = Object.keys(KERNELS);
export function filterWidget(): Widget {
  let pick = 1, src = 0;
  const a = canvasOf(theScene(), 1, 'The picture before filtering'), b = canvasOf(theScene(), 1, 'The picture after filtering'), chips = mkChips(3), ktab = h('div', { class: 'pic-kernel' });
  const paint = () => {
    const p = src ? theZone() : theScene(), k = KERNELS[KNAMES[pick]], f = filter2d(p, k.k), show = KNAMES[pick] === 'edges' ? pictureOf(p.w, p.h, (x, y) => 128 + f.px[y * p.w + x] / 2) : f;
    paintPicture(a, p); paintPicture(b, show);
    ktab.replaceChildren(h('table', { class: 'mini' }, ...k.k.map((r) => h('tr', null, ...r.map((v) => h('td', null, minus(num(v, 3))))))));
    chips.set(0, k.note, 'this kernel');
    chips.set(1, `${filterCost(3).full} against ${filterCost(3).separable}`, 'multiplications a sample for 3 × 3, done whole or as a row and a column pass');
    chips.set(2, `${filterCost(15).full} against ${filterCost(15).separable}`, 'the same for 15 × 15, a wide blur');
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'A kernel slid across the picture'), h('div', { class: 'pic-row' }, fig(a, 'In'), fig(b, KNAMES[pick] === 'edges' ? 'Out, drawn as 128 + half the slope' : 'Out'), fig(ktab, 'The kernel')), chips.el),
      h('div', { class: 'panel mos-ctl' }, sel('Kernel', KNAMES, pick, (i) => { pick = i; paint(); }), sel('Picture', ['The scene', 'A zone plate'], src, (i) => { src = i; paint(); }))),
  };
}

// ---- resizing ------------------------------------------------------------------------------------------------------------------------------------------

export function resizeWidget(): Widget {
  let m = 3, how = 0;
  const z = theZone(), a = canvasOf(z, 1, 'The zone plate'), b = canvasOf(z, 1, 'Shrunk by keeping one sample in m, nothing first'), c = canvasOf(z, 1, 'Shrunk after a low-pass'), chips = mkChips(3);
  const paint = () => {
    const raw = shrink(z, m, false), flt = shrink(z, m, true), up = (p: Picture) => grow(p, m, how ? 'bilinear' : 'nearest');
    paintPicture(b, up(raw)); paintPicture(c, up(flt));
    const ref = pictureOf(z.w, z.h, (x, y) => z.px[y * z.w + x]), cut = (p: Picture) => pictureOf(Math.min(p.w, ref.w), Math.min(p.h, ref.h), (x, y) => p.px[y * p.w + x]);
    chips.set(0, `${num(0.5 / m, 3)} cycles a sample`, `the most that is left after keeping 1 in ${m}; the plate reaches 0.5 at its edge`);
    chips.set(1, `${num(psnr(cut(ref), cut(up(raw))), 1)} dB`, 'against the original, nothing before the cut');
    chips.set(2, `${num(psnr(cut(ref), cut(up(flt))), 1)} dB`, 'with the low-pass first: the fine rings are gone, and almost no false ones are made');
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Smaller, then back to size'), h('div', { class: 'pic-row' }, fig(a, 'Zone plate'), fig(b, 'Every m-th sample'), fig(c, 'Low-pass, then every m-th')), chips.el),
      h('div', { class: 'panel mos-ctl' }, slider('Keep 1 in', 2, 4, 1, m, (x) => String(x), (x) => { m = x; paint(); }).el, sel('Grow back by', ['Repeating samples', 'Straight lines (bilinear)'], how, (i) => { how = i; paint(); }))),
  };
}

// ---- the 8 × 8 DCT -------------------------------------------------------------------------------------------------------------------------------------

const BLOCKS = [{ name: 'Sky', bx: 4, by: 3 }, { name: 'The sun\'s edge', bx: 16, by: 3 }, { name: 'Stripes', bx: 2, by: 18 }, { name: 'Rings', bx: 10, by: 19 }, { name: 'Checks', bx: 18, by: 19 }];
function grid(vals: ArrayLike<number>, fmt: (v: number) => string, shade: (v: number) => number): HTMLElement {
  return h('table', { class: 'dct-grid' }, ...range(8).map((v) => h('tr', null, ...range(8).map((u) => { const val = vals[v * 8 + u], td = h('td', null, fmt(val)); td.style.setProperty('--w', `${Math.round(100 * shade(val))}%`); return td; }))));
}
export function dctWidget(): Widget {
  let pick = 1;
  const big = h('canvas', { width: 8, height: 8, class: 'pic', role: 'img', 'aria-label': 'The chosen 8 × 8 block, enlarged' }) as HTMLCanvasElement;
  big.style.width = '128px';
  const coef = h('div'), chips = mkChips(3);
  const bases = h('div', { class: 'dct-bases', role: 'img', 'aria-label': 'The 64 basis patterns: row v, column u, frequency rising down and across' }, ...range(64).map((i) => { const c = canvasOf(pictureOf(8, 8, (x, y) => 128 + 120 * 8 * basis(i >> 3, i & 7)[y * 8 + x] / 2), 3); c.removeAttribute('role'); return c; }));
  const paint = () => {
    const { bx, by } = BLOCKS[pick], blk = blockAt(theScene(), bx, by), S = fdct(blk);
    paintPicture(big, pictureOf(8, 8, (x, y) => blk[y * 8 + x] + 128));
    const top = Math.max(...Array.from(S, Math.abs));
    coef.replaceChildren(grid(S, (v) => minus(String(Math.round(v) || 0)), (v) => Math.abs(v) / top));
    const e = Array.from(S, (v) => v * v).slice(1).sort((a, b) => b - a), all = e.reduce((a, b) => a + b, 0);
    chips.set(0, `${num((100 * (e[0] + e[1] + e[2] + e[3] + e[4])) / Math.max(all, 1e-9), 1)} %`, 'of the energy apart from the mean, in the five largest other coefficients');
    chips.set(1, String(Array.from(S).filter((v) => Math.abs(v) >= 10).length), 'coefficients of 10 or more, of 64');
    chips.set(2, minus(S[0].toFixed(1)), 'S(0, 0): 8 × (the block\'s mean − 128)');
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'A block, and the patterns it is made of'), h('div', { class: 'pic-row' }, fig(big, 'The block'), fig(coef, 'Its coefficients S(v, u)'), fig(bases, 'The 64 patterns, u across, v down')), chips.el),
      h('div', { class: 'panel mos-ctl' }, sel('Block', BLOCKS.map((b) => b.name), pick, (i) => { pick = i; paint(); }))),
  };
}

// ---- quantization ---------------------------------------------------------------------------------------------------------------------------------------

export function qualityWidget(): Widget {
  let q = 30, p = theScene(), src = 0;
  const credit = h('p', { class: 'sub' }), a = canvasOf(p, 1, 'The original'), b = canvasOf(p, 1, 'After quantizing its coefficients'), c = canvasOf(p, 1, 'The error, eight times'), chips = mkChips(4), tab = h('div');
  const paint = () => {
    const r = encodeJpeg(p, q);
    paintPicture(a, p);
    paintPicture(b, r.out);
    credit.textContent = src ? `Photograph: ${PHOTO.credit}.` : 'A generated scene.';
    paintPicture(c, pictureOf(p.w, p.h, (x, y) => 128 + 8 * (r.out.px[y * p.w + x] - p.px[y * p.w + x])));
    tab.replaceChildren(grid(r.table, (v) => String(v), (v) => v / 255));
    chips.set(0, `${num(psnr(p, r.out), 1)} dB`, 'PSNR against the original');
    chips.set(1, `${num((100 * r.zeros) / (p.w * p.h), 1)} %`, 'of the coefficients became 0');
    chips.set(2, `${n0(r.bytes.length)} bytes`, `the whole file, against ${n0(p.w * p.h)} raw`);
    chips.set(3, `${num((p.w * p.h) / r.bytes.length, 1)} : 1`, 'headers included');
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'The one step that loses'), h('div', { class: 'pic-row' }, fig(a, 'Original'), fig(b, 'After quantization'), fig(c, 'Error × 8'), fig(tab, 'The table at this quality')), chips.el, credit),
      h('div', { class: 'panel mos-ctl' }, slider('Quality', 1, 100, 1, q, (x) => String(x), (x) => { q = x; paint(); }).el, sel('Picture', ['The scene', 'A photograph'], src, (i) => {
        src = i;
        if (!i) { p = theScene(); paint(); return; }
        credit.textContent = 'Loading the photograph…';
        thePhoto().then((ph) => { if (src) { p = ph; paint(); } }).catch((e: Error) => { credit.textContent = `The photograph would not load: ${e.message}`; });
      }))),
  };
}

// ---- zig-zag and Huffman ------------------------------------------------------------------------------------------------------------------------------

const DCC = huffCodes(DC_LUMA), ACC = huffCodes(AC_LUMA);
const bin = (c: { code: number; len: number }) => c.code.toString(2).padStart(c.len, '0');
/** One block's symbols as the file sends them, with the bits each costs. */
export function blockSymbols(levels: Int32Array, pred: number): { sym: string; code: string; extra: string; bits: number }[] {
  const out: { sym: string; code: string; extra: string; bits: number }[] = [], diff = levels[0] - pred, s = category(diff), dc = DCC.get(s)!;
  out.push({ sym: `DC diff ${minus(String(diff))}: size ${s}`, code: bin(dc), extra: s ? extraBits(diff, s).toString(2).padStart(s, '0') : '', bits: dc.len + s });
  let run = 0;
  for (let k = 1; k < 64; k++) {
    const v = levels[ZIGZAG[k]];
    if (!v) { run++; continue; }
    while (run > 15) { const z = ACC.get(0xf0)!; out.push({ sym: 'ZRL: 16 zeros', code: bin(z), extra: '', bits: z.len }); run -= 16; }
    const sz = category(v), c = ACC.get((run << 4) | sz)!;
    out.push({ sym: `${run} zeros, then ${minus(String(v))}: ${run}/${sz}`, code: bin(c), extra: extraBits(v, sz).toString(2).padStart(sz, '0'), bits: c.len + sz });
    run = 0;
  }
  if (run) { const e = ACC.get(0)!; out.push({ sym: 'EOB: the rest are 0', code: bin(e), extra: '', bits: e.len }); }
  return out;
}
export function huffWidget(): Widget {
  let pick = 1, q = 50;
  const host = h('div'), chips = mkChips(4), seq = h('div', { class: 'pic-seq' });
  const paint = () => {
    const p = theScene(), r = encodeJpeg(p, q), { bx, by } = BLOCKS[pick], i = by * (p.w / 8) + bx, L = r.levels[i], syms = blockSymbols(L, i ? r.levels[i - 1][0] : 0);
    seq.replaceChildren(...ZIGZAG.map((z, k) => h('span', { class: L[z] ? 'nz' : '', title: `zig-zag ${k}: (v ${z >> 3}, u ${z & 7})` }, minus(String(L[z])))));
    host.replaceChildren(h('table', { class: 'mini' }, h('tr', null, h('th', null, 'Symbol'), h('th', null, 'Code'), h('th', null, 'Extra bits'), h('th', null, 'Bits')), ...syms.map((s) => h('tr', null, h('td', null, s.sym), h('td', null, h('code', null, s.code)), h('td', null, h('code', null, s.extra)), h('td', null, String(s.bits))))));
    const t = r.bits;
    chips.set(0, String(syms.reduce((a, s) => a + s.bits, 0)), 'bits for this block, of 512 raw');
    chips.set(1, `${n0((t.acCodes + t.dcCodes) / 8)} B`, 'Huffman codes, the whole file');
    chips.set(2, `${n0((t.acExtra + t.dcExtra) / 8)} B`, 'extra bits after them');
    chips.set(3, `${n0(t.header / 8)} B`, 'markers and tables');
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Zig-zag, runs and codes'), h('div', { class: 'pic-caption' }, 'The 64 levels in zig-zag order:'), seq, host, chips.el),
      h('div', { class: 'panel mos-ctl' }, sel('Block', BLOCKS.map((b) => b.name), pick, (i) => { pick = i; paint(); }), slider('Quality', 5, 95, 5, q, (x) => String(x), (x) => { q = x; paint(); }).el)),
  };
}

// ---- a real file ---------------------------------------------------------------------------------------------------------------------------------------

/** A dropped or picked file as a grey picture: drawn by the browser into a canvas no larger than `max` a side, then luminance by BT.601's weights. Nothing leaves the page. */
async function pictureFromFile(f: File, max = SIZE): Promise<Picture> {
  const bmp = await createImageBitmap(f), s = Math.min(1, max / Math.max(bmp.width, bmp.height)), w = Math.max(8, Math.round(bmp.width * s)), hh = Math.max(8, Math.round(bmp.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = hh;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0, w, hh);
  const d = g.getImageData(0, 0, w, hh).data;
  return pictureOf(w, hh, (x, y) => { const i = 4 * (y * w + x); return Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); });
}
/** What the browser's own decoder made of our bytes, read back from a canvas. */
async function browserDecode(bytes: Uint8Array, w: number, hh: number): Promise<Picture | null> {
  try {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' })), img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = w; c.height = hh;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const d = g.getImageData(0, 0, w, hh).data;
    return pictureOf(w, hh, (x, y) => d[4 * (y * w + x)]);
  } catch { return null; }
}
export function fileWidget(): Widget {
  let q = 75, own: Picture | null = null, token = 0, photo: Picture | null = null;
  const shown = h('img', { class: 'pic', alt: 'Our JPEG file, decoded by the browser', width: SIZE }) as HTMLImageElement, ours = canvasOf(theScene(), 1, 'Our own reconstruction');
  const chips = mkChips(4), note = h('p', { class: 'sub' }), link = h('a', { class: 'btn sm', download: 'ours.jpg' }, 'Save the file') as HTMLAnchorElement;
  let url = '';
  const paint = async () => {
    const t = ++token, p = own ?? theScene(), r = encodeJpeg(p, q);
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: 'image/jpeg' }));
    shown.src = url; link.href = url; shown.style.width = `${Math.min(SIZE, p.w)}px`;
    paintPicture(ours, r.out);
    chips.set(0, `${n0(r.bytes.length)} bytes`, `${p.w} × ${p.h}, quality ${q}`);
    const d = await browserDecode(r.bytes, p.w, p.h);
    if (t !== token) return;
    if (!d) { chips.set(1, '—', 'the browser did not decode it'); note.textContent = 'This browser would not decode the file, so nothing could be compared.'; return; }
    let worst = 0, off = 0;
    for (let i = 0; i < d.px.length; i++) { const e = Math.abs(d.px[i] - r.out.px[i]); worst = Math.max(worst, e); if (e) off++; }
    chips.set(1, String(worst), 'largest difference, in levels, between the browser\'s decode and ours');
    chips.set(2, `${num((100 * off) / d.px.length, 1)} %`, 'of pixels differ at all');
    chips.set(3, `${num(psnr(p, r.out), 1)} dB`, 'PSNR against the picture that went in');
    note.textContent = own === photo ? `Photograph: ${PHOTO.credit}.` : own ? 'Your picture was decoded and turned grey here. Nothing was sent anywhere.' : 'The browser decoded these bytes with its own decoder. A decoder may do its inverse transform its own way, so a level or so either way is allowed.';
  };
  const file = h('input', { type: 'file', accept: 'image/*', 'aria-label': 'Use a picture of your own' }) as HTMLInputElement;
  file.addEventListener('change', async () => { const f = file.files?.[0]; if (!f) return; try { own = await pictureFromFile(f); void paint(); } catch { note.textContent = 'That file could not be read as a picture.'; } });
  void paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'A file another program can open'), h('div', { class: 'pic-row' }, fig(shown, 'The browser\'s decode of our file'), fig(ours, 'Our reconstruction')), chips.el, note),
      h('div', { class: 'panel mos-ctl' }, slider('Quality', 5, 95, 5, q, (x) => String(x), (x) => { q = x; void paint(); }).el, h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Your picture'), file), h('div', { class: 'dram-ops' }, link, h('button', { type: 'button', class: 'btn sm', onclick: () => { thePhoto().then((ph) => { photo = ph; own = ph; file.value = ''; void paint(); }).catch((e: Error) => { note.textContent = `The photograph would not load: ${e.message}`; }); } }, 'Use the photograph'), h('button', { type: 'button', class: 'btn sm', onclick: () => { own = null; file.value = ''; void paint(); } }, 'Back to the scene')))),
  };
}

// ---- in gates ------------------------------------------------------------------------------------------------------------------------------------------

export const dctApi = new WeakMap<Stage, { agrees: () => boolean; passes: () => number; run: () => void }>();
const dctPanel: ScenePanel = (stage: Stage): Widget => {
  let ok = true, passes = 0, out: number[] = [];
  const BLOCK = BLOCKS[1], blk = blockAt(theScene(), BLOCK.bx, BLOCK.by);
  const coef = h('div'), read = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub' });
  const paint = () => {
    const S = fdct(blk), scale = 2 ** (2 * DCT_F);
    coef.replaceChildren(out.length ? grid(out.map((v) => v / scale), (v) => minus(v.toFixed(1)), (v) => Math.min(1, Math.abs(v) / 200)) : h('span'));
    const worst = out.length ? Math.max(...out.map((v, i) => Math.abs(v / scale - S[i]))) : 0;
    read.replaceChildren(h('span', null, 'passes ', h('b', null, `${passes} of 16`)), h('span', null, 'off the true DCT ', h('b', null, out.length ? `≤ ${worst.toFixed(2)}` : '—')));
    note.textContent = passes ? (ok ? 'Each pass, the gates gave exactly what the integer model gives. The panel moves rows to columns between the passes; that buffer is not in these gates.' : 'The gates and the model disagreed.') : `A block from the sun's edge goes through the stage eight times along its rows, then eight times down the columns.`;
  };
  const pass = (x: number[]): number[] => {
    const sim = stage.sim!;
    x.forEach((v, i) => sim.setInput(`x${i}`, wordOf(v, DCT_WI)));
    sim.settle();
    const got = range(8).map((i) => signedOf(stage.value(`y${i}`), DCT_WO));
    if (got.join() !== dct8Fixed(x).join()) ok = false;
    passes++;
    return got;
  };
  const run = () => {
    stage.checkpoint();
    ok = true; passes = 0;
    const rows: number[] = [];
    for (let y = 0; y < 8; y++) rows.push(...pass(range(8).map((x) => blk[y * 8 + x])));
    out = new Array<number>(64);
    for (let u = 0; u < 8; u++) { const c = pass(range(8).map((y) => rows[y * 8 + u])); for (let v = 0; v < 8; v++) out[v * 8 + u] = c[v]; }
    stage.refresh();
    paint();
  };
  dctApi.set(stage, { agrees: () => ok && passes === 16, passes: () => passes, run });
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'A block through one stage'),
    h('div', { class: 'dram-ops' }, h('button', { type: 'button', class: 'btn sm', onclick: run }, 'Run a block')), coef, read, note);
  stage.resetHooks.add(() => { out = []; passes = 0; paint(); });
  paint();
  return { el, update: () => {} };
};
export function dctScene(): Scene {
  return { root: dctStage(), inputs: Object.fromEntries(range(8).map((i) => [`x${i}`, 0])), powerOn: 'zero', engine: 'cycle', panels: [dctPanel] };
}

/** The blocks the widgets pick from, for the prose. */
export const PICTURE_BLOCKS = BLOCKS;
