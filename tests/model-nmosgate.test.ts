// The 6502-style gate: its masks hold the appendix's NNOR2 (three transistors where poly crosses diffusion, the pull-downs in
// parallel to GND, the load to VDD with its gate on its source), Mead and Conway's rules and ratio, and the model builds.
import { describe, expect, it } from 'vitest';
import { NNOR2 } from '../src/lib/nmos';
import { CELL, CHANNEL, DEVICES, HEIGHTS, MASKS, RATIO, V, channels, nmosGateModel, raster, stateOf, wl, type Rect } from '../src/widgets/nmosgate3dkit';

const inside = (r: Rect, o: Rect) => r[0] >= o[0] && r[1] >= o[1] && r[2] <= o[2] && r[3] <= o[3];
const touches = (r: Rect, o: Rect) => r[0] <= o[2] && o[0] <= r[2] && r[1] <= o[3] && o[1] <= r[3];
const overlaps = (r: Rect, o: Rect) => r[0] < o[2] && o[0] < r[2] && r[1] < o[3] && o[1] < r[3];

describe('the masks', () => {
  it('poly over diffusion makes exactly the three transistors NNOR2 has', () => {
    const found = channels().map((r) => r.join()).sort();
    expect(found).toEqual(Object.values(DEVICES).map((d) => d.ch.join()).sort());
    const tr = NNOR2.netlist!().instances.filter((i) => i.def.id === 'nmos' || i.def.id === 'dep').map((i) => i.name).sort();
    expect(tr).toEqual(Object.keys(DEVICES).sort());
  });
  it('pull-downs from the node to GND, the load from the node to VDD', () => {
    const [gnd, vdd] = MASKS.metal, node = MASKS.diff[2];
    for (const n of ['n0', 'n1'] as const) {
      const strip = MASKS.diff.find((d) => inside(DEVICES[n].ch, d))!;
      expect(overlaps(strip, gnd) && overlaps(strip, node)).toBe(true);
      expect(MASKS.cut.some((c) => inside(c, strip) && inside(c, gnd))).toBe(true);
    }
    const load = MASKS.diff.find((d) => inside(DEVICES.ld.ch, d))!;
    expect(touches(load, node)).toBe(true);
    expect(MASKS.cut.some((c) => inside(c, vdd) && MASKS.diff.some((d) => inside(c, d)))).toBe(true);
    // the output is taken from the node by a contact under the output metal
    expect(MASKS.cut.some((c) => inside(c, node) && inside(c, MASKS.metal[2]))).toBe(true);
  });
  it('the load’s gate meets the diffusion in the buried contact on its source side, under the implant', () => {
    const [bx0, , bx1, by1] = MASKS.buried[0], ch = DEVICES.ld.ch;
    expect(by1).toBe(ch[1]); expect(bx0).toBeLessThanOrEqual(ch[0]); expect(bx1).toBeGreaterThanOrEqual(ch[2]);
    expect(MASKS.poly.some((p) => overlaps(p, MASKS.buried[0]))).toBe(true);
    // the implant covers the channel by 1.5λ, and no pull-down
    const im = MASKS.implant[0];
    expect([ch[0] - im[0], ch[1] - im[1], im[2] - ch[2], im[3] - ch[3]]).toEqual([1.5, 1.5, 1.5, 1.5]);
    expect(overlaps(im, DEVICES.n0.ch) || overlaps(im, DEVICES.n1.ch)).toBe(false);
  });
  it('Mead–Conway: widths, overhang, the ratio of four', () => {
    for (const p of MASKS.poly) expect(Math.min(p[2] - p[0], p[3] - p[1])).toBeGreaterThanOrEqual(2);
    for (const d of MASKS.diff) expect(Math.min(d[2] - d[0], d[3] - d[1])).toBeGreaterThanOrEqual(2);
    for (const m of MASKS.metal) expect(Math.min(m[2] - m[0], m[3] - m[1])).toBeGreaterThanOrEqual(3);
    for (const c of MASKS.cut) { expect(c[2] - c[0]).toBe(2); expect(c[3] - c[1]).toBe(2); }
    // the input polys run 2λ past their diffusion on both sides
    for (const n of ['n0', 'n1'] as const) {
      const ch = DEVICES[n].ch, p = MASKS.poly.find((q) => inside(ch, q))!;
      expect(ch[0] - p[0]).toBeGreaterThanOrEqual(2); expect(p[2] - ch[2]).toBeGreaterThanOrEqual(2);
    }
    expect(wl('n0')).toEqual({ W: 4, L: 2 });
    expect(wl('ld')).toEqual({ W: 2, L: 4 });
    expect(RATIO).toBe(4);
    expect(CHANNEL.reduce((s, v) => s + v, 0)).toBe(raster(Object.values(DEVICES).map((d) => d.ch)).reduce((s, v) => s + v, 0));
    expect(CELL).toEqual({ w: 28, h: 36 });
  });
});

describe('the gate', () => {
  it('its output is NNOR2’s, and current flows exactly when it is 0', () => {
    for (const a of [false, true]) for (const b of [false, true]) {
      const s = stateOf(a, b), y = NNOR2.spec!([a ? 1 : 0, b ? 1 : 0])[0];
      expect(s.y ? 1 : 0).toBe(y);
      expect(s.current).toBe(y === 0);
    }
  });
  it('builds for every input, heights scaled by the stated factor, cut along the load, five beats', () => {
    expect(HEIGHTS.fox).toBe(V * 1);
    for (const a of [false, true]) for (const b of [false, true]) {
      const m = nmosGateModel(a, b);
      for (const it of m.items) for (const v of it.geo.positions) expect(Number.isFinite(v)).toBe(true);
      expect(m.beats).toHaveLength(5);
      expect(m.cuts!.planes[0].n).toEqual([1, 0, 0]);
    }
  });
});
