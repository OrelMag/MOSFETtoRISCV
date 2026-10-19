// Turned parts (R in the sandbox): one transform for ports, boxes, hit tests and drawing, so a turned part's wires
// meet its drawn ports; a turned box laid out again on its new sides has the same geometry; four turns are none.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { resolveComponent } from '../src/lib/resolve';
import { instPort, isBoxKind, orientExit, orientGeom, orientedBox, type Rot, symbolGeom } from '../src/sim/geometry';
import type { ComponentDef } from '../src/sim/types';
import { boxText, portTextRect } from '../src/view/boxtext';
import { emptyChip, endGeom, polyline, type ChipDoc, type DefOf } from '../src/editor/model';
import { addPart, addPin, addWire, flipParts, rotateParts } from '../src/editor/ops';
import { partBox } from '../src/editor/geom';
import { sanitizeChip } from '../src/editor/store';
import { compileChip } from '../src/editor/compile';
import { partDef } from '../src/editor/parts';
import { canTurn } from '../src/editor/face';

const defOf: DefOf = (p) => ('lib' in p.ref ? resolveComponent(p.ref.lib) : undefined);
const ORIENTS: [boolean, Rot][] = [false, true].flatMap((f) => ([0, 1, 2, 3] as Rot[]).map((r): [boolean, Rot] => [f, r]));
const defs = (): ComponentDef[] => [...registry.values()].filter((d) => d.ports.length && d.ports.every((p) => symbolGeom(d).ports[p.name]));

describe('orientGeom', () => {
  it('keeps every port on its turned box and turns exits with it, for every registered symbol', () => {
    for (const d of defs()) {
      const g = symbolGeom(d);
      for (const [f, r] of ORIENTS) {
        const o = orientGeom(d, f, r);
        expect([o.w, o.h]).toEqual(r % 2 ? [g.h, g.w] : [g.w, g.h]);
        for (const [n, p] of Object.entries(o.ports)) {
          const q = g.ports[n];
          // a port on an edge stays on the matching edge of the turned box
          const edge = (x: number, y: number, w: number, h: number, e: string) =>
            e === 'left' ? x === 0 : e === 'right' ? x === w : e === 'up' ? y === 0 : y === h;
          if (edge(q.pos[0], q.pos[1], g.w, g.h, q.exit)) expect(edge(p.pos[0], p.pos[1], o.w, o.h, p.exit), `${d.id} ${n} ${f} ${r}`).toBe(true);
        }
      }
    }
  });

  it('a quarter turn four times is no turn; a mirror twice is none', () => {
    for (const e of ['left', 'right', 'up', 'down'] as const) {
      let x: typeof e = e;
      for (let i = 0; i < 4; i++) x = orientExit(x, false, 1) as typeof e;
      expect(x).toBe(e);
      expect(orientExit(orientExit(e, true, 0), true, 0)).toBe(e);
    }
    expect(orientExit('right', false, 1)).toBe('down');
    expect(orientExit('right', true, 1)).toBe('up');
  });

  it('a turned box drawn upright (orientedBox) has the same geometry', () => {
    for (const d of defs().filter(isBoxKind)) {
      for (const [f, r] of ORIENTS) {
        if (!f && !r) continue;
        const o = orientGeom(d, f, r), b = symbolGeom(orientedBox(d, f, r));
        expect([b.w, b.h], d.id).toEqual([o.w, o.h]);
        for (const [n, p] of Object.entries(o.ports)) {
          expect(b.ports[n].pos[0], `${d.id} ${n}`).toBeCloseTo(p.pos[0], 9);
          expect(b.ports[n].pos[1], `${d.id} ${n}`).toBeCloseTo(p.pos[1], 9);
          expect(b.ports[n].exit, `${d.id} ${n}`).toBe(p.exit);
        }
      }
    }
  });

  it("a quarter-turned box's top and bottom names run across, inside the box", () => {
    const d = resolveComponent('full_adder')!;
    const t = boxText(orientedBox(d, false, 1));
    const g = orientGeom(d, false, 1);
    const across = t.ports.filter((p) => p.across);
    expect(across.length).toBe(d.ports.filter((p) => (p.side ?? 'left') === 'left' || p.side === 'right').length);
    for (const p of across) {
      const r = portTextRect(p);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.y + r.h).toBeLessThanOrEqual(g.h);
    }
  });
});

/** in1 → g1.a, g1.y → out1: a NAND between two pins. */
function fixture(): ChipDoc {
  let doc = emptyChip('u_t', 'T');
  doc = addPart(doc, { lib: 'nand' }, [0, 0]).doc;
  doc = addPin(doc, 'in', 1, [-6, 1]).doc;
  doc = addPin(doc, 'out', 1, [10, 2]).doc;
  doc = addWire(doc, { pin: 'pin1' }, { part: 'g1', port: 'a' }, [], defOf).doc;
  doc = addWire(doc, { part: 'g1', port: 'y' }, { pin: 'pin2' }, [], defOf).doc;
  return doc;
}

const onGrid = (v: number) => Math.abs(v - Math.round(v)) < 1e-9;

describe('rotateParts', () => {
  it('turns a part about its middle, its ports on the grid and its wires on its ports; four turns put it back', () => {
    const doc0 = fixture();
    let doc = doc0;
    const box0 = partBox(defOf(doc0.parts[0]), doc0.parts[0].at);
    for (let i = 1; i <= 4; i++) {
      doc = rotateParts(doc, ['g1'], 1, defOf);
      const p = doc.parts[0], d = defOf(p)!;
      expect(p.rot).toBe(i % 4 || undefined);
      const b = partBox(d, p.at, p.flip, p.rot);
      expect(Math.abs(b.x + b.w / 2 - (box0.x + box0.w / 2))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(b.y + b.h / 2 - (box0.y + box0.h / 2))).toBeLessThanOrEqual(0.5);
      for (const port of d.ports) {
        const g = instPort(d, p.at, p.flip, port.name, p.rot);
        expect(onGrid(g.pos[0]) && onGrid(g.pos[1])).toBe(true);
      }
      for (const w of doc.wires) {
        const poly = polyline(doc, w, defOf)!;
        expect(poly[0]).toEqual(endGeom(doc, w.a, defOf)!.pos);
        expect(poly[poly.length - 1]).toEqual(endGeom(doc, w.b, defOf)!.pos);
      }
    }
    expect(doc.parts[0]).toEqual(doc0.parts[0]);
    expect(rotateParts(doc0, ['g1'], 3, defOf).parts[0].rot).toBe(3);
  });

  it('F mirrors a turned part as shown: its ports swap across the turned box', () => {
    const doc = rotateParts(fixture(), ['g1'], 1, defOf);
    const p = doc.parts[0], d = defOf(p)!;
    const m = flipParts(doc, ['g1'], defOf).parts[0];
    expect(m.flip).toBe(true);
    expect(m.rot).toBe(3);
    const o = orientGeom(d, p.flip, p.rot);
    for (const port of d.ports) {
      const a = instPort(d, p.at, p.flip, port.name, p.rot), b = instPort(d, m.at, m.flip, port.name, m.rot);
      expect(b.pos).toEqual([2 * p.at[0] + o.w - a.pos[0], a.pos[1]]);
    }
    // a half turn mirrored stays a half turn
    expect(flipParts(rotateParts(fixture(), ['g1'], 2, defOf), ['g1'], defOf).parts[0].rot).toBe(2);
  });

  it('a mux, a splitter and a box turn the same way', () => {
    let doc = emptyChip('u_t', 'T');
    doc = addPart(doc, { lib: 'mux2' }, [0, 0]).doc;
    doc = addPart(doc, { split: [4, 4] }, [10, 0]).doc;
    doc = addPart(doc, { lib: 'full_adder' }, [20, 0]).doc;
    const dOf: DefOf = (p) => { const r = partDef(p.ref, () => undefined); return 'error' in r ? undefined : r; };
    const t = rotateParts(doc, doc.parts.map((p) => p.id), 1, dOf);
    for (const p of t.parts) {
      const d = dOf(p)!;
      for (const port of d.ports) {
        const g = instPort(d, p.at, p.flip, port.name, p.rot);
        expect(onGrid(g.pos[0] * 2) && onGrid(g.pos[1] * 2), `${p.id}.${port.name}`).toBe(true);
      }
    }
  });
});

describe('a turned part is kept', () => {
  it('by the store, which drops a turn that is not one', () => {
    const doc = rotateParts(fixture(), ['g1'], 1, defOf);
    expect(sanitizeChip(JSON.parse(JSON.stringify(doc)))!.parts[0].rot).toBe(1);
    expect(sanitizeChip({ id: 'u_x', parts: [{ id: 'g1', ref: { lib: 'nand' }, at: [0, 0], rot: 4 }] })!.parts[0].rot).toBeUndefined();
    expect(sanitizeChip({ id: 'u_x', parts: [{ id: 'g1', ref: { lib: 'nand' }, at: [0, 0], rot: '1' }] })!.parts[0].rot).toBeUndefined();
  });

  it('by compile, so look inside draws it turned', () => {
    const doc = rotateParts(fixture(), ['g1'], 2, defOf);
    const c = compileChip(doc, (r) => partDef(r, () => undefined));
    const nl = c.def.netlist!();
    expect(nl.instances.find((i) => i.name === 'g1')!.rot).toBe(2);
  });
});

describe('canTurn', () => {
  it('turns gates, boxes and wiring, not displays or I/O parts', () => {
    const d = (ref: Parameters<typeof partDef>[0]) => { const r = partDef(ref, () => undefined); return 'error' in r ? undefined : r; };
    expect(canTurn({ lib: 'nand' }, d({ lib: 'nand' }))).toBe(true);
    expect(canTurn({ split: [2, 2] }, d({ split: [2, 2] }))).toBe(true);
    expect(canTurn({ display: 'led' }, d({ display: 'led' }))).toBe(false);
  });
});
