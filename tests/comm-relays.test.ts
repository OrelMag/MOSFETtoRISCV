// Chapters 39 and 40's relay parts on SwitchSim: behaviour, relay steps, relay counts.
import { describe, expect, it } from 'vitest';
import { flatten } from '../src/sim/flatten';
import { SwitchSim } from '../src/sim/switchsim';
import { stats } from '../src/sim/stats';
import { B1, type ComponentDef } from '../src/sim/types';
import { CROSSBAR3, CROSSPOINT, DIAL_COUNTER, DIAL_SELECTOR, TELEGRAPH_RELAY, countStage, telegraphChain } from '../src/lib/telegraph';

const simOf = (def: ComponentDef) => new SwitchSim(flatten(def, { mode: 'switch' }));
const out = (sim: SwitchSim, port: string) => sim.getBits(sim.design.root.ports[port]);
const val = (sim: SwitchSim, port: string) => out(sim, port).reduce<number>((v, x, i) => v | ((x === B1 ? 1 : 0) << i), 0);

describe('the telegraph repeater', () => {
  it('one station copies its line one relay step later, at battery strength', () => {
    const sim = simOf(TELEGRAPH_RELAY);
    expect(val(sim, 'out')).toBe(0);
    sim.setInput('line', 1);
    sim.settle();
    expect(val(sim, 'out')).toBe(1);
    sim.setInput('line', 0);
    sim.settle();
    expect(val(sim, 'out')).toBe(0);
    expect(stats(TELEGRAPH_RELAY).relays).toBe(1);
  });

  it('the front of a key press reaches the sounder after exactly n relay steps', () => {
    for (const n of [1, 2, 3, 4]) {
      const sim = simOf(telegraphChain(n));
      sim.setInput('key', 1);
      let steps = 0;
      while (val(sim, 'sounder') === 0 && steps < 20) { sim.step(); steps++; }
      // step() 1 solves (the coil is fed), steps 2 .. n + 1 each move one stage
      expect(steps, `n = ${n}`).toBe(n + 1);
      expect(sim.time).toBe(n);
    }
  });

  it('settles in n relay steps whichever way the key moves', () => {
    const sim = simOf(telegraphChain(3));
    for (const k of [1, 0, 1, 0]) {
      sim.setInput('key', k);
      const t0 = sim.time;
      sim.settle();
      expect(val(sim, 'sounder')).toBe(k);
      expect(sim.time - t0).toBe(3);
      expect(sim.unstable).toBe(false);
    }
  });
});

describe('the relay pulse counter', () => {
  const pulses = (sim: SwitchSim, n: number) => {
    for (let i = 0; i < n; i++) { sim.setInput('pulse', 1); sim.settle(); sim.setInput('pulse', 0); sim.settle(); }
  };
  it('counts falling edges, 0 to 7 and round', () => {
    const sim = simOf(DIAL_COUNTER);
    expect(val(sim, 'count')).toBe(0);
    for (let i = 1; i <= 17; i++) {
      pulses(sim, 1);
      expect(val(sim, 'count'), `after ${i} pulses`).toBe(i & 7);
      expect(sim.unstable).toBe(false);
    }
  });
  it('advances once per pulse however long the pulse lasts, and only when it falls', () => {
    const sim = simOf(DIAL_COUNTER);
    sim.setInput('pulse', 1);
    for (let i = 0; i < 12; i++) { sim.step(); expect(val(sim, 'count'), `high, step ${i}`).toBe(0); }
    sim.settle();
    expect(val(sim, 'count')).toBe(0);
    sim.setInput('pulse', 0);
    sim.settle();
    expect(val(sim, 'count')).toBe(1);
    sim.setInput('pulse', 1);
    for (let i = 0; i < 40; i++) sim.step();
    sim.setInput('pulse', 0);
    sim.settle();
    expect(val(sim, 'count')).toBe(2);
  });
  it('hanging up releases every stage', () => {
    const sim = simOf(DIAL_COUNTER);
    pulses(sim, 5);
    expect(val(sim, 'count')).toBe(5);
    sim.setInput('hangup', 1);
    sim.settle();
    expect(val(sim, 'count')).toBe(0);
    sim.setInput('hangup', 0);
    sim.settle();
    expect(val(sim, 'count')).toBe(0);
    pulses(sim, 3);
    expect(val(sim, 'count')).toBe(3);
  });
  it('costs 3 relays a bit and one to hang up', () => {
    expect(stats(DIAL_COUNTER).relays).toBe(10);
    expect(stats(countStage(0)).relays).toBe(3);
  });
});

describe('the dial selector', () => {
  const pulses = (sim: SwitchSim, n: number) => {
    for (let i = 0; i < n; i++) { sim.setInput('pulse', 1); sim.settle(); sim.setInput('pulse', 0); sim.settle(); }
  };
  it('connects the caller line to output n after n pulses, and to no other', () => {
    const sim = simOf(DIAL_SELECTOR);
    sim.setInput('line', 1);
    sim.settle();
    expect(val(sim, 'y')).toBe(1);
    for (let n = 1; n <= 8; n++) {
      pulses(sim, 1);
      expect(val(sim, 'count')).toBe(n & 7);
      expect(val(sim, 'y'), `after ${n} pulses`).toBe(1 << (n & 7));
    }
  });
  it('a dial of every digit, then hanging up', () => {
    const sim = simOf(DIAL_SELECTOR);
    sim.setInput('line', 1);
    for (let d = 0; d < 8; d++) {
      sim.setInput('hangup', 1); sim.settle(); sim.setInput('hangup', 0); sim.settle();
      pulses(sim, d);
      expect(val(sim, 'y'), `digit ${d}`).toBe(1 << d);
    }
    sim.setInput('hangup', 1);
    sim.settle();
    expect(val(sim, 'y')).toBe(1);
  });
  it('the tree is contacts on the slave relays: a line change settles in no relay step', () => {
    const sim = simOf(DIAL_SELECTOR);
    pulses(sim, 5);
    sim.setInput('line', 1);
    const t0 = sim.time;
    sim.settle();
    expect(sim.time - t0).toBe(0);
    expect(val(sim, 'y')).toBe(1 << 5);
    sim.setInput('line', 0);
    sim.settle();
    expect(val(sim, 'y')).toBe(0);
  });
  it('is the counter plus a tree: the same 10 relays', () => {
    expect(stats(DIAL_SELECTOR).relays).toBe(stats(DIAL_COUNTER).relays);
  });
});

describe('the 3 x 3 crossbar', () => {
  const bits = (sim: SwitchSim, port: string) => out(sim, port).map((b) => (b === B1 ? 1 : 0));
  /** Select row r and column c together, let it settle, let the selects go. */
  const call = (sim: SwitchSim, r: number, c: number) => {
    sim.setInput('rs', 1 << r); sim.setInput('cs', 1 << c); sim.settle();
    sim.setInput('rs', 0); sim.setInput('cs', 0); sim.settle();
  };
  it('joins a row to a column, holds the call after the selects drop, and carries speech both ways', () => {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const sim = simOf(CROSSBAR3);
      call(sim, r, c);
      expect(sim.unstable).toBe(false);
      expect(bits(sim, 'busy')).toEqual([0, 1, 2].map((k) => (k === c ? 1 : 0)));
      // caller to called
      sim.setInput('row', 1 << r); sim.settle();
      expect(bits(sim, 'col'), `row ${r} to col ${c}`).toEqual([0, 1, 2].map((k) => (k === c ? 1 : 0)));
      // and called to caller
      const back = simOf(CROSSBAR3);
      call(back, r, c);
      back.setInput('col', 1 << c); back.settle();
      expect(bits(back, 'row'), `col ${c} to row ${r}`).toEqual([0, 1, 2].map((k) => (k === r ? 1 : 0)));
    }
  });
  it('two calls at once keep their speech apart', () => {
    const sim = simOf(CROSSBAR3);
    call(sim, 0, 1);
    call(sim, 2, 0);
    expect(bits(sim, 'busy')).toEqual([1, 1, 0]);
    sim.setInput('row', 0b001); sim.settle();
    expect(bits(sim, 'col')).toEqual([0, 1, 0]);
    sim.setInput('row', 0b100); sim.settle();
    expect(bits(sim, 'col')).toEqual([1, 0, 0]);
    sim.setInput('row', 0b101); sim.settle();
    expect(bits(sim, 'col')).toEqual([1, 1, 0]);
  });
  it('a call to a busy column is refused, and goes through once the first caller hangs up', () => {
    const sim = simOf(CROSSBAR3);
    call(sim, 0, 1);
    call(sim, 1, 1);
    sim.setInput('row', 0b010); sim.settle();
    expect(bits(sim, 'col'), 'row 1 is not connected to the busy column').toEqual([0, 0, 0]);
    expect(bits(sim, 'busy')).toEqual([0, 1, 0]);
    sim.setInput('row', 0b001); sim.settle();
    expect(bits(sim, 'col')).toEqual([0, 1, 0]);
    sim.setInput('row', 0);
    sim.setInput('hang', 0b001); sim.settle();
    sim.setInput('hang', 0); sim.settle();
    expect(bits(sim, 'busy')).toEqual([0, 0, 0]);
    call(sim, 1, 1);
    sim.setInput('row', 0b010); sim.settle();
    expect(bits(sim, 'col')).toEqual([0, 1, 0]);
  });
  it('hanging up one caller leaves the other call alone', () => {
    const sim = simOf(CROSSBAR3);
    call(sim, 0, 2); call(sim, 1, 0);
    sim.setInput('hang', 0b010); sim.settle();
    sim.setInput('hang', 0); sim.settle();
    expect(bits(sim, 'busy')).toEqual([0, 0, 1]);
  });
  it('counts 21 relays: 9 crosspoints, 3 row selects, 3 column selects, 3 busy, 3 hang-ups', () => {
    expect(stats(CROSSBAR3).relays).toBe(21);
    expect(stats(CROSSPOINT).relays).toBe(1);
  });
});
