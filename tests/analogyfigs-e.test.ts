import { describe, expect, it } from 'vitest';
import { decoder, MUX2 } from '../src/lib';
import { evalOnce, simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import { board, mic, PointsRun, SPEECH } from '../src/widgets/analogy/steer';

describe('points figure (MUX2 on GateSim)', () => {
  it('the output is the selected input, as the part says', () => {
    const sim = simulate(MUX2);
    const r = new PointsRun();
    for (let v = 0; v < 8; v++) {
      const [s, a, b] = [(v >> 2) & 1, (v >> 1) & 1, v & 1];
      expect(r.set(s, a, b).y).toBe(evalOnce(sim, [a, b, s])[0]);
    }
  });
  it('an unselected input toggles its wire but nothing inside the mux and not the output', () => {
    const r = new PointsRun();
    r.set(0, 0, 0);
    const st = r.set(0, 0, 1); // b changes, a selected
    expect(st.wireToggles).toBe(1);
    expect(st.innerToggles).toBe(0);
    expect(st.outToggles).toBe(0);
    const st2 = r.set(0, 1, 1); // the selected one changes: inner gates and y switch
    expect(st2.innerToggles).toBeGreaterThan(0);
    expect(st2.outToggles).toBe(1);
  });
  it('moving the points costs switching inside', () => {
    const r = new PointsRun();
    r.set(0, 0, 1);
    const st = r.set(1, 0, 1);
    expect(st.innerToggles).toBeGreaterThan(0);
    expect(st.y).toBe(1);
  });
});

describe('switchboard figure (decoder)', () => {
  it('one line lit, the addressed one, for every size', () => {
    for (let n = 1; n <= 4; n++) for (let a = 0; a < 2 ** n; a++) {
      const b = board(n, a);
      expect(b.rooms).toBe(2 ** n);
      expect(b.lines).toEqual(Array.from({ length: 2 ** n }, (_, k) => (k === a ? 1 : 0)));
    }
  });
  it('NAND counts grow with the rooms, pinned from stats', () => {
    const counts = [1, 2, 3, 4].map((n) => stats(decoder(n)).nands);
    expect(counts).toEqual([1, 2, 3, 4].map((n) => board(n, 0).nands));
    expect(counts[3]).toBeGreaterThan(counts[2] * 1.5);
    expect(counts[2]).toBeGreaterThan(counts[1] * 1.5);
    expect(counts).toEqual([1, 10, 35, 100]); // the figure shows these; more than doubling per bit
  });
});

describe('microphone figure (TRIBUF on SwitchSim)', () => {
  it('nobody enabled: Z; one: its word', () => {
    expect(mic([false, false, false, false])).toEqual({ value: 'Z', short: null });
    for (let i = 0; i < 4; i++) {
      const e = [false, false, false, false]; e[i] = true;
      expect(mic(e)).toEqual({ value: String(SPEECH[i]), short: null });
    }
  });
  it('two that disagree short the wire (X); two that agree do not', () => {
    const bad = mic([true, true, false, false]);
    expect(bad.value).toBe('X');
    expect(bad.short).toMatch(/shorted/);
    const same = mic([true, false, true, false]);
    expect(same.value).toBe('1');
    expect(same.short).toBeNull();
    expect(bad.short).toBe('VDD shorted to GND through t0.t.p1, t1.t.n1');
  });
});
