// The studio relay posed by phys/relay.ts: the armature's swing, the residual stud's gap, the blade's bend and the
// contacts' states, and the labels that ride the moved parts.
import { describe, expect, it } from 'vitest';
import { anchorAt, applyMat, boundsOfNamed, itemMatrix } from '../src/gl/kit/scene';
import { RELAY, RELAY_SUPPLY, relaySim } from '../src/phys/relay';
import { AT_CONTACT, EXAG, HINGE, POLE_AX, POLE_R, XC, XT, YB, ncClosed, push } from '../src/widgets/relay3dgeom';
import { bendBlade, bladeLine, relayModel, relayPose } from '../src/widgets/relay3dkit';

const run = relaySim(RELAY_SUPPLY);
const open = run.s[0], closed = run.s[100];
const model = (q = closed) => relayModel({ detail: 'full', i: q.i, nc: ncClosed(q), no: q.closed });

describe('the studio relay posed by the lumped model', () => {
  it('turns the armature so the residual stud stands the drawn gap above the pole face', () => {
    const hs = RELAY.gRes * 1e3 * EXAG + 0.05, foot: [number, number, number] = [HINGE[0] + POLE_AX, HINGE[1] - hs, 0];
    for (const q of [open, closed]) {
      const y = applyMat(relayPose(q).get('armature')!, foot)[1];
      // the pole face is at y = 25: the stud's foot hangs above it by the gap still open, drawn ×EXAG
      expect(y - 25).toBeCloseTo((RELAY.gOpen - q.x) * 1e3 * EXAG - 0.05, 0);
    }
  });

  it('bends the blade: its tip under the stud and its contact where the model puts them', () => {
    for (const q of [open, closed, run.s[70]]) {
      const line = bladeLine(q), at = (x: number) => line.reduce((a, p) => (Math.abs(p[0] - x) < Math.abs(a[0] - x) ? p : a));
      expect(at(XT)[1]).toBeCloseTo(YB - push(q.x), 6);
      expect(at(XC)[1]).toBeCloseTo(YB - push(q.y) * AT_CONTACT, 6);
    }
    expect(bladeLine(open).length).toBe(bladeLine(closed).length);
  });

  it('refreshes the blade in place (same buffers, a new revision)', () => {
    const blade = model().items.find((i) => i.name === 'common blade')!.geo, n = blade.positions.length, rev = blade.rev ?? 0;
    bendBlade('full', closed);
    expect(blade.positions.length).toBe(n);
    expect(blade.rev).toBe(rev + 1);
  });

  it('lights the contact that is closed', () => {
    const glow = (m: ReturnType<typeof model>, name: string) => (m.items.find((i) => i.name === name)!.mat.glow ?? 0) > 0;
    expect(glow(model(closed), 'NO contact')).toBe(true);
    expect(glow(model(closed), 'NC contact')).toBe(false);
    expect(glow(model(open), 'NC contact')).toBe(true);
  });

  it('draws the pole face at the model\'s area', () => {
    expect(Math.PI * POLE_R * POLE_R).toBeCloseTo(RELAY.A * 1e6, -1);
    const b = boundsOfNamed(model(), ['pole face']);
    expect(b.max[0] - b.min[0]).toBeCloseTo(2 * POLE_R, 1);
  });

  it('carries the armature\'s label with the armature', () => {
    const m = model(), a = m.anchors!.find((x) => x.text === 'armature')!;
    const pOpen = anchorAt(m, a, 0, relayPose(open)), pClosed = anchorAt(m, a, 0, relayPose(closed));
    expect(pOpen[1] - pClosed[1]).toBeGreaterThan(2); // the armature's middle drops as it closes
    // and its item moves by the same matrix
    const arm = m.items.find((i) => i.name === 'armature')!, M = itemMatrix(arm, 0, undefined, relayPose(closed));
    applyMat(M, a.p).forEach((v, k) => expect(v).toBeCloseTo(pClosed[k], 4));
  });
});
