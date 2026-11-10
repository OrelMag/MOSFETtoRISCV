// Core rope in 3D, held to the rope's rules (R-700 vol. III sec. 3.5.2; Shirriff 2019): a wire through a core is a 1 and
// one round it a 0, never through the ring itself; the inhibit pairs leave exactly the addressed core free; the set and
// reset switch only that core and the sense wires that thread it pulse; the module's counts multiply out to 36 864 words.
import { describe, expect, it } from 'vitest';
import {
  BITS, CORES, CORE_R, FIXED_WORDS, HOLE_R, LAYERS, LAYER_COLS, LAYER_ROWS, MODULE_CORES, MODULE_WORDS, OD, PAIRS, SENSE_LINES, STRANDS,
  UNIT_MM, WIRES, WORDS_PER_CORE, WORD_BITS, coreX, inRing, inhibitDriven, inhibitsOn, moduleCores, radiusOf, ropeAnchors, ropeParts, senseWord, switching,
  threads, wireLive, wirePath, wireThreads, type RopePalette, type RopePose,
} from '../src/widgets/rope3dparts';

const G: [number, number, number] = [0.5, 0.5, 0.5];
const P: RopePalette = { ribbon: G, bobbin: G, copper: G, inhibit: G, set: G, reset: G, live: [1, 0.8, 0], board: G, res: G, diode: G, lamp: G, lampOff: G, sel: G };

describe('core rope in 3D', () => {
  it('the sourced numbers: 512 cores, 192 sense lines, 12 words of 16 bits a core, six modules of 6144 words, 0.249 in cores', () => {
    expect(WORDS_PER_CORE * WORD_BITS).toBe(SENSE_LINES);
    expect(MODULE_WORDS).toBe(6144);
    expect(FIXED_WORDS).toBe(36864);
    expect(LAYERS * LAYER_COLS * LAYER_ROWS).toBe(MODULE_CORES);
    expect(moduleCores()).toHaveLength(MODULE_CORES);
    expect(OD * UNIT_MM).toBeCloseTo(0.249 * 25.4, 6);
  });

  it('a wire runs straight through the cores it threads and round the others, never through a ring', () => {
    WIRES.forEach((w, i) => {
      const pts = wirePath(i);
      // sample every segment finely: no point inside ring material
      for (let j = 1; j < pts.length; j++) for (let s = 0; s <= 40; s++) {
        const q = pts[j - 1].map((v, k) => v + ((pts[j][k] - v) * s) / 40) as [number, number, number];
        for (let c = 0; c < CORES; c++) expect(inRing(q, c), `wire ${i} at core ${c}`).toBe(false);
      }
      for (let c = 0; c < CORES; c++) {
        // at the core's middle the wire is inside the hole iff it threads it, else outside the ring
        const x = coreX(c), seg = pts.findIndex((p, j) => j > 0 && Math.min(pts[j - 1][0], p[0]) <= x && Math.max(pts[j - 1][0], p[0]) >= x && pts[j - 1][0] !== p[0]);
        const a = pts[seg - 1], b = pts[seg], u = (x - a[0]) / (b[0] - a[0]);
        const r = radiusOf([x, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
        if (wireThreads(w, c)) expect(r).toBeLessThan(HOLE_R); else expect(r).toBeGreaterThan(CORE_R);
      }
    });
  });

  it('the inhibit pairs leave exactly the addressed core uninhibited, one member of each pair driven', () => {
    for (let a = 0; a < CORES; a++) {
      expect(inhibitDriven(a)).toHaveLength(PAIRS);
      for (let c = 0; c < CORES; c++) expect(inhibitsOn(a, c) === 0, `addr ${a}, core ${c}`).toBe(c === a);
      expect(switching('set', a)).toEqual([a]);
      expect(switching('reset', a)).toEqual([a]);
      expect(switching('idle', a)).toEqual([]);
    }
  });

  it('a read: the sense wires of the chosen strand that thread the core pulse, and they spell its word', () => {
    for (let s = 0; s < STRANDS; s++) for (let a = 0; a < CORES; a++) {
      const pose: RopePose = { strand: s, addr: a, phase: 'reset', module: false };
      let w = 0;
      WIRES.forEach((x, i) => { if (x.kind === 'sense' && wireLive(i, pose)) { expect(x.strand).toBe(s); w |= 1 << x.bit; } });
      expect(w).toBe(senseWord(s, a));
      for (let b = 0; b < BITS; b++) expect(((w >> b) & 1) === 1).toBe(threads(s, b, a));
      // no sense pulse while the set current is on in this drawing, and no inhibit in the reset
      const set: RopePose = { ...pose, phase: 'set' };
      expect(WIRES.some((x, i) => x.kind === 'sense' && wireLive(i, set))).toBe(false);
      expect(WIRES.some((x, i) => x.kind === 'inhibit' && wireLive(i, pose))).toBe(false);
    }
  });

  it('draws the close-up, and the module when asked; the anchors point at the model', () => {
    const pose: RopePose = { strand: 0, addr: 2, phase: 'idle', module: false };
    const near = ropeParts(pose, P), far = ropeParts({ ...pose, module: true }, P);
    expect(far.length - near.length).toBeGreaterThanOrEqual(MODULE_CORES);
    for (const a of ropeAnchors({ ...pose, module: true })) for (const v of a.p) expect(Number.isFinite(v)).toBe(true);
    expect(ropeAnchors(pose, true).length).toBeLessThan(ropeAnchors(pose).length);
  });
});
