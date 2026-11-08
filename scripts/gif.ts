// PNG frames to an animated GIF with no dependency, for the README's animations (scripts/readme-shots.ts). One palette for
// the whole animation from the frames' commonest colours (the site's flat colours fit in 254), and each frame stores only the
// rectangle that changed, the rest transparent, so a stepping circuit stays small.
import { inflateSync } from 'node:zlib';

export interface Rgb { w: number; h: number; rgb: Uint8Array }

/** An 8-bit RGB or RGBA PNG, as Chrome's captureScreenshot writes them. */
export function decodePng(buf: Buffer): Rgb {
  let p = 8, w = 0, h = 0, ct = 0;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const n = buf.readUInt32BE(p), t = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + n);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12]) throw new Error('PNG: 8-bit, not interlaced only'); }
    if (t === 'IDAT') idat.push(d);
    p += 12 + n;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!bpp) throw new Error(`PNG colour type ${ct}`);
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, out = new Uint8Array(w * h * 3);
  const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0, q = 0; y < h; y++) {
    const f = raw[q++];
    for (let x = 0; x < stride; x++, q++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = raw[q];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v;
    }
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 3; out[i] = cur[x * bpp]; out[i + 1] = cur[x * bpp + 1]; out[i + 2] = cur[x * bpp + 2]; }
    prev.set(cur);
  }
  return { w, h, rgb: out };
}

function lzw(indices: Uint8Array, minCode: number): number[] {
  const out: number[] = [], clear = 1 << minCode, end = clear + 1;
  let cur = 0, bits = 0, size = minCode + 1, next = end + 1, table = new Map<number, number>();
  const emit = (c: number) => { cur |= c << bits; bits += size; while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; } };
  emit(clear);
  let w = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = (w << 8) | k, hit = table.get(key);
    if (hit !== undefined) { w = hit; continue; }
    emit(w);
    if (next === 4096) { emit(clear); table = new Map(); size = minCode + 1; next = end + 1; }
    else { table.set(key, next); if (next === 1 << size && size < 12) size++; next++; }
    w = k;
  }
  emit(w); emit(end);
  if (bits) out.push(cur & 255);
  return out;
}

/** Frames of one size, a delay in ms for each (or one for all); loops forever. */
export function encodeGif(frames: Rgb[], delays: number | number[]): Buffer {
  const { w, h } = frames[0], counts = new Map<number, number>();
  for (const f of frames) for (let i = 0; i < f.rgb.length; i += 9) { const k = ((f.rgb[i] >> 3) << 10) | ((f.rgb[i + 1] >> 3) << 5) | (f.rgb[i + 2] >> 3); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 254).map(([k]) => [((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4]);
  while (top.length < 254) top.push([0, 0, 0]);
  const cache = new Map<number, number>();
  const near = (r: number, g: number, b: number): number => {
    const k = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let v = cache.get(k);
    if (v !== undefined) return v;
    let best = Infinity;
    v = 0;
    for (let i = 0; i < top.length; i++) { const d = 2 * (top[i][0] - r) ** 2 + 4 * (top[i][1] - g) ** 2 + 3 * (top[i][2] - b) ** 2; if (d < best) { best = d; v = i; } }
    cache.set(k, v);
    return v;
  };
  const TRANSPARENT = 255, out: number[] = [];
  const u16 = (v: number) => out.push(v & 255, v >> 8);
  out.push(...Buffer.from('GIF89a')); u16(w); u16(h); out.push(0xf7, 0, 0);
  for (let i = 0; i < 256; i++) out.push(...(top[i] ?? [0, 0, 0]));
  out.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0);
  let prev: Uint8Array | null = null;
  frames.forEach((f, n) => {
    const idx = new Uint8Array(w * h);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      const v = near(f.rgb[3 * i], f.rgb[3 * i + 1], f.rgb[3 * i + 2]);
      idx[i] = v;
      if (!prev || prev[i] !== v) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; }
    const rw = x1 - x0 + 1, rh = y1 - y0 + 1, sub = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) { const i = (y + y0) * w + x + x0; sub[y * rw + x] = prev && prev[i] === idx[i] ? TRANSPARENT : idx[i]; }
    const ms = Array.isArray(delays) ? delays[n] : delays;
    out.push(0x21, 0xf9, 4, 0x05); u16(Math.round(ms / 10)); out.push(TRANSPARENT, 0);
    out.push(0x2c); u16(x0); u16(y0); u16(rw); u16(rh); out.push(0, 8);
    const data = lzw(sub, 8);
    for (let i = 0; i < data.length; i += 255) { const c = data.slice(i, i + 255); out.push(c.length, ...c); }
    out.push(0);
    prev = idx;
  });
  out.push(0x3b);
  return Buffer.from(out);
}
