// Pictures (DOM-free): grey pictures as rows of samples, 2-D filtering and resizing, the 8 × 8 DCT, JPEG's quantization, zig-zag and Huffman coding, and a baseline JPEG file
// written byte by byte. Tables are T.81's Annex K (K.1, K.3, K.5); the quality scaling is libjpeg's, as Pillow writes it (scripts/dsp/oracle.py). The fixed-point 1-D DCT here
// is the golden model of lib/dct.ts, compared every vector.

import { windowedSinc } from '../comm/signals';
import { gaussian, rng } from '../phys/line';

/** A grey picture: w × h samples, 0 … 255, row after row. */
export interface Picture { w: number; h: number; px: Float64Array }

const clamp255 = (v: number) => Math.max(0, Math.min(255, v));
export const pictureOf = (w: number, h: number, f: (x: number, y: number) => number): Picture => {
  const px = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = f(x, y);
  return { w, h, px };
};
/** Rounded to whole levels, as a file or a screen holds them. */
export const rounded = (p: Picture): Picture => ({ ...p, px: p.px.map((v) => clamp255(Math.round(v))) });

// ---- generated pictures -------------------------------------------------------------------------------------------------------------------

export const SIZE = 192;
/** A landscape with the things a codec finds hard: a smooth sky, a sharp sun, a mountain's edge, fine stripes and rings, and a little noise. Generated, so it is the same everywhere. */
export function scene(n = SIZE): Picture {
  const u = rng(7), s = n / 192;
  return rounded(pictureOf(n, n, (x0, y0) => {
    const x = x0 / s, y = y0 / s;
    let v: number;
    if (y < 120) {
      v = 44 + (172 * y) / 120;
      if (Math.hypot(x - 142, y - 48) < 24) v = 244;
      if (y > 54 + (Math.abs(x - 52) * 66) / 52 && x < 104) v = 92;
    } else {
      v = 133;
      if (x >= 8 && x < 44 && y >= 128 && y < 182) v = Math.floor((x - 8) / 3) % 2 ? 32 : 232;
      const r = Math.hypot(x - 90, y - 156);
      if (r >= 3 && r < 28 && Math.abs(r % 3 - 1.5) < 0.6) v = 17;
      if (x >= 124 && x < 180 && y >= 136 && y < 176) v = 133 + 100 * Math.sign(Math.sin(x / 2.2) * Math.sin(y / 2.2));
    }
    return clamp255(v + 3 * gaussian(u));
  }));
}

/** A zone plate: rings whose frequency rises with distance from the centre, to 0.5 cycles a sample at the edge. Any resizing that aliases shows false rings. */
export function zonePlate(n = SIZE): Picture {
  const k = Math.PI / (2 * (n / 2));
  return rounded(pictureOf(n, n, (x, y) => { const dx = x - n / 2, dy = y - n / 2; return 128 + 110 * Math.cos(k * (dx * dx + dy * dy)); }));
}

/** One photograph, public domain: NASA's AS11-40-5903, Buzz Aldrin on the Moon (Apollo 11, 1969, photographed by Neil Armstrong), grey and 192 × 192 (docs/DSP-SOURCES.md). */
export const PHOTO = { file: 'dsp/aldrin-192.pgm', credit: 'Buzz Aldrin on the Moon, Apollo 11, 1969, photographed by Neil Armstrong. NASA, public domain (AS11-40-5903)' };
/** A binary PGM (P5, 8-bit): the photograph's format, read the same way in the page and in the tests. */
export function parsePgm(b: Uint8Array): Picture {
  let at = 0;
  const word = (): string => { while (b[at] === 0x20 || b[at] === 0x0a || b[at] === 0x0d || b[at] === 0x09) at++; let s = ''; while (at < b.length && b[at] > 0x20) s += String.fromCharCode(b[at++]); return s; };
  if (word() !== 'P5') throw new Error('not a binary PGM');
  const w = Number(word()), h = Number(word()), max = Number(word());
  at++;
  if (max !== 255 || b.length - at < w * h) throw new Error('unexpected PGM');
  return pictureOf(w, h, (x, y) => b[at + y * w + x]);
}

/** Grown to whole 8 × 8 blocks by repeating the last row and column, as a JPEG encoder must. */
export function padTo8(p: Picture): Picture {
  const w = Math.ceil(p.w / 8) * 8, h = Math.ceil(p.h / 8) * 8;
  return pictureOf(w, h, (x, y) => p.px[Math.min(y, p.h - 1) * p.w + Math.min(x, p.w - 1)]);
}

// ---- 2-D filtering --------------------------------------------------------------------------------------------------------------------------

/** Kernels as square arrays, row after row, centred. */
export const KERNELS: Record<string, { k: number[][]; note: string }> = {
  box: { k: [[1, 1, 1], [1, 1, 1], [1, 1, 1]].map((r) => r.map((v) => v / 9)), note: 'average of nine' },
  blur: { k: [[1, 2, 1], [2, 4, 2], [1, 2, 1]].map((r) => r.map((v) => v / 16)), note: 'binomial: [1 2 1] across, times [1 2 1] down' },
  sharpen: { k: [[0, -1, 0], [-1, 5, -1], [0, -1, 0]], note: 'the sample, plus its difference from its neighbours' },
  edges: { k: [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], note: 'Sobel: a slope across, smoothed down' },
};

/** Each output is Σ k[j][i] × p(x + i − c, y + j − c): correlation, the kernel not flipped (every kernel here is symmetric or named for its direction). Outside the picture the nearest edge sample is used, scipy.ndimage's mode 'nearest'. */
export function filter2d(p: Picture, k: readonly (readonly number[])[]): Picture {
  const n = k.length, c = (n - 1) / 2, { w, h } = p;
  return pictureOf(w, h, (x, y) => {
    let s = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const xx = Math.max(0, Math.min(w - 1, x + i - c)), yy = Math.max(0, Math.min(h - 1, y + j - c));
      s += k[j][i] * p.px[yy * w + xx];
    }
    return s;
  });
}

/** A 1-D filter along rows (axis 'x') or columns, edges as above. */
export function filter1d(p: Picture, taps: readonly number[], axis: 'x' | 'y'): Picture {
  const n = taps.length, c = Math.floor((n - 1) / 2), { w, h } = p;
  return pictureOf(w, h, (x, y) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const xx = axis === 'x' ? Math.max(0, Math.min(w - 1, x + i - c)) : x, yy = axis === 'y' ? Math.max(0, Math.min(h - 1, y + i - c)) : y;
      s += taps[i] * p.px[yy * w + xx];
    }
    return s;
  });
}
/** Multiplications a sample: a full n × n kernel, against the same kernel done as a row pass and a column pass. */
export const filterCost = (n: number) => ({ full: n * n, separable: 2 * n });

// ---- resizing ------------------------------------------------------------------------------------------------------------------------------------------

/** The low-pass that comes before keeping one sample in m: a windowed sinc at 1 / (2m) of the rate, its taps summed to 1 so flat areas keep their level. */
export function decimationTaps(m: number, n = 8 * m + 1): number[] {
  const t = windowedSinc(n, 0.5 / m), s = t.reduce((a, b) => a + b, 0);
  return t.map((v) => v / s);
}
/** One sample in m kept along each axis, after the low-pass or without it. */
export function shrink(p: Picture, m: number, filtered: boolean): Picture {
  const q = filtered ? filter1d(filter1d(p, decimationTaps(m), 'x'), decimationTaps(m), 'y') : p;
  return pictureOf(Math.floor(p.w / m), Math.floor(p.h / m), (x, y) => q.px[y * m * p.w + x * m]);
}
/** Grown m times: each sample repeated, or each new one on the straight lines between its neighbours (bilinear, centres aligned). */
export function grow(p: Picture, m: number, how: 'nearest' | 'bilinear'): Picture {
  const { w, h } = p, at = (x: number, y: number) => p.px[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
  return pictureOf(w * m, h * m, (x, y) => {
    if (how === 'nearest') return at(Math.floor(x / m), Math.floor(y / m));
    const fx = (x + 0.5) / m - 0.5, fy = (y + 0.5) / m - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    return (1 - ay) * ((1 - ax) * at(x0, y0) + ax * at(x0 + 1, y0)) + ay * ((1 - ax) * at(x0, y0 + 1) + ax * at(x0 + 1, y0 + 1));
  });
}

// ---- the 8 × 8 DCT -----------------------------------------------------------------------------------------------------------------------------------------

/** T.81 A.3.3: S(v, u) = ¼ C(u) C(v) Σ Σ s(y, x) cos((2x + 1)uπ/16) cos((2y + 1)vπ/16), C(0) = 1/√2. Blocks are 64 numbers, row after row, [v][u]. */
const COS = Array.from({ length: 8 }, (_, u) => Array.from({ length: 8 }, (_, x) => 0.5 * (u ? 1 : Math.SQRT1_2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)));
export function fdct(s: ArrayLike<number>): Float64Array {
  const t = new Float64Array(64), out = new Float64Array(64);
  for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) { let a = 0; for (let x = 0; x < 8; x++) a += s[y * 8 + x] * COS[u][x]; t[y * 8 + u] = a; }
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) { let a = 0; for (let y = 0; y < 8; y++) a += t[y * 8 + u] * COS[v][y]; out[v * 8 + u] = a; }
  return out;
}
export function idct(S: ArrayLike<number>): Float64Array {
  const t = new Float64Array(64), out = new Float64Array(64);
  for (let v = 0; v < 8; v++) for (let x = 0; x < 8; x++) { let a = 0; for (let u = 0; u < 8; u++) a += S[v * 8 + u] * COS[u][x]; t[v * 8 + x] = a; }
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { let a = 0; for (let v = 0; v < 8; v++) a += t[v * 8 + x] * COS[v][y]; out[y * 8 + x] = a; }
  return out;
}
/** One basis picture: what a single coefficient of 1 at (v, u) puts back. */
export function basis(v: number, u: number): Float64Array { const S = new Float64Array(64); S[v * 8 + u] = 1; return idct(S); }
/** A block of a picture, level-shifted by −128 as T.81 A.3.1 has it. */
export function blockAt(p: Picture, bx: number, by: number): Float64Array {
  const b = new Float64Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) b[y * 8 + x] = p.px[(by * 8 + y) * p.w + bx * 8 + x] - 128;
  return b;
}

// ---- quantization -----------------------------------------------------------------------------------------------------------------------------------------

/** T.81 Table K.1, the luminance table, row after row. */
export const ANNEX_K1 = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
/** libjpeg's quality scaling of it (jcparam.c, as Pillow writes it at every quality: oracle.py): 5000 / q below 50, 200 − 2q above, in whole percent, each entry clamped to 1 … 255 for 8-bit tables. */
export function qualityTable(q: number): number[] {
  const qq = Math.max(1, Math.min(100, Math.round(q))), scale = qq < 50 ? Math.floor(5000 / qq) : 200 - 2 * qq;
  return ANNEX_K1.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
}
/** Round to nearest, halves away from zero (T.81 A.3.4 says only "nearest"). */
export const quantize = (S: ArrayLike<number>, T: readonly number[]): Int32Array => Int32Array.from({ length: 64 }, (_, i) => Math.sign(S[i]) * Math.floor(Math.abs(S[i]) / T[i] + 0.5));

/** T.81 Figure A.6: ZIGZAG[k] is the row-major index of the k-th coefficient sent. */
export const ZIGZAG: number[] = (() => {
  const o: number[] = [];
  for (let s = 0; s < 15; s++) {
    const cells: number[] = [];
    for (let v = 0; v < 8; v++) { const u = s - v; if (u >= 0 && u < 8) cells.push(v * 8 + u); }
    o.push(...(s % 2 ? cells : cells.reverse()));
  }
  return o;
})();

// ---- Huffman -----------------------------------------------------------------------------------------------------------------------------------------------

export interface HuffSpec { bits: number[]; vals: number[] }
/** T.81 Tables K.3 and K.5 as the lists a file carries: BITS (how many codes of each length 1 … 16) and HUFFVAL (the symbols in code order). These are what Pillow writes (oracle.py). */
export const DC_LUMA: HuffSpec = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
export const AC_LUMA: HuffSpec = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125],
  vals: [1, 2, 3, 0, 4, 17, 5, 18, 33, 49, 65, 6, 19, 81, 97, 7, 34, 113, 20, 50, 129, 145, 161, 8, 35, 66, 177, 193, 21, 82, 209, 240, 36, 51, 98, 114, 130, 9, 10, 22, 23, 24, 25, 26, 37, 38, 39, 40, 41, 42, 52, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72, 73, 74, 83, 84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104, 105, 106, 115, 116, 117, 118, 119, 120, 121, 122, 131, 132, 133, 134, 135, 136, 137, 138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166, 167, 168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186, 194, 195, 196, 197, 198, 199, 200, 201, 202, 210, 211, 212, 213, 214, 215, 216, 217, 218, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250],
};
/** T.81 Annex C: codes from the lists. Each length's codes count up from where the shorter ones left off, doubled: a canonical code, so the file needs only the lists. */
export function huffCodes(spec: HuffSpec): Map<number, { code: number; len: number }> {
  const out = new Map<number, { code: number; len: number }>();
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) { for (let i = 0; i < spec.bits[len - 1]; i++) out.set(spec.vals[k++], { code: code++, len }); code <<= 1; }
  return out;
}
/** The size category of a value: how many bits its magnitude needs. */
export const category = (v: number): number => (v ? Math.floor(Math.log2(Math.abs(v))) + 1 : 0);
/** The extra bits after a category: the value itself, or for a negative one the value − 1 in that many low bits (its complement). */
export const extraBits = (v: number, size: number): number => (v >= 0 ? v : v + (1 << size) - 1);

// ---- the file ---------------------------------------------------------------------------------------------------------------------------------------------

class BitWriter {
  bytes: number[] = [];
  private acc = 0;
  private n = 0;
  put(code: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      if (++this.n === 8) { this.bytes.push(this.acc); if (this.acc === 0xff) this.bytes.push(0); this.acc = 0; this.n = 0; }
    }
  }
  /** The last byte filled with 1 bits (T.81 F.1.2.3). */
  flush(): void { if (this.n) this.put((1 << (8 - this.n)) - 1, 8 - this.n); }
}

export interface JpegResult {
  bytes: Uint8Array;
  /** What came back: dequantized, inverse-transformed, level-shifted, rounded and clamped, as an ideal decoder does it. */
  out: Picture;
  table: number[];
  /** Per block, its quantized coefficients in row-major order. */
  levels: Int32Array[];
  bits: { dcCodes: number; dcExtra: number; acCodes: number; acExtra: number; header: number; stuffed: number };
  zeros: number;
}

const be16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const segment = (marker: number, body: number[]) => [0xff, marker, ...be16(body.length + 2), ...body];

/** A baseline, sequential, Huffman-coded, one-component JPEG (T.81 Annex B), with the Annex K luminance tables. */
export function encodeJpeg(p0: Picture, quality: number): JpegResult {
  const p = padTo8(p0), table = qualityTable(quality), dc = huffCodes(DC_LUMA), ac = huffCodes(AC_LUMA), bw = new BitWriter();
  const bits = { dcCodes: 0, dcExtra: 0, acCodes: 0, acExtra: 0, header: 0, stuffed: 0 }, levels: Int32Array[] = [], out = new Float64Array(p.w * p.h);
  let pred = 0, zeros = 0;
  const code = (m: Map<number, { code: number; len: number }>, sym: number, key: 'dcCodes' | 'acCodes') => { const c = m.get(sym)!; bw.put(c.code, c.len); bits[key] += c.len; };
  for (let by = 0; by < p.h / 8; by++) for (let bx = 0; bx < p.w / 8; bx++) {
    const L = quantize(fdct(blockAt(p, bx, by)), table);
    levels.push(L);
    for (const v of L) if (!v) zeros++;
    const diff = L[0] - pred, sz = category(diff);
    pred = L[0];
    code(dc, sz, 'dcCodes');
    if (sz) { bw.put(extraBits(diff, sz), sz); bits.dcExtra += sz; }
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = L[ZIGZAG[k]];
      if (!v) { run++; continue; }
      while (run > 15) { code(ac, 0xf0, 'acCodes'); run -= 16; }
      const s = category(v);
      code(ac, (run << 4) | s, 'acCodes');
      bw.put(extraBits(v, s), s); bits.acExtra += s;
      run = 0;
    }
    if (run) code(ac, 0x00, 'acCodes');
    const r = idct(L.map((v, i) => v * table[i]));
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[(by * 8 + y) * p.w + bx * 8 + x] = clamp255(Math.round(r[y * 8 + x] + 128));
  }
  bw.flush();
  const dht = (tc: number, s: HuffSpec) => [tc, ...s.bits, ...s.vals];
  const head = [
    0xff, 0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xdb, [0x00, ...ZIGZAG.map((i) => table[i])]),
    ...segment(0xc0, [8, ...be16(p0.h), ...be16(p0.w), 1, 1, 0x11, 0]),
    ...segment(0xc4, [...dht(0x00, DC_LUMA), ...dht(0x10, AC_LUMA)]),
    ...segment(0xda, [1, 1, 0x00, 0, 63, 0]),
  ];
  bits.header = 8 * (head.length + 2);
  bits.stuffed = 8 * (bw.bytes.length - Math.ceil((bits.dcCodes + bits.dcExtra + bits.acCodes + bits.acExtra) / 8));
  const crop = pictureOf(p0.w, p0.h, (x, y) => out[y * p.w + x]);
  return { bytes: Uint8Array.from([...head, ...bw.bytes, 0xff, 0xd9]), out: crop, table, levels, bits, zeros };
}

/** Peak signal to noise, in dB, against 255. */
export function psnr(a: Picture, b: Picture): number {
  let s = 0;
  for (let i = 0; i < a.px.length; i++) s += (a.px[i] - b.px[i]) ** 2;
  return 10 * Math.log10((255 * 255) / Math.max(s / a.px.length, 1e-12));
}

// ---- the 1-D DCT the gates hold --------------------------------------------------------------------------------------------------------------------------

/** Fraction bits of the constants. */
export const DCT_C = 12;
/** Extra fraction bits each pass keeps: one pass's outputs are 2^F times the true values. */
export const DCT_F = 2;
/** Bits in, and out, of one stage. In holds a pixel less 128, or a first pass's output; out holds a second pass's. */
export const DCT_WI = 12, DCT_WO = 15;
/** k[u] = round(2^C × C(u)/2 × cos(uπ/16)); k[0] = k[4], since C(0)/2 = cos(π/4)/2. */
export const DCT_K: number[] = Array.from({ length: 8 }, (_, u) => Math.round(2 ** DCT_C * 0.5 * Math.cos((((u || 4)) * Math.PI) / 16)));

/**
 * One 8-point DCT, as the gates do it: sums and differences first (a = x_i + x_{7−i}, b = x_i − x_{7−i}; then c = a0 + a3, a1 + a2 and d = a0 − a3, a1 − a2), every product by a
 * constant kept whole and summed, and the sum rounded once, half up: y = ⌊(Σ + 2^(C−F−1)) / 2^(C−F)⌋. 22 constant products: 2 for X0 and X4, 4 for X2 and X6, 16 for the odd four.
 */
export function dct8Fixed(x: readonly number[]): number[] {
  const K = DCT_K, a = [0, 1, 2, 3].map((i) => x[i] + x[7 - i]), b = [0, 1, 2, 3].map((i) => x[i] - x[7 - i]);
  const c0 = a[0] + a[3], c1 = a[1] + a[2], d0 = a[0] - a[3], d1 = a[1] - a[2];
  const sums = [
    K[4] * (c0 + c1),
    K[1] * b[0] + K[3] * b[1] + K[5] * b[2] + K[7] * b[3],
    K[2] * d0 + K[6] * d1,
    K[3] * b[0] - K[7] * b[1] - K[1] * b[2] - K[5] * b[3],
    K[4] * (c0 - c1),
    K[5] * b[0] - K[1] * b[1] + K[7] * b[2] + K[3] * b[3],
    K[6] * d0 - K[2] * d1,
    K[7] * b[0] - K[5] * b[1] + K[3] * b[2] - K[1] * b[3],
  ];
  const sh = DCT_C - DCT_F;
  return sums.map((s) => Math.floor((s + 2 ** (sh - 1)) / 2 ** sh));
}
/** The 8 × 8 DCT through one stage, sixteen times: rows, then columns. Out is 2^(2F) times S. */
export function dct2Fixed(block: ArrayLike<number>): number[] {
  const rows: number[] = [];
  for (let y = 0; y < 8; y++) rows.push(...dct8Fixed(Array.from({ length: 8 }, (_, x) => block[y * 8 + x])));
  const out = new Array<number>(64);
  for (let u = 0; u < 8; u++) { const col = dct8Fixed(Array.from({ length: 8 }, (_, y) => rows[y * 8 + u])); for (let v = 0; v < 8; v++) out[v * 8 + u] = col[v]; }
  return out;
}
