// The Enigma in gates against the cipher: every part on every letter, every press of the machine, and U-264's message.
import { describe, expect, it } from 'vitest';
import { chr, DEFAULT_SETTINGS, Enigma, idx, ROTORS, U264, type EnigmaSettings } from '../src/crypto/enigma';
import '../src/lib';
import { add26, m4Gates, sub26, wheelStage, wiringTable } from '../src/lib/enigmagates';
import { evalOnce, forEachInput, simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import { tick } from './yieldtick';

type Def = Parameters<typeof simulate>[0];
const exact = (def: Def) => { const sim = simulate(def); forEachInput(def, (ins) => expect(evalOnce(sim, ins), `${def.id}(${ins})`).toEqual(def.spec!(ins))); };
const one = (def: Def, ins: number[]) => evalOnce(simulate(def), ins)[0];

describe('the parts', () => {
  it('add and subtract round the alphabet on all 676 pairs', () => {
    for (let a = 0; a < 26; a++) for (let b = 0; b < 26; b++) {
      expect(add26().spec!([a, b])[0]).toBe((a + b) % 26);
      expect(sub26().spec!([a, b])[0]).toBe((a - b + 26) % 26);
    }
    exact(add26());
    exact(sub26());
  });
  it('a wiring table is its wheel', () => {
    const t = [...ROTORS.VIII.wiring].map(idx), w = wiringTable('VIII_f', 'Wheel VIII', t);
    exact(w);
    for (let a = 0; a < 26; a++) expect(one(w, [a])).toBe(t[a]);
  });
  it('a turned stage is the wheel at that offset', () => {
    const t = [...ROTORS.III.wiring].map(idx), w = wheelStage('III_f', 'Wheel III', t);
    exact(w);
    for (let off = 0; off < 26; off += 5) for (let a = 0; a < 26; a++) expect(w.spec!([a, off])[0]).toBe((t[(a + off) % 26] - off + 26) % 26);
  });
});

/** A clock's rising edge, with the inputs settled first. */
function edge(sim: ReturnType<typeof simulate>): void { sim.setInput('clk', 0); sim.settle(); sim.setInput('clk', 1); sim.settle(); }
const out = (sim: ReturnType<typeof simulate>, port: string) => Array.from(sim.getBits(sim.design.root.ports[port]), Number).reduce((a, b, i) => a + b * 2 ** i, 0);
function drive(s: EnigmaSettings) {
  const sim = simulate(m4Gates(s)), start = [...s.start].map(idx);
  sim.reset('zero');
  sim.setInput('key', 0); sim.setInput('load', 1); sim.setInput('set_l', start[1]); sim.setInput('set_m', start[2]); sim.setInput('set_r', start[3]);
  edge(sim);
  sim.setInput('load', 0);
  return sim;
}

describe('the machine', () => {
  it('matches the cipher on every press, windows and lamp, across a double step', async () => {
    const s: EnigmaSettings = { ...DEFAULT_SETTINGS, rotors: ['I', 'II', 'III'], rings: 'AACD', start: 'BADU', plugs: 'AQ BJ DL EX' }, e = new Enigma(s), sim = drive(s);
    for (const ch of 'THEQUICKBROWNFOXJUMPSOVERTHELAZYDOG') {
      sim.setInput('key', idx(ch));
      edge(sim);
      const t = e.press(ch);
      expect(chr(out(sim, 'win_l')) + chr(out(sim, 'win_m')) + chr(out(sim, 'win_r'))).toBe(e.windows().slice(1));
      expect(chr(out(sim, 'lamp'))).toBe(t.output);
      await tick();
    }
  });
  it('deciphers the start of U-264’s message of 1942 through its gates', async () => {
    const sim = drive(U264.settings);
    let text = '';
    for (const ch of U264.cipher.slice(0, 60)) {
      sim.setInput('key', idx(ch));
      edge(sim);
      text += chr(out(sim, 'lamp'));
      await tick();
    }
    expect(text).toBe(U264.plain.slice(0, 60));
  });
  it('costs thousands of NANDs for what the real machine does in wires', () => {
    expect(stats(m4Gates(U264.settings)).nands).toBeGreaterThan(1000);
  });
});
