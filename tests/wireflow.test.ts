// Flowing bits: the dash patterns (view/flow.ts) and which way the sandbox's wires run (editor/flowdir.ts).

import { describe, expect, it } from 'vitest';
import { wireFlows } from '../src/editor/flowdir';
import { type ChipDoc, type DefOf, polyline, type Vec } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { B0, B1, BX, BZ, type Bit } from '../src/sim/types';
import { formatBits } from '../src/sim/values';
import { FLOW_SPEED, flowDash, flowStyle, flowText, laneTails, polyLength, slicePoly } from '../src/view/flow';
import { tagsOn, track } from '../src/view/flowtokens';
import { chip, halfAdder, pin, wire } from './editorkit';

/** Is position x (along the path, after the dash offset) inside a dash of the pattern? */
function lit(dash: number[], x: number): boolean {
  const period = dash.reduce((a, b) => a + b, 0);
  let u = ((x % period) + period) % period;
  for (let i = 0; i < dash.length; i++) {
    if (u < dash[i]) return i % 2 === 0;
    u -= dash[i];
  }
  return false;
}

describe('flowDash', () => {
  it('moves a 1, never a 0, X or Z', () => {
    expect(flowDash([B1])).not.toBeNull();
    for (const b of [B0, BX, BZ] as Bit[]) expect(flowDash([b])).toBeNull();
  });

  it('gives a bus its value to carry, and nothing for 0 or any X', () => {
    expect(flowDash([B1, B0, B1, B1])).toBeNull();
    expect(flowText([B1], 'hex')).toBeNull();
    expect(flowText([B0, B0, B0, B0], 'hex')).toBeNull();
    expect(flowText([B1, BX, B0, B0], 'hex')).toBeNull();
    expect(flowText([B1, B0, B1, B1], 'hex')).toBe('0xD');
    expect(flowText([B1, B0, B1, B1], 'bin')).toBe(formatBits([B1, B0, B1, B1], 'bin'));
    expect(flowText([B1, BZ, B0, B0], 'hex')).not.toBeNull();
  });

  it('a reversed path shows the same pattern at the same distance from the driver', () => {
    const f = flowDash([B1])!;
    const len = 7.5, d0 = 2.25;
    const fw = flowStyle(f, d0, len, false), bw = flowStyle(f, d0, len, true);
    const fwd = fw.dasharray.split(' ').map(Number), bwd = bw.dasharray.split(' ').map(Number);
    expect(bwd.length % 2).toBe(0);
    // Distance u from the driver: forwards at s = u - d0, backwards at s = len - (u - d0).
    // SVG draws position s at pattern index s + offset (samples avoid the dash edges).
    for (let u = d0 + 0.037; u < d0 + len; u += 0.1) {
      expect(lit(bwd, len - (u - d0) + bw.from)).toBe(lit(fwd, u - d0 + fw.from));
    }
  });
});

describe('lanes', () => {
  it('slices a polyline by arc length', () => {
    const p: Vec[] = [[0, 0], [4, 0], [4, 6]];
    expect(polyLength(p)).toBe(10);
    expect(slicePoly(p, 2, 7)).toEqual([[2, 0], [4, 0], [4, 3]]);
    expect(slicePoly(p, 0, 4)).toEqual([[0, 0], [4, 0]]);
  });

  it('a net\'s paths ride their shared trunk once', () => {
    const paths: Vec[][] = [
      [[0, 0], [5, 0], [5, 4], [9, 4]],
      [[0, 0], [5, 0], [5, 8], [9, 8]], // shares 0..5 and 4 down the trunk
      [[0, 0], [5, 0], [5, -3]], // shares 0..5 only
      [[0, 0], [3, 0]], // nothing new
    ];
    expect(laneTails(paths)).toEqual([
      { pts: paths[0], d0: 0, sink: true },
      { pts: [[5, 4], [5, 8], [9, 8]], d0: 9, sink: true },
      { pts: [[5, 0], [5, -3]], d0: 5, sink: true },
    ]);
  });

  it('finds the shared trunk whatever points the paths carry along it', () => {
    const paths: Vec[][] = [[[0, 0], [5, 0], [5, 4]], [[0, 0], [2, 0], [5, 0], [5, 2], [5, 4], [8, 4]]];
    expect(laneTails(paths)[1]).toEqual({ pts: [[5, 4], [8, 4]], d0: 9, sink: true });
  });
});

describe('values at a junction', () => {
  // Trunk 0..12 along x; branches leave it at x = 5 (down) and x = 9 (up).
  const lanes = laneTails([[[0, 0], [12, 0]], [[0, 0], [5, 0], [5, 6]], [[0, 0], [9, 0], [9, -4]]]);
  const tracks = lanes.map(track);
  const spacing = 7;

  it('every branch picks a value up where the trunk carries it, at full strength', () => {
    for (const j of [5, 9]) {
      const branch = tracks.find((t) => t.d0 === j)!;
      // The moment a tag on the trunk stands on the junction...
      const t = j / FLOW_SPEED;
      const onTrunk = tagsOn(tracks[0], spacing, t).find((g) => Math.abs(g.at - j) < 1e-9);
      expect(onTrunk).toMatchObject({ x: j, y: 0, op: 1 });
      // ...the branch has one there too, not faded in.
      const onBranch = tagsOn(branch, spacing, t).find((g) => Math.abs(g.at) < 1e-9);
      expect(onBranch).toMatchObject({ x: j, y: 0, op: 1 });
      // A little later both have moved on by the same distance.
      const dt = 0.5 / FLOW_SPEED;
      expect(tagsOn(tracks[0], spacing, t + dt).some((g) => Math.abs(g.at - j - 0.5) < 1e-9)).toBe(true);
      expect(tagsOn(branch, spacing, t + dt).some((g) => Math.abs(g.at - 0.5) < 1e-9)).toBe(true);
    }
  });

  it('a tag fades in at the driver and out at a sink, never at a junction', () => {
    const atStart = tagsOn(tracks[0], spacing, 0.5 / FLOW_SPEED);
    expect(atStart[0].op).toBeLessThan(1);
    const into = { ...tracks[1], sink: false };
    const nearEnd = (tr: typeof into) => tagsOn(tr, spacing, (tr.d0 + tr.len - 0.3) / FLOW_SPEED).find((g) => Math.abs(g.at - (tr.len - 0.3)) < 1e-9)!;
    expect(nearEnd(tracks[1]).op).toBeLessThan(1);
    expect(nearEnd(into).op).toBe(1);
  });
});

const defOf: DefOf = (p) => {
  const d = partDef(p.ref, () => undefined);
  return 'error' in d ? undefined : d;
};
const polysOf = (doc: ChipDoc) => new Map(doc.wires.map((w) => [w.id, polyline(doc, w, defOf)!] as [string, Vec[]]));

describe('wireFlows', () => {
  it('orients every wire of the half adder from its driver', () => {
    const doc = halfAdder();
    const f = wireFlows(doc, polysOf(doc), defOf);
    // w1 is cut where w2 branches off, but still flows whole from pin a.
    expect(f.get('w1')).toMatchObject({ whole: true, reverse: false, d0: 0 });
    expect(f.get('w2')).toMatchObject({ whole: true, reverse: false, d0: 4 });
    expect(f.get('w3')).toMatchObject({ whole: true, reverse: false, d0: 0 });
    expect(f.get('w4')).toMatchObject({ whole: true, reverse: false, d0: 6 });
    expect(f.get('w5')).toMatchObject({ whole: true, reverse: false, d0: 0 });
    // Drawn from the output pin to the gate: the signal runs from b to a.
    expect(f.get('w6')).toMatchObject({ whole: true, reverse: true, d0: 0 });
  });

  it('splits a wire entered in the middle into pieces flowing outwards', () => {
    const doc = chip('u_mid', 'Mid', {
      pins: [pin('y', 'out', [0, 0]), pin('z', 'out', [10, 0]), pin('a', 'in', [4, 5])],
      wires: [wire('w1', 'pin:y', 'pin:z'), wire('w2', 'pin:a', { wire: 'w1', at: [4, 0] })],
    });
    const f = wireFlows(doc, polysOf(doc), defOf);
    // w2 runs into w1, so its values pass on (no fade at the junction); w1's pieces end at pins.
    expect(f.get('w2')).toMatchObject({ whole: true, reverse: false, d0: 0, len: 5, sink: false });
    expect(f.get('w1')).toEqual({ whole: false, pieces: [{ pts: [[4, 0], [0, 0]], d0: 5, sink: true }, { pts: [[4, 0], [10, 0]], d0: 5, sink: true }] });
  });

  it('leaves undriven wires still, and lets a pointer stand in for a driver', () => {
    const doc = chip('u_open', 'Open', {
      pins: [pin('y', 'out', [0, 0]), pin('z', 'out', [10, 0]), pin('q', 'out', [0, 4])],
      labels: [{ id: 'l1', name: 'sig', at: [10, 4] }],
      wires: [wire('w1', 'pin:y', 'pin:z'), wire('w2', 'pin:q', 'lbl:l1')],
    });
    const f = wireFlows(doc, polysOf(doc), defOf);
    expect(f.has('w1')).toBe(false);
    expect(f.get('w2')).toMatchObject({ whole: true, reverse: true });
  });
});
