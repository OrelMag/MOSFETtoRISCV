// Core rope in 3D, held to the rope's rules (R-700 vol. III sec. 3.5.2; Shirriff 2019): a wire through a core is a 1 and
// one round it a 0, never through the ring itself; the inhibit pairs leave exactly the addressed core free; the set and
// reset switch only that core and the sense wires that thread it pulse; the module's counts multiply out to 36 864 words.
import { describe, expect, it } from 'vitest';
import {
  BITS, CORES, CORE_R, FIXED_WORDS, HOLE_R, LAYERS, LAYER_COLS, LAYER_ROWS, MODULE_CORES, MODULE_WORDS, OD, PAIRS, SENSE_LINES, STRANDS,
  UNIT_MM, WIRES, WORDS_PER_CORE, WORD_BITS, coreX, inRing, inhibitDriven, inhibitsOn, moduleCores, radiusOf, senseWord, switching,
  threads, wireLive, wirePath, wireThreads, CY, CZ, type RopePose,
} from '../src/widgets/rope3dgeom';
import { AXIS_CUT, ROPE_HOME, ropeModel } from '../src/widgets/rope3dkit';


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

  it('the studio close-up: eight cores on their axis, a wire per slot following its path, the switching core lit', () => {
    const pose: RopePose = { strand: 0, addr: 2, phase: 'set', module: false }, m = ropeModel(pose);
    const ribbons = m.items.filter((i) => i.name?.startsWith('core ') && i.mat.label?.startsWith('permalloy'));
    expect(ribbons).toHaveLength(CORES);
    ribbons.forEach((r, c) => { expect(r.at).toEqual([coreX(c), CY, CZ]); expect(r.geo.max[1] - r.geo.min[1]).toBeCloseTo(OD, 1); });
    expect(ribbons.filter((r) => r.mat.emit).map((r) => r.name)).toEqual(['core 2']);
    const wires = m.items.filter((i) => /wire$/.test(i.name ?? ''));
    expect(wires).toHaveLength(WIRES.length);
    // inhibit wires lit in the set phase are exactly the driven members
    const lit = wires.filter((w) => w.mat.emit).map((w) => w.name);
    expect(lit.filter((n) => n === 'inhibit wire')).toHaveLength(PAIRS);
    expect(lit).toContain('set wire');
    expect(ropeModel({ ...pose, phase: 'idle' }).items.some((i) => i.mat.emit)).toBe(false);
  });
  it('the cut takes the cores open along their axis and leaves the wires whole', () => {
    const m = ropeModel({ strand: 1, addr: 5, phase: 'reset', module: false });
    expect(m.cuts!.planes[0]).toEqual({ n: [0, 0, 1], d: AXIS_CUT });
    expect(AXIS_CUT).toBe(CZ);
    for (const i of m.items) if (/wire$/.test(i.name ?? '') || i.name === 'sense amplifier') expect(i.cut).toBe('none');
    // in the reset the lamps of the bits core 5 holds on strand 1 are lit
    const lamps = m.items.filter((i) => i.name === 'sense amplifier' && i.mat.emit).length;
    expect(lamps).toBe(Array.from({ length: BITS }, (_, b) => threads(1, b, 5)).filter(Boolean).length);
  });
  it('the module: 512 cores, the eight of the close-up among them; both views have a home, names and a tour', () => {
    const mod = ropeModel({ strand: 0, addr: 0, phase: 'idle', module: true });
    const cores = mod.items.find((i) => i.name === 'cores')!.geo, sel = mod.items.find((i) => i.name === 'the eight cores of the close-up')!.geo;
    expect((cores.positions.length + sel.positions.length) / sel.positions.length).toBeCloseTo(MODULE_CORES / CORES, 9);
    for (const module of [false, true]) {
      const m = ropeModel({ strand: 0, addr: 0, phase: 'idle', module });
      expect((m.anchors ?? []).length).toBeGreaterThanOrEqual(3);
      expect((m.beats ?? []).length).toBeGreaterThanOrEqual(2);
      for (const a of m.anchors ?? []) for (const v of a.p) expect(Number.isFinite(v)).toBe(true);
      expect(ropeModel({ strand: 0, addr: 0, phase: 'idle', module }, 'flat').items.length).toBe(m.items.length);
    }
    expect(ROPE_HOME.close).toBeDefined();
  });
});
