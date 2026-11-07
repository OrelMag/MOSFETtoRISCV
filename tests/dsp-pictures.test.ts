// Pictures: the tables against T.81 and against Pillow, the DCT against scipy, filters against scipy.ndimage, our JPEG file against libjpeg's decode (Pillow), and the
// 8-point DCT in gates against its integer model on every vector tried.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { signedOf, wordOf } from '../src/comm/signals';
import { AC_LUMA, ANNEX_K1, blockAt, category, DC_LUMA, DCT_F, DCT_K, DCT_WI, DCT_WO, dct2Fixed, dct8Fixed, decimationTaps, encodeJpeg, extraBits, fdct, filter1d, filter2d, huffCodes, idct, KERNELS, parsePgm, pictureOf, qualityTable, scene, ZIGZAG } from '../src/dsp/pictures';
import { constMul, dctStage } from '../src/lib/dct';
import { BitSim } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';
import V from './dsp/vectors/pictures.json';

const near = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); expect(m).toBeLessThanOrEqual(tol); };

describe('the tables', () => {
  it('K.1 as printed, and libjpeg\'s quality scaling as Pillow writes it at every quality tried', () => {
    expect(ANNEX_K1.slice(0, 8)).toEqual([16, 11, 10, 16, 24, 40, 51, 61]);
    expect(ANNEX_K1.slice(56)).toEqual([72, 92, 95, 98, 112, 100, 103, 99]);
    expect(qualityTable(50)).toEqual(ANNEX_K1);
    for (const [q, t] of Object.entries(V.tables)) expect([q, qualityTable(Number(q))]).toEqual([q, t]);
  });
  it('the Huffman lists are the ones Pillow writes, and give the code words T.81\'s K.3 and K.5 print', () => {
    expect(DC_LUMA).toEqual(V.huff.dc);
    expect(AC_LUMA).toEqual(V.huff.ac);
    const dc = huffCodes(DC_LUMA), ac = huffCodes(AC_LUMA), b = (c: { code: number; len: number } | undefined) => c!.code.toString(2).padStart(c!.len, '0');
    for (const [s, w] of [[0, '00'], [1, '010'], [5, '110'], [6, '1110'], [11, '111111110']] as const) expect(b(dc.get(s))).toBe(w);
    for (const [s, w] of [[0x00, '1010'], [0x01, '00'], [0x08, '1111110110'], [0x09, '1111111110000010'], [0x11, '1100'], [0x15, '11111110110'], [0x21, '11100'], [0x24, '111111110100'], [0x3a, '1111111110010101']] as const) expect(b(ac.get(s))).toBe(w);
    expect(ac.size).toBe(162);
  });
  it('zig-zag visits every coefficient once, along the anti-diagonals', () => {
    expect([...ZIGZAG].sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, i) => i));
    expect(ZIGZAG.slice(0, 10)).toEqual([0, 1, 8, 16, 9, 2, 3, 10, 17, 24]);
    expect(ZIGZAG.slice(-3)).toEqual([55, 62, 63]);
  });
  it('categories and extra bits, as F.1.2.1 sends them', () => {
    expect([0, 1, -1, 2, 3, -3, 255, -1023].map(category)).toEqual([0, 1, 1, 2, 2, 2, 8, 10]);
    expect(extraBits(-1, 1)).toBe(0); expect(extraBits(-3, 2)).toBe(0); expect(extraBits(-2, 2)).toBe(1); expect(extraBits(5, 3)).toBe(5);
  });
});

describe('the transform', () => {
  it('A.3.3\'s FDCT is scipy\'s orthonormal DCT-II on both axes, and the IDCT undoes it', () => {
    for (const c of V.dct) { near(fdct(c.x), c.S, 1e-9); near(idct(fdct(c.x)), c.x, 1e-12); }
  });
  it('a smooth block puts almost all its energy in a few coefficients', () => {
    const blk = pictureOf(8, 8, (x, y) => 128 + 10 * x + 5 * y), S = fdct(blockAt(blk, 0, 0)), e = S.map((v) => v * v), all = e.reduce((a, b) => a + b, 0);
    expect((e[0] + e[1] + e[8]) / all).toBeGreaterThan(0.99);
  });
});

describe('filters and resizing', () => {
  const P = V.picture, pic = { w: P.w, h: P.h, px: Float64Array.from(P.px) };
  it('every kernel equals scipy.ndimage.correlate with mode nearest', () => {
    for (const [k, want] of Object.entries(V.filters)) near(filter2d(pic, KERNELS[k].k).px, want, 1e-9);
  });
  it('a product kernel done as a row pass and a column pass is the same filter', () => {
    const sep = filter1d(filter1d(pic, [0.25, 0.5, 0.25], 'x'), [0.25, 0.5, 0.25], 'y');
    near(sep.px, filter2d(pic, KERNELS.blur.k).px, 1e-9);
  });
  it('the anti-alias filter\'s taps and its two passes equal scipy\'s', () => {
    for (const [m, c] of Object.entries(V.shrink)) {
      near(decimationTaps(Number(m)), c.taps, 1e-9);
      const t = decimationTaps(Number(m));
      near(filter1d(filter1d(pic, t, 'x'), t, 'y').px, c.filtered, 1e-9);
    }
  });
});

describe('the file', () => {
  it('the writer still makes the checked-in files, byte for byte', () => {
    for (const q of [10, 75]) expect(Buffer.from(encodeJpeg(scene(96), q).bytes).equals(readFileSync(`tests/dsp/vectors/pictures-q${q}.jpg`))).toBe(true);
  });
  it('libjpeg decodes them to within one level of our own reconstruction', () => {
    for (const [q, d] of Object.entries(V.decoded)) {
      const r = encodeJpeg(scene(96), Number(q));
      expect([d.mode, d.size]).toEqual(['L', [96, 96]]);
      near(r.out.px, d.px, 1);
    }
  });
  it('markers in order, no unstuffed 0xFF in the scan, and the bit counts add up to the bytes', () => {
    const r = encodeJpeg(scene(96), 50), b = r.bytes, markers: number[] = [];
    for (let i = 0; i < b.length - 1;) { if (b[i] !== 0xff) throw new Error('lost'); markers.push(b[i + 1]); if (b[i + 1] === 0xd8) { i += 2; continue; } if (b[i + 1] === 0xda) break; i += 2 + b[i + 2] * 256 + b[i + 3]; }
    expect(markers).toEqual([0xd8, 0xe0, 0xdb, 0xc0, 0xc4, 0xda]);
    // bits.header counts every byte that is not scan data, the end marker included
    const scan = r.bits.header / 8 - 2;
    expect([b[scan - 10], b[scan - 9]]).toEqual([0xff, 0xda]);
    for (let i = scan; i < b.length - 2; i++) if (b[i] === 0xff) expect(b[i + 1]).toBe(0);
    expect([b[b.length - 2], b[b.length - 1]]).toEqual([0xff, 0xd9]);
    const data = r.bits.dcCodes + r.bits.dcExtra + r.bits.acCodes + r.bits.acExtra;
    expect(b.length * 8).toBe(r.bits.header + Math.ceil(data / 8) * 8 + r.bits.stuffed);
  });
});

describe('the fixed-point DCT', () => {
  it('through one stage sixteen times it comes within 3/8 of the true coefficients on the scene', () => {
    const p = scene();
    let worst = 0;
    for (let by = 0; by < 24; by++) for (let bx = 0; bx < 24; bx++) { const blk = blockAt(p, bx, by), f = fdct(blk), g = dct2Fixed(blk); f.forEach((v, i) => { worst = Math.max(worst, Math.abs(v - g[i] / 2 ** (2 * DCT_F))); }); }
    expect(worst).toBeLessThan(0.4);
  });
  it('the first pass fits the stage\'s input, and the second its output, at the extremes', () => {
    const fits = (v: number, w: number) => v >= -(2 ** (w - 1)) && v < 2 ** (w - 1);
    for (const f of [() => -128, () => 127, (i: number) => ((i + (i >> 3)) % 2 ? 127 : -128), (i: number) => (i % 8 < 4 ? 127 : -128), (i: number) => ((i >> 3) < 4 ? 127 : -128)]) {
      const blk = Array.from({ length: 64 }, (_, i) => f(i)), rows: number[] = [];
      for (let y = 0; y < 8; y++) rows.push(...dct8Fixed(blk.slice(8 * y, 8 * y + 8)));
      for (const v of rows) expect(fits(v, DCT_WI)).toBe(true);
      for (const v of dct2Fixed(blk)) expect(fits(v, DCT_WO)).toBe(true);
    }
  });
});

describe('the gates', () => {
  it('every constant multiplier equals k × x for every input it takes, at the width the stage uses it', () => {
    // s0 and s4 are 15 bits wide, d0 and d1 14, the b's 13
    for (const [k, w] of [[DCT_K[4], 15], [DCT_K[2], 14], [DCT_K[6], 14], [DCT_K[1], 13], [DCT_K[3], 13], [DCT_K[5], 13], [DCT_K[7], 13]]) {
      const d = constMul(k, w), sim = new BitSim(flatten(d));
      for (let x0 = -(2 ** (w - 1)); x0 < 2 ** (w - 1); x0 += 32) {
        sim.setInput('x', Array.from({ length: 32 }, (_, l) => wordOf(x0 + l, w))); sim.settle();
        const got = sim.get('y');
        for (let l = 0; l < 32; l++) if (signedOf(got[l], 28) !== k * (x0 + l)) expect([k, x0 + l, signedOf(got[l], 28)]).toEqual([k, x0 + l, k * (x0 + l)]);
      }
    }
  });
  it('the stage equals its model on basis vectors, extremes and random rows from both passes', () => {
    const d = dctStage(), sim = new BitSim(flatten(d));
    let s = 9;
    const u = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const vecs: number[][] = [];
    for (let i = 0; i < 8; i++) { vecs.push(Array.from({ length: 8 }, (_, j) => (j === i ? 127 : 0))); vecs.push(Array.from({ length: 8 }, (_, j) => (j === i ? -128 : 0))); }
    vecs.push(new Array(8).fill(-128), new Array(8).fill(127), [127, -128, 127, -128, 127, -128, 127, -128], [-1448, 1307, -1448, 1307, -1448, 1307, -1448, 1307]);
    for (let i = 0; i < 2000; i++) vecs.push(Array.from({ length: 8 }, () => Math.floor((u() - 0.5) * (i % 2 ? 256 : 2 * 1448))));
    for (let i = 0; i < vecs.length; i += 32) {
      const lanes = vecs.slice(i, i + 32);
      for (let k = 0; k < 8; k++) sim.setInput(`x${k}`, lanes.map((v) => wordOf(v[k], DCT_WI)));
      sim.settle();
      const outs = Array.from({ length: 8 }, (_, k) => sim.get(`y${k}`));
      lanes.forEach((v, l) => { const got = outs.map((o) => signedOf(o[l], DCT_WO)), want = dct8Fixed(v); if (got.join() !== want.join()) expect([v, got]).toEqual([v, want]); });
    }
  });
  it('draws with no wire on another, no symbol on another, no label over a part', () => {
    const seen = new Set<ComponentDef>(), visit = (d: ComponentDef) => {
      if (seen.has(d)) return;
      seen.add(d);
      const nl = netlistOf(d);
      if (!nl || d.prim) return;
      expect([d.id, wireOverlaps(routeNetlist(d, nl).nets)]).toEqual([d.id, []]);
      expect([d.id, labelOverlaps(d, nl)]).toEqual([d.id, []]);
      expect([d.id, symbolOverlaps(nl)]).toEqual([d.id, []]);
      for (const i of nl.instances) if (i.def.id.startsWith('dct') || i.def.id.startsWith('cmul')) visit(i.def);
    };
    visit(dctStage());
  }, 120_000);
});

describe('the photograph', () => {
  it('is a 192 × 192 grey picture the page and the tests read the same way, and the writer codes it', () => {
    const p = parsePgm(new Uint8Array(readFileSync('public/dsp/aldrin-192.pgm')));
    expect([p.w, p.h]).toEqual([192, 192]);
    const lo = Math.min(...p.px), hi = Math.max(...p.px);
    expect(lo).toBeLessThan(20); expect(hi).toBeGreaterThan(230);
    const r = encodeJpeg(p, 50);
    expect(r.out.w).toBe(192);
    expect(r.bytes.length).toBeLessThan(192 * 192);
  });
});
