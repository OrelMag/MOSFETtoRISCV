// Reshaping wires by hand and simple connections (straight wires at any angle): breakpoints stay
// put when parts move, branches ride slanted segments, corners and segments drag, bends come out.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { resolveComponent } from '../src/lib/resolve';
import { wireFlows } from '../src/editor/flowdir';
import { branchPoint, grabOn, WireDraft } from '../src/editor/geom';
import { emptyChip, endGeom, onPolyline, polyline, type ChipDoc, type DefOf, type Vec, type WireDoc } from '../src/editor/model';
import { addPart, addPin, addWire, clearBends, dragWire, moveSel, removeBend, setStraight } from '../src/editor/ops';
import { sanitizeChip } from '../src/editor/store';
import { junctions } from '../src/view/route';

const defOf: DefOf = (p) => ('lib' in p.ref ? resolveComponent(p.ref.lib) : undefined);
const wire = (doc: ChipDoc, id: string) => doc.wires.find((w) => w.id === id)!;
const poly = (doc: ChipDoc, id: string) => polyline(doc, wire(doc, id), defOf)!;
const ortho = (pts: Vec[]) => pts.every((p, i) => i === 0 || p[0] === pts[i - 1][0] || p[1] === pts[i - 1][1]);

function ok<T extends { reason?: string }>(r: T): Exclude<T, { reason: string }> {
  expect(r.reason).toBeUndefined();
  return r as Exclude<T, { reason: string }>;
}

/** g1 (NAND at 0,0: y at 4,2) and g2 (NAND at `at`: a at at + (0,1)), wired y → a through `pts`. */
function pair(at: Vec, pts: Vec[], straight: boolean): ChipDoc {
  let doc = emptyChip('u_t', 'T');
  doc = ok(addPart(doc, { lib: 'nand' }, [0, 0])).doc;
  doc = ok(addPart(doc, { lib: 'nand' }, at)).doc;
  return ok(addWire(doc, { part: 'g1', port: 'y' }, { part: 'g2', port: 'a' }, pts, defOf, straight)).doc;
}

describe('simple connections', () => {
  it('join their breakpoints straight, at any angle, dropping points on the line', () => {
    const doc = pair([20, 10], [[10, 8]], true);
    expect(wire(doc, 'w1').straight).toBe(true);
    expect(poly(doc, 'w1')).toEqual([[4, 2], [10, 8], [20, 11]]);
    const d2 = pair([20, 10], [[8, 4], [12, 6]], true);
    expect(wire(d2, 'w1').pts).toEqual([[12, 6]]);
    // the same points on an orthogonal wire get L corners
    expect(ortho(poly(pair([20, 10], [[10, 8]], false), 'w1'))).toBe(true);
  });

  it('keep their breakpoints when a part moves: the end segments swing', () => {
    const doc = pair([20, 10], [[10, 8]], true);
    const moved = moveSel(doc, { parts: ['g2'] }, [0, 4], defOf);
    expect(wire(moved, 'w1').pts).toEqual([[10, 8]]);
    expect(poly(moved, 'w1')).toEqual([[4, 2], [10, 8], [20, 15]]);
    // both ends moved alike: the whole wire translates
    const both = moveSel(doc, { parts: ['g1', 'g2'] }, [3, 1], defOf);
    expect(wire(both, 'w1').pts).toEqual([[13, 9]]);
  });

  it('carry branches on a slanted segment, which stay on it through moves', () => {
    let doc = pair([20, 7], [], true); // (4,2) → (20,8)
    const p = poly(doc, 'w1');
    expect(branchPoint(p, [12.2, 4.9])).toEqual([12, 5]); // a grid point on the line
    const at = branchPoint(p, [8, 5]); // none near: the projection
    expect(onPolyline(p, at)).toBe(true);
    doc = ok(addPin(doc, 'out', 1, [8, 12])).doc;
    doc = ok(addWire(doc, { wire: 'w1', at }, { pin: 'pin1' }, [], defOf, true)).doc;
    for (const d of [[0, 6], [5, -3], [-2, 0]] as Vec[]) {
      const m = moveSel(doc, { parts: ['g2'] }, d, defOf);
      const b = wire(m, 'w2').a as { wire: string; at: Vec };
      expect(onPolyline(poly(m, 'w1'), b.at), `${d}`).toBe(true);
    }
    // the drawn branch gets a junction dot where it leaves the host
    const polys = new Map(doc.wires.map((w) => [w.id, polyline(doc, w, defOf)!]));
    expect(junctions([...polys.values()])).toEqual([at]);
    // and the flowing bits continue down it from the host's driver
    const f = wireFlows(doc, polys, defOf).get('w2');
    expect(f && f.whole && f.d0).toBeGreaterThan(0);
  });

  it('switch to orthogonal and back, branches following', () => {
    let doc = pair([20, 7], [[10, 8]], true);
    doc = ok(addPin(doc, 'out', 1, [6, 12])).doc;
    const at = branchPoint(poly(doc, 'w1'), [7, 5]);
    doc = ok(addWire(doc, { wire: 'w1', at }, { pin: 'pin1' }, [], defOf)).doc;
    const sq = setStraight(doc, ['w1'], false, defOf);
    expect(wire(sq, 'w1').straight).toBeUndefined();
    expect(ortho([endGeom(sq, wire(sq, 'w1').a, defOf)!.pos, ...wire(sq, 'w1').pts, endGeom(sq, wire(sq, 'w1').b, defOf)!.pos])).toBe(true);
    expect(onPolyline(poly(sq, 'w1'), (wire(sq, 'w2').a as { at: Vec }).at)).toBe(true);
    expect(wire(setStraight(sq, ['w1'], true, defOf), 'w1').straight).toBe(true);
    expect(setStraight(doc, ['w1'], true, defOf)).toBe(doc);
    expect(wire(clearBends(doc, ['w1'], defOf), 'w1').pts).toEqual([]);
  });

  it('are drawn straight from click to click', () => {
    const d = new WireDraft({ pin: 'a' }, [0, 0], 'right', true);
    d.addCorner([3, 4]);
    expect(d.preview([10, 4])).toEqual([[0, 0], [3, 4], [10, 4]]);
    d.flip(); // nothing to flip
    expect(d.corners([10, 4], 'left')).toEqual([[3, 4]]);
    d.addCorner([6, 4]);
    expect(d.corners([10, 4])).toEqual([[3, 4]]); // a breakpoint on the line is dropped
    expect(d.undo()).toBe(true);
    expect(d.pts).toEqual([[3, 4]]);
  });
});

describe('reshaping a wire', () => {
  // (4,2) → (7,2) → (7,5) → (10,5): a Z between g1.y and g2.a
  const z = () => pair([10, 4], [[7, 2], [7, 5]], false);

  it('grabs a corner within the tolerance, else the nearest segment', () => {
    const p = poly(z(), 'w1');
    expect(grabOn(p, [7.2, 2.1], 0.5)).toEqual({ corner: 1 });
    expect(grabOn(p, [7.1, 3.6], 0.5)).toEqual({ seg: 1, at: [7, 4] });
    expect(grabOn(p, [4.1, 2.1], 0.5)).toEqual({ seg: 0, at: [4, 2] }); // ends are not corners
  });

  it('slides an orthogonal segment across, growing a leg at an end', () => {
    const doc = z();
    const a = ok(dragWire(doc, 'w1', { seg: 1, at: [7, 3] }, [2, 3], defOf)).doc;
    expect(wire(a, 'w1').pts).toEqual([[9, 2], [9, 5]]);
    const b = ok(dragWire(doc, 'w1', { seg: 0, at: [5, 2] }, [1, -2], defOf)).doc;
    expect(poly(b, 'w1')).toEqual([[4, 2], [4, 0], [7, 0], [7, 5], [10, 5]]);
    const c = ok(dragWire(doc, 'w1', { corner: 1 }, [1, 1], defOf)).doc;
    expect(poly(c, 'w1')).toEqual([[4, 2], [4, 3], [8, 3], [8, 5], [10, 5]]);
    for (const d of [a, b, c]) expect(ortho([endGeom(d, wire(d, 'w1').a, defOf)!.pos, ...wire(d, 'w1').pts, endGeom(d, wire(d, 'w1').b, defOf)!.pos])).toBe(true);
    expect(dragWire(doc, 'w1', { seg: 1, at: [7, 3] }, [0, 0], defOf).doc).toBe(doc);
  });

  it('bends a straight wire where it is grabbed and moves its breakpoints freely', () => {
    const doc = pair([20, 10], [[10, 8]], true);
    const a = ok(dragWire(doc, 'w1', { seg: 0, at: [7, 5] }, [0, -3], defOf)).doc;
    expect(wire(a, 'w1').pts).toEqual([[7, 2], [10, 8]]);
    const b = ok(dragWire(doc, 'w1', { corner: 1 }, [1, 1], defOf)).doc;
    expect(wire(b, 'w1').pts).toEqual([[11, 9]]);
  });

  it('adds a bend where the wire is dragged to: a breakpoint, or an orthogonal detour through it', () => {
    const doc = z();
    const a = ok(dragWire(doc, 'w1', { bend: 0, at: [5, 2] }, [0, -2], defOf)).doc;
    expect(poly(a, 'w1')).toEqual([[4, 2], [5, 2], [5, 0], [7, 0], [7, 5], [10, 5]]);
    const b = ok(dragWire(doc, 'w1', { bend: 1, at: [7, 3] }, [2, 0], defOf)).doc;
    expect(poly(b, 'w1')).toEqual([[4, 2], [7, 2], [7, 3], [9, 3], [9, 5], [10, 5]]);
    // not moved, or only along the segment: nothing to add
    expect(dragWire(doc, 'w1', { bend: 0, at: [5, 2] }, [0, 0], defOf).doc).toBe(doc);
    expect(ok(dragWire(doc, 'w1', { bend: 0, at: [5, 2] }, [1, 0], defOf)).doc).toBe(doc);
    const s = pair([20, 10], [[10, 8]], true);
    expect(wire(ok(dragWire(s, 'w1', { bend: 0, at: [7, 5] }, [0, -3], defOf)).doc, 'w1').pts).toEqual([[7, 2], [10, 8]]);
    expect(dragWire(doc, 'w1', { bend: 3, at: [5, 2] }, [0, 1], defOf).reason).toBeTruthy();
  });

  it('moves branches with the segment they sit on', () => {
    let doc = z();
    doc = ok(addPin(doc, 'out', 1, [2, 10])).doc;
    doc = ok(addWire(doc, { wire: 'w1', at: [7, 4] }, { pin: 'pin1' }, [], defOf)).doc;
    const a = ok(dragWire(doc, 'w1', { seg: 1, at: [7, 3] }, [2, 0], defOf)).doc;
    expect((wire(a, 'w2').a as { at: Vec }).at).toEqual([9, 4]);
  });

  it('takes bends out: a breakpoint, or an orthogonal jog', () => {
    const s = pair([20, 10], [[10, 8]], true);
    expect(wire(ok(removeBend(s, 'w1', 1, defOf)).doc, 'w1').pts).toEqual([]);
    const a = ok(removeBend(z(), 'w1', 1, defOf)).doc;
    expect(poly(a, 'w1')).toEqual([[4, 2], [10, 2], [10, 5]]);
    // an L's only corner is what joins its ends
    const r = removeBend(a, 'w1', 1, defOf);
    expect(r.reason).toBeTruthy();
    expect(r.doc).toBe(a);
    expect(removeBend(a, 'w1', 0, defOf).reason).toBeTruthy();
  });
});

describe('storage', () => {
  it('keeps the straight flag and drops anything else in its place', () => {
    const doc = pair([20, 10], [[10, 8]], true);
    const back = sanitizeChip(JSON.parse(JSON.stringify(doc)))!;
    expect(back.wires[0]).toEqual(doc.wires[0]);
    const bad = sanitizeChip({ ...doc, wires: [{ ...doc.wires[0], straight: 'yes' }] })!;
    expect((bad.wires[0] as WireDoc).straight).toBeUndefined();
  });
});
