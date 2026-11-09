import { describe, expect, it } from 'vitest';
import { cutCrossings, cutWireNear, cutWires } from '../src/editor/cut';
import { segmentCrossings, wireGroups } from '../src/editor/geom';
import { type ChipDoc, endKey, onPolyline, type PartDoc, polyline, type Vec } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { chip, compileLib, halfAdder, pin, wire } from './editorkit';

const defOf = (p: PartDoc) => {
  const r = partDef(p.ref, () => undefined);
  return 'error' in r ? undefined : r;
};

/**
 * The chip's connectivity: groups of part ports and pins joined by wires, each sorted (from the drawn wires, so a group
 * nothing drives counts too). compileChip must agree wherever it keeps a net: ends of one group on one net, ends of
 * different groups on different nets.
 */
function nets(doc: ChipDoc): string[][] {
  const groups = wireGroups(doc.wires).map((ids) => [...new Set(ids.flatMap((id) => {
    const w = doc.wires.find((x) => x.id === id)!;
    return [w.a, w.b].filter((e) => !('wire' in e) && !('label' in e)).map(endKey);
  }))].sort()).filter((g) => g.length > 1).sort((a, b) => a[0].localeCompare(b[0]));
  const net = compileLib(doc).netOfEnd;
  const seen = new Map<number, number>();
  groups.forEach((g, i) => {
    const ns = new Set(g.map((k) => net.get(k)).filter((n): n is number => n !== undefined && n >= 0));
    expect(ns.size, `compileChip puts ${g.join(', ')} on one net`).toBeLessThanOrEqual(1);
    for (const n of ns) { expect(seen.get(n) ?? i, `net ${n} belongs to one group`).toBe(i); seen.set(n, i); }
  });
  return groups;
}

/** No wire end left floating: every wire draws, and every branch sits on the wire it names. */
function wellFormed(doc: ChipDoc) {
  for (const w of doc.wires) {
    expect(polyline(doc, w, defOf), `${w.id} draws`).not.toBeNull();
    for (const e of [w.a, w.b]) if ('wire' in e) {
      const host = doc.wires.find((x) => x.id === e.wire);
      expect(host, `${w.id} ends on ${e.wire}`).toBeDefined();
      expect(onPolyline(polyline(doc, host!, defOf)!, e.at), `${w.id}'s end lies on ${e.wire}`).toBe(true);
    }
  }
}

/** Every segment drawn after the cut was drawn before it (nothing moves, nothing new appears). */
function noNewInk(before: ChipDoc, after: ChipDoc) {
  const segs = (d: ChipDoc) => d.wires.flatMap((w) => { const p = polyline(d, w, defOf)!; return p.slice(1).map((q, i) => [p[i], q] as [Vec, Vec]); });
  const old = segs(before);
  const covered = ([a, b]: [Vec, Vec]) => old.some(([c, d]) => onPolyline([c, d], a) && onPolyline([c, d], b));
  for (const s of segs(after)) expect(covered(s), `segment ${JSON.stringify(s)} was drawn before`).toBe(true);
}

function cut(doc: ChipDoc, a: Vec, b: Vec) {
  const frozen = JSON.stringify(doc);
  const r = cutWires(doc, a, b, defOf);
  expect(JSON.stringify(doc), 'the input is untouched (undo restores it exactly)').toBe(frozen);
  if (!r.reason) { wellFormed(r.doc); noNewInk(doc, r.doc); }
  return r;
}

const HA_NETS = [['p:n.a', 'p:x.a', 'pin:a'], ['p:n.b', 'p:x.b', 'pin:b'], ['p:n.y', 'pin:c'], ['p:x.y', 'pin:s']];

describe('segmentCrossings', () => {
  it('finds a crossing inside the wire and none at its ends', () => {
    const poly: Vec[] = [[0, 0], [10, 0], [10, 6]];
    expect(segmentCrossings(poly, [4, -2], [4, 2])).toEqual([[4, 0]]);
    expect(segmentCrossings(poly, [8, 2], [12, 2])).toEqual([[10, 2]]);
    expect(segmentCrossings(poly, [0, -2], [0, 2])).toEqual([]); // the end, on a pin or a port
    expect(segmentCrossings(poly, [9, -1], [11, 1])).toEqual([[10, 0]]); // a bend, counted once
    expect(segmentCrossings(poly, [2, 0], [6, 0])).toEqual([]); // running along it
    expect(segmentCrossings(poly, [4, 1], [4, 2])).toEqual([]); // short of it
  });
});

describe('the Cut tool', () => {
  it('starts from the half adder as compiled', () => {
    expect(nets(halfAdder())).toEqual(HA_NETS);
  });

  it('removes a plain wire', () => {
    const r = cut(halfAdder(), [16, 1], [16, 5]); // across w5, x.y → s
    expect(r.cut).toBe(1);
    expect(r.doc.wires.map((w) => w.id)).not.toContain('w5');
    expect(nets(r.doc)).toEqual(HA_NETS.filter((g) => !g.includes('pin:s')));
  });

  it('cuts a T on the arm to the pin: the other two arms stay joined', () => {
    const r = cut(halfAdder(), [2, 1], [2, 3]); // w1 between pin a and the junction at (4, 2)
    expect(nets(r.doc)).toEqual([['p:n.a', 'p:x.a'], ['p:n.b', 'p:x.b', 'pin:b'], ['p:n.y', 'pin:c'], ['p:x.y', 'pin:s']]);
    expect(r.doc.wires.some((w) => w.id === 'w1')).toBe(false); // the trunk went into the branch w2
  });

  it('cuts a T on the arm to the gate: the pin keeps the branch', () => {
    const r = cut(halfAdder(), [6, 1], [6, 3]); // w1 between the junction and x.a
    expect(nets(r.doc)).toEqual([['p:n.a', 'pin:a'], ['p:n.b', 'p:x.b', 'pin:b'], ['p:n.y', 'pin:c'], ['p:x.y', 'pin:s']]);
  });

  it('cuts a T on the branch itself: only the branch goes', () => {
    const r = cut(halfAdder(), [3, 5], [5, 5]); // w2's vertical leg
    expect(r.doc.wires.map((w) => w.id)).toEqual(['w1', 'w3', 'w4', 'w5', 'w6']);
    expect(nets(r.doc)).toEqual([['p:n.b', 'p:x.b', 'pin:b'], ['p:n.y', 'pin:c'], ['p:x.a', 'pin:a'], ['p:x.y', 'pin:s']]);
  });

  it('cuts through a bend', () => {
    const r = cut(halfAdder(), [5, 3], [7, 5]); // w3's corner at (6, 4), past the junction at (6, 6)
    expect(nets(r.doc)).toEqual([['p:n.a', 'p:x.a', 'pin:a'], ['p:n.b', 'pin:b'], ['p:n.y', 'pin:c'], ['p:x.y', 'pin:s']]);
  });

  it('splits a bus with four branches and keeps both sides', () => {
    const doc = chip('u_bus', 'bus', {
      pins: [pin('i', 'in', [0, 0]), pin('o0', 'out', [20, 0]), ...[1, 2, 3, 4].map((k) => pin(`o${k}`, 'out', [4 * k, 6]))],
      wires: [wire('t', 'pin:i', 'pin:o0'), ...[1, 2, 3, 4].map((k) => wire(`b${k}`, { wire: 't', at: [4 * k, 0] }, `pin:o${k}`))],
    });
    expect(nets(doc)).toEqual([['pin:i', 'pin:o0', 'pin:o1', 'pin:o2', 'pin:o3', 'pin:o4']]);
    const r = cut(doc, [10, -2], [10, 2]);
    expect(nets(r.doc)).toEqual([['pin:i', 'pin:o1', 'pin:o2'], ['pin:o0', 'pin:o3', 'pin:o4']]);
    expect(r.doc.wires.map((w) => w.id).sort()).toEqual(['b1', 'b2', 'b3', 'b4']); // the trunk went into b2 and b3
    // one line across the trunk and two branches: three cuts, and the cut branches go alone
    const r3 = cut(doc, [9, -2], [17, 6]);
    expect(r3.cut).toBe(3);
    expect(nets(r3.doc)).toEqual([['pin:i', 'pin:o1', 'pin:o2']]);
  });

  it('does nothing when the line only touches a pin or crosses nothing', () => {
    const doc = halfAdder();
    expect(cut(doc, [0, 0], [0, 4]).reason).toBeTruthy(); // through pin a's own point, the end of w1
    expect(cut(doc, [30, 0], [30, 9]).reason).toBeTruthy();
    expect(cutCrossings(doc, [30, 0], [30, 9], defOf).size).toBe(0);
  });

  it('a click cuts the wire at the nearest point; a junction is refused', () => {
    const r = cutWireNear(halfAdder(), 'w5', [15, 3.4], defOf);
    expect(r.reason).toBeUndefined();
    expect(nets(r.doc)).toEqual(HA_NETS.filter((g) => !g.includes('pin:s')));
    expect(cutWireNear(halfAdder(), 'w1', [4, 2], defOf).reason).toMatch(/junction/);
  });
});
