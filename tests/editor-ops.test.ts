// Document edits: wires stay orthogonal when their ends move, branch points ride on their wire,
// deletes cascade, paste re-ids, and refusals leave the document untouched.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { lcg } from './util';
import { resolveComponent } from '../src/lib/resolve';
import { emptyChip, endGeom, onPolyline, polyline, type ChipDoc, type DefOf, type Vec, type WireDoc } from '../src/editor/model';
import {
  addLabel, addPart, addPin, addWire, boxSelect, copySel, deleteSel, duplicate, flipParts, moveSel, pasteClip,
  selectAll, setLabel, setPart, setPin, setRef, setWire, wouldCycle,
} from '../src/editor/ops';

const defOf: DefOf = (p) => ('lib' in p.ref ? resolveComponent(p.ref.lib) : undefined);

/** Every step of [a, ...corners, b] is horizontal or vertical, with no repair by polyline(). */
function rawOrtho(doc: ChipDoc, w: WireDoc): boolean {
  const pa = endGeom(doc, w.a, defOf)!.pos, pb = endGeom(doc, w.b, defOf)!.pos;
  const pts = [pa, ...w.pts, pb];
  return pts.every((p, i) => i === 0 || p[0] === pts[i - 1][0] || p[1] === pts[i - 1][1]);
}
const wire = (doc: ChipDoc, id: string) => doc.wires.find((w) => w.id === id)!;
const allOrtho = (doc: ChipDoc) => doc.wires.every((w) => rawOrtho(doc, w));

function ok<T extends { reason?: string }>(r: T): Exclude<T, { reason: string }> {
  expect(r.reason).toBeUndefined();
  return r as Exclude<T, { reason: string }>;
}

/**
 * g1 (NAND at 0,0: a 0,1  b 0,3  y 4,2) drives g2 (NAND at 10,0: a 10,1) through a Z (w1);
 * w2 branches off w1 at (5,2) down to pin out1 at (5,8); in1 (at -5,1) feeds g1.a straight (w3).
 */
function fixture() {
  let doc = emptyChip('u_t', 'T');
  doc = ok(addPart(doc, { lib: 'nand' }, [0, 0])).doc;
  doc = ok(addPart(doc, { lib: 'nand' }, [10, 0])).doc;
  doc = ok(addPin(doc, 'out', 1, [5, 8])).doc;
  doc = ok(addPin(doc, 'in', 1, [-5, 1])).doc;
  doc = ok(addWire(doc, { part: 'g1', port: 'y' }, { part: 'g2', port: 'a' }, [[7, 2], [7, 1]], defOf)).doc;
  doc = ok(addWire(doc, { wire: 'w1', at: [5, 2] }, { pin: 'pin1' }, [], defOf)).doc;
  doc = ok(addWire(doc, { pin: 'pin2' }, { part: 'g1', port: 'a' }, [], defOf)).doc;
  return doc;
}

describe('add', () => {
  it('names parts and pins per kind', () => {
    const doc = fixture();
    expect(doc.parts.map((p) => p.id)).toEqual(['g1', 'g2']);
    expect(doc.pins.map((p) => [p.id, p.name])).toEqual([['pin1', 'out1'], ['pin2', 'in1']]);
    expect(doc.wires.map((w) => w.id)).toEqual(['w1', 'w2', 'w3']);
    expect(ok(addPart(doc, { split: [1, 1] }, [0, 0])).id).toBe('s1');
    expect(ok(addPart(doc, { rom: { k: 2, w: 8, addr: 'word', lang: 'hex', src: '' } }, [0, 0])).id).toBe('rom1');
    expect(ok(addPart(doc, { chip: 'u_x' }, [0, 0])).id).toBe('u1');
    expect(ok(addLabel(doc, ' clk ', [0, 0])).doc.labels[0]).toEqual({ id: 'l1', name: 'clk', at: [0, 0] });
  });

  it('refuses bad parts and pins without touching the document', () => {
    const doc = fixture();
    expect(addPart(doc, { chip: 'u_t' }, [0, 0])).toEqual({ doc, reason: expect.any(String) });
    expect(addPart(doc, { lib: 'not' }, [0, 0], 'g1').reason).toMatch(/already/);
    expect(addPart(doc, { lib: 'not' }, [0, 0], '1x').reason).toMatch(/valid/);
    expect(addPin(doc, 'in', 1, [0, 0], 'in1').reason).toMatch(/already/);
    expect(addPin(doc, 'in', 0, [0, 0]).reason).toMatch(/width/);
  });

  it('normalizes corners and refuses degenerate wires', () => {
    let doc = fixture();
    // Diagonal step gets an L, duplicates and collinear corners go.
    const r = ok(addWire(doc, { pin: 'pin2' }, { part: 'g1', port: 'b' }, [[-3, 1], [-3, 1], [-3, 2], [-3, 3]], defOf));
    expect(wire(r.doc, r.id).pts).toEqual([[-3, 1], [-3, 3]]);
    const l = ok(addWire(doc, { pin: 'pin2' }, { part: 'g1', port: 'b' }, [[-2, 3]], defOf));
    expect(wire(l.doc, l.id).pts).toEqual([[-2, 1], [-2, 3]]);
    expect(addWire(doc, { pin: 'pin1' }, { pin: 'pin1' }, []).reason).toMatch(/same/);
    expect(addWire(doc, { pin: 'pin1' }, { pin: 'nope' }, []).reason).toMatch(/exist/);
    expect(addWire(doc, { pin: 'pin1' }, { part: 'g1', port: 'zz' }, [], defOf).reason).toMatch(/port/);
    expect(addWire(doc, { pin: 'pin1' }, { wire: 'w1', at: [6, 6] }, [], defOf).reason).toMatch(/not on/);
    doc = ok(addPin(doc, 'in', 1, [5, 8])).doc; // on top of out1
    const z = addWire(doc, { pin: 'pin1' }, { pin: 'pin3' }, [[5, 8]]);
    expect(z.reason).toMatch(/length/);
    expect(z.doc).toBe(doc);
  });

  it('detects chips that would contain themselves', () => {
    const a = { ...emptyChip('u_a', 'A'), parts: [{ id: 'u1', ref: { chip: 'u_b' }, at: [0, 0] as Vec }] };
    const b = { ...emptyChip('u_b', 'B'), parts: [{ id: 'u1', ref: { chip: 'u_c' }, at: [0, 0] as Vec }] };
    const ws = { schema: 1 as const, chips: { u_a: a, u_b: b, u_c: emptyChip('u_c', 'C') }, open: [] };
    expect(wouldCycle(ws, 'u_c', 'u_a')).toBe(true);
    expect(wouldCycle(ws, 'u_a', 'u_c')).toBe(false);
    expect(wouldCycle(ws, 'u_a', 'u_a')).toBe(true);
  });
});

describe('moveSel', () => {
  it('slides the corner next to a moved end', () => {
    const doc = fixture();
    const before = structuredClone(doc);
    const m = moveSel(doc, { parts: ['g2'] }, [0, 5], defOf);
    expect(doc).toEqual(before); // input untouched
    expect(wire(m, 'w1').pts).toEqual([[7, 2], [7, 6]]);
    expect(allOrtho(m)).toBe(true);
    expect(wire(m, 'w3')).toBe(wire(doc, 'w3')); // unrelated wires are shared, not copied
    expect(wire(m, 'w2')).toBe(wire(doc, 'w2')); // the branch's segment did not move
  });

  it('bends a straight wire into a Z when one end leaves the line', () => {
    const m = moveSel(fixture(), { parts: ['g1'] }, [0, 4], defOf);
    expect(wire(m, 'w3').pts).toEqual([[-2, 1], [-2, 5]]);
    expect(allOrtho(m)).toBe(true);
    // Sliding along the line needs no corner.
    expect(wire(moveSel(fixture(), { pins: ['pin2'] }, [-3, 0], defOf), 'w3').pts).toEqual([]);
  });

  it('carries branch points with the segment they sit on', () => {
    const m = moveSel(fixture(), { parts: ['g1'] }, [0, 3], defOf);
    expect(wire(m, 'w1').pts).toEqual([[7, 5], [7, 1]]);
    const w2 = wire(m, 'w2');
    expect(w2.a).toEqual({ wire: 'w1', at: [5, 5] });
    expect(onPolyline(polyline(m, wire(m, 'w1'), defOf)!, [5, 5])).toBe(true);
    expect(allOrtho(m)).toBe(true);
  });

  it('translates whole wires when everything moves', () => {
    const doc = fixture();
    const m = moveSel(doc, selectAll(doc), [3, 3], defOf);
    expect(wire(m, 'w1').pts).toEqual([[10, 5], [10, 4]]);
    expect(wire(m, 'w2').a).toEqual({ wire: 'w1', at: [8, 5] });
    expect(allOrtho(m)).toBe(true);
    expect(moveSel(doc, selectAll(doc), [0, 0], defOf)).toBe(doc);
  });

  it('drags a selected wire between fixed ends', () => {
    const m = moveSel(fixture(), { wires: ['w1'] }, [2, 0], defOf);
    expect(wire(m, 'w1').pts).toEqual([[9, 2], [9, 1]]);
    expect(wire(m, 'w2').a).toEqual({ wire: 'w1', at: [5, 2] });
    expect(allOrtho(m)).toBe(true);
  });

  it('re-projects a branch point when its wire changes shape', () => {
    const m = ok(setWire(fixture(), 'w1', { pts: [[4, 6], [10, 6]] }, defOf)).doc;
    const at = (wire(m, 'w2').a as { at: Vec }).at;
    expect(onPolyline(polyline(m, wire(m, 'w1'), defOf)!, at)).toBe(true);
    expect(at).toEqual([4, 2]);
    expect(allOrtho(m)).toBe(true);
  });

  it('keeps wires orthogonal through flips', () => {
    const m = flipParts(fixture(), ['g1', 'g2'], defOf);
    expect(m.parts.every((p) => p.flip)).toBe(true);
    expect(allOrtho(m)).toBe(true);
    expect(flipParts(m, ['g1', 'g2'], defOf).parts.every((p) => !('flip' in p))).toBe(true);
  });
});

describe('moveSel, randomized', () => {
  it('keeps every wire orthogonal and every branch on its wire', () => {
    const rnd = lcg(99);
    let doc = fixture();
    doc = ok(addWire(doc, { wire: 'w2', at: [5, 6] }, { part: 'g2', port: 'b' }, [[8, 6], [8, 3]], defOf)).doc;
    doc = ok(addWire(doc, { wire: 'w3', at: [-3, 1] }, { part: 'g1', port: 'b' }, [[-3, 3]], defOf)).doc;
    const pick = (ids: string[]) => ids.filter(() => rnd(3) === 0);
    for (let i = 0; i < 300; i++) {
      const sel = { parts: pick(doc.parts.map((p) => p.id)), pins: pick(doc.pins.map((p) => p.id)), wires: pick(doc.wires.map((w) => w.id)) };
      doc = moveSel(doc, sel, [rnd(9) - 4, rnd(9) - 4], defOf);
      expect(allOrtho(doc), `step ${i}`).toBe(true);
      for (const w of doc.wires) for (const e of [w.a, w.b]) {
        if ('wire' in e) expect(onPolyline(polyline(doc, wire(doc, e.wire), defOf)!, e.at), `step ${i} ${w.id}`).toBe(true);
      }
    }
  });
});

describe('deleteSel', () => {
  it('cascades to attached wires and their branches', () => {
    const doc = fixture();
    const d = deleteSel(doc, { parts: ['g1'] });
    expect(d.parts.map((p) => p.id)).toEqual(['g2']);
    expect(d.wires.map((w) => w.id)).toEqual([]); // w1, w3 end on g1; w2 branches from w1
    expect(deleteSel(doc, { wires: ['w1'] }).wires.map((w) => w.id)).toEqual(['w3']);
    expect(deleteSel(doc, { pins: ['pin1'] }).wires.map((w) => w.id)).toEqual(['w1', 'w3']);
    expect(deleteSel(doc, {})).toBe(doc);
  });
});

describe('set*', () => {
  it('refuses a duplicate pin name', () => {
    const doc = fixture();
    expect(setPin(doc, 'pin1', { name: 'in1' })).toEqual({ doc, reason: expect.stringMatching(/already/) });
    expect(setPin(doc, 'pin1', { name: 'out1' }).reason).toBeUndefined(); // its own name
    expect(ok(setPin(doc, 'pin1', { name: 'sum' })).doc.pins[0].name).toBe('sum');
  });

  it('keeps wires to ports a new ref lacks, so changing back restores them', () => {
    const doc = fixture();
    const b = ok(addWire(doc, { pin: 'pin2' }, { part: 'g2', port: 'b' }, [[-5, 3]], defOf));
    const not = ok(setRef(b.doc, 'g2', { lib: 'not' }, defOf)).doc;
    expect(not.wires.map((w) => w.id)).toEqual(b.doc.wires.map((w) => w.id));
    const back = ok(setRef(not, 'g2', { lib: 'nand' }, defOf)).doc;
    expect(wire(back, b.id)).toEqual(wire(b.doc, b.id));
    expect(allOrtho(back)).toBe(true);
  });

  it('renames a part and the wire ends on it', () => {
    const doc = fixture();
    const r = ok(setPart(doc, 'g1', { id: 'gate1' }, defOf)).doc;
    expect(r.parts[0].id).toBe('gate1');
    expect(wire(r, 'w1').a).toEqual({ part: 'gate1', port: 'y' });
    expect(wire(r, 'w3').b).toEqual({ part: 'gate1', port: 'a' });
    expect(wire(r, 'w1').pts).toEqual(wire(doc, 'w1').pts);
    expect(setPart(doc, 'g1', { id: 'g2' }).reason).toMatch(/already/);
    expect(setPart(doc, 'g1', { id: 'in1' }).reason).toMatch(/already/); // pin names share the scope
  });

  it('edits pointers', () => {
    const doc = ok(addLabel(fixture(), 'clk', [20, 20])).doc;
    expect(setLabel(doc, 'l1', { name: '  ' }).reason).toMatch(/name/);
    expect(ok(setLabel(doc, 'l1', { name: 'rst', face: 'up' })).doc.labels[0]).toEqual({ id: 'l1', name: 'rst', at: [20, 20], face: 'up' });
  });
});

describe('clipboard', () => {
  it('re-ids everything and remaps internal references', () => {
    const doc = fixture();
    const clip = copySel(doc, { parts: ['g1', 'g2'], pins: ['pin1'] });
    expect(clip.wires.map((w) => w.id)).toEqual(['w1', 'w2']); // w3 leaves the selection
    const { doc: p, sel } = pasteClip(doc, clip, [0, 20]);
    expect(sel).toEqual({ parts: ['g3', 'g4'], pins: ['pin3'], labels: [], wires: ['w4', 'w5'] });
    expect(p.pins.find((x) => x.id === 'pin3')!.name).toBe('out2');
    expect(wire(p, 'w4')).toEqual({ id: 'w4', a: { part: 'g3', port: 'y' }, b: { part: 'g4', port: 'a' }, pts: [[7, 22], [7, 21]] });
    expect(wire(p, 'w5')).toEqual({ id: 'w5', a: { wire: 'w4', at: [5, 22] }, b: { pin: 'pin3' }, pts: [] });
    expect(allOrtho(p)).toBe(true);
    // The original is untouched and shared.
    expect(p.wires.slice(0, 3)).toEqual(doc.wires);
    expect(p.wires[0]).toBe(doc.wires[0]);
  });

  it('copies only wires with both ends inside', () => {
    expect(copySel(fixture(), { parts: ['g1'] }).wires).toEqual([]);
  });

  it('duplicates custom names with a suffix and keeps pointer names', () => {
    let doc = ok(setPin(fixture(), 'pin1', { name: 'sum' })).doc;
    doc = ok(addLabel(doc, 'clk', [20, 20])).doc;
    const r = duplicate(doc, { pins: ['pin1'], labels: ['l1'] }, [2, 2]);
    expect(r.doc.pins.at(-1)!.name).toBe('sum_2');
    expect(r.doc.labels.at(-1)).toEqual({ id: 'l2', name: 'clk', at: [22, 22] });
  });

  it('drops parts that would put the chip inside itself', () => {
    const doc = fixture();
    const clip = { parts: [{ id: 'u1', ref: { chip: 'u_t' }, at: [0, 0] as Vec }], pins: [], labels: [], wires: [] };
    expect(pasteClip(doc, clip, [0, 0]).sel.parts).toEqual([]);
  });
});

describe('selection', () => {
  it('box-selects by symbol box, point and whole polyline', () => {
    const doc = fixture();
    expect(boxSelect(doc, [[5, 5], [-1, -1]], defOf)).toEqual({ parts: ['g1'], pins: [], wires: [], labels: [] });
    expect(boxSelect(doc, [[-1, -1], [3, 5]], defOf).parts).toEqual([]); // g1 is 4 wide
    expect(boxSelect(doc, [[-6, -1], [15, 9]], defOf)).toEqual(selectAll(doc));
    expect(boxSelect(doc, [[4, 1], [10, 9]], defOf)).toEqual({ parts: [], pins: ['pin1'], wires: ['w1', 'w2'], labels: [] });
  });
});
