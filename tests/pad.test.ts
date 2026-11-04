// Chapter 41's I/O pad on the switch-level solver: it drives the pin while enabled, lets go otherwise, reads what is on the wire,
// and two pads that disagree are a short.

import { describe, expect, it } from 'vitest';
import { ioPad, IO_PAD, PAD_CHAIN, PAD_FINAL, PAD_LINK, padDriveOhms } from '../src/lib/pad';
import { flatten } from '../src/sim/flatten';
import { SwitchSim } from '../src/sim/switchsim';
import { B0, B1, BZ } from '../src/sim/types';
import { stats } from '../src/sim/stats';

function run(def: Parameters<typeof flatten>[0]) {
  const s = new SwitchSim(flatten(def, { mode: 'switch' }));
  const set = (v: Record<string, number>) => { for (const [k, x] of Object.entries(v)) s.setInput(k, x); s.settle(); };
  const bit = (p: string) => s.getBits(s.design.root.ports[p])[0];
  return { s, set, bit };
}

describe('I/O pad', () => {
  it('drives the pin with d while en = 1, and the buffer reads it back', () => {
    const { set, bit } = run(IO_PAD);
    for (const d of [0, 1]) {
      set({ d, en: 1 });
      expect(bit('pad'), `d=${d}`).toBe(d ? B1 : B0);
      expect(bit('y')).toBe(d ? B1 : B0);
    }
  });
  it('lets go (Z) while en = 0', () => {
    const { set, bit } = run(IO_PAD);
    set({ d: 1, en: 0 });
    expect(bit('pad')).toBe(BZ);
  });
  it('transistor count: 3 chain inverters and the buffer pair (2 each), the tri-state inverter (6, with its enable inverter)', () => {
    expect(stats(IO_PAD).transistors).toBe(5 * 2 + 6);
  });
  it('the output stage is about the board impedance, and a narrower stage is weaker', () => {
    expect(Math.round(padDriveOhms())).toBe(48);
    expect(padDriveOhms(64)).toBeCloseTo(2 * padDriveOhms(128), 6);
    expect(PAD_CHAIN.map((w, i) => PAD_CHAIN[i + 1] / w).slice(0, 2)).toEqual([4, 4]);
    expect(PAD_FINAL / PAD_CHAIN[2]).toBe(4);
    expect(ioPad(64)).not.toBe(IO_PAD);
    expect(ioPad(64).id).toBe('io_pad64');
  });
});

describe('two pads on a wire', () => {
  it('either end drives the other; neither drives: the wire floats', () => {
    const { set, bit } = run(PAD_LINK);
    set({ d: 1, en: 1, rd: 0, ren: 0 });
    expect([bit('line'), bit('ya'), bit('yb')]).toEqual([B1, B1, B1]);
    set({ en: 0, rd: 0, ren: 1 });
    expect([bit('line'), bit('ya'), bit('yb')]).toEqual([B0, B0, B0]);
    set({ ren: 0 });
    expect(bit('line')).toBe(BZ);
  });
  it('both ends driving opposite values is a short', () => {
    const { s, set } = run(PAD_LINK);
    set({ d: 1, en: 1, rd: 0, ren: 1 });
    expect(s.shorted.some((x) => x)).toBe(true);
    set({ rd: 1 });
    expect(s.shorted.some((x) => x)).toBe(false);
  });
});
