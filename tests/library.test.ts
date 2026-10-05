import { describe, expect, it } from 'vitest';
import {
  addSub, alu, andN, bitwise, busMux2, constWord, counter, decoder, DFF, D_LATCH, incrementer, isZero, muxTree, orN, ram, rca,
  register, regfile, shifter, SR_LATCH, zext,
} from '../src/lib';
import { evalOnce, forEachInput, inputBits, simulate } from '../src/sim/harness';
import type { ComponentDef } from '../src/sim/types';
import { inPorts } from '../src/sim/types';
import { pack } from '../src/sim/values';
import type { Sim } from '../src/sim/sim';

function checkSpec(def: ComponentDef) {
  const sim = simulate(def);
  if (inputBits(def) <= 12) {
    forEachInput(def, (ins) => expect(evalOnce(sim, ins), `${def.id}(${ins})`).toEqual(def.spec!(ins)));
  } else {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let t = 0; t < 3000; t++) {
      const ins = inPorts(def).map((p) => Math.floor(rnd() * 2 ** p.width));
      expect(evalOnce(sim, ins), `${def.id}(${ins})`).toEqual(def.spec!(ins));
    }
  }
}

describe('generated combinational parts match their specs', () => {
  const defs = [
    rca(1), rca(4), rca(8), addSub(4), addSub(8), incrementer(4), andN(3), andN(4), andN(5),
    decoder(2), decoder(3), decoder(2, true), decoder(4, true, 10), busMux2(4), muxTree(1, 1), muxTree(2, 1),
    muxTree(2, 4), muxTree(3, 2), muxTree(4, 4, 10),
  ];
  for (const d of defs) it(d.id, () => checkSpec(d));
});

const out = (sim: Sim, port: string) => pack(sim.getBits(sim.design.root.ports[port]));
const set = (sim: Sim, vals: Record<string, number>) => {
  for (const [k, v] of Object.entries(vals)) sim.setInput(k, v);
  sim.settle();
};
const tick = (sim: Sim) => {
  set(sim, { clk: 1 });
  set(sim, { clk: 0 });
};

describe('sequential behaviour', () => {
  it('SR latch sets, holds and resets', () => {
    const s = simulate(SR_LATCH);
    s.setInput('s_n', 1); s.setInput('r_n', 1);
    s.reset('zero'); // power on with both (active-low) inputs released
    expect(out(s, 'q')).toBe(0); // power-on hint
    set(s, { s_n: 0 }); expect(out(s, 'q')).toBe(1);
    set(s, { s_n: 1 }); expect(out(s, 'q')).toBe(1); // holds
    set(s, { r_n: 0 }); expect(out(s, 'q')).toBe(0);
    set(s, { r_n: 1 }); expect(out(s, 'q')).toBe(0);
    expect(out(s, 'q_n')).toBe(1);
  });

  it('D latch is transparent when enabled and holds otherwise', () => {
    const s = simulate(D_LATCH);
    set(s, { e: 1, d: 1 }); expect(out(s, 'q')).toBe(1);
    set(s, { d: 0 }); expect(out(s, 'q')).toBe(0);
    set(s, { d: 1 }); set(s, { e: 0 }); expect(out(s, 'q')).toBe(1); // d must settle before e falls (hold time)
    set(s, { d: 0 }); expect(out(s, 'q')).toBe(1);
  });

  it('DFF only changes on the rising edge', () => {
    const s = simulate(DFF);
    set(s, { clk: 0, d: 0 });
    tick(s); expect(out(s, 'q')).toBe(0);
    set(s, { d: 1 }); expect(out(s, 'q')).toBe(0); // clk low: no change
    set(s, { clk: 1 }); expect(out(s, 'q')).toBe(1); // rising edge
    set(s, { d: 0 }); expect(out(s, 'q')).toBe(1); // clk high: no change
    set(s, { clk: 0 }); expect(out(s, 'q')).toBe(1); // falling edge: no change
  });

  it('register loads only when enabled', () => {
    const s = simulate(register(8));
    set(s, { clk: 0, en: 1, d: 0xa5 }); tick(s);
    expect(out(s, 'q')).toBe(0xa5);
    set(s, { en: 0, d: 0x3c }); tick(s);
    expect(out(s, 'q')).toBe(0xa5);
    set(s, { en: 1 }); tick(s);
    expect(out(s, 'q')).toBe(0x3c);
  });

  it('counter counts and wraps', () => {
    const s = simulate(counter(4));
    set(s, { clk: 0, en: 1 });
    expect(out(s, 'q')).toBe(0);
    for (let i = 1; i <= 20; i++) {
      tick(s);
      expect(out(s, 'q')).toBe(i % 16);
    }
    set(s, { en: 0 }); tick(s);
    expect(out(s, 'q')).toBe(4);
  });

  it('16×8 RAM writes and reads every word', () => {
    const s = simulate(ram(4, 8));
    set(s, { clk: 0, we: 0 });
    for (let a = 0; a < 16; a++) {
      set(s, { addr: a, din: (a * 37 + 11) & 0xff, we: 1 });
      tick(s);
    }
    set(s, { we: 0, din: 0xff });
    for (let a = 0; a < 16; a++) {
      set(s, { addr: a });
      expect(out(s, 'dout'), `word ${a}`).toBe((a * 37 + 11) & 0xff);
    }
    tick(s); // we = 0: nothing changes
    expect(s.unstable).toBe(false);
    set(s, { addr: 3 });
    expect(out(s, 'dout')).toBe((3 * 37 + 11) & 0xff);
  });
});

describe('oscillation handling', () => {
  it('releasing both SR inputs at once is resolved, not an infinite loop', () => {
    const s = simulate(SR_LATCH);
    set(s, { s_n: 0, r_n: 0 });
    expect(out(s, 'q')).toBe(1);
    expect(out(s, 'q_n')).toBe(1);
    set(s, { s_n: 1, r_n: 1 }); // the forbidden release: a race
    const q = out(s, 'q'), qn = out(s, 'q_n');
    expect(q === 0 || q === 1).toBe(true);
    expect(qn).toBe(1 - q);
  });
});

describe('ALU and its parts match their specs', () => {
  const defs = [
    shifter(8), shifter(16), bitwise('xor', 4), orN(5), isZero(8), zext(4), constWord(8, 0xa5),
    alu(4), alu(8), alu(32), shifter(32), addSub(32),
  ];
  for (const d of defs) it(d.id, () => checkSpec(d));
});

describe('register file', () => {
  it('8 × 8: writes, two independent reads, x0 stays zero', () => {
    const s = simulate(regfile(3, 8));
    set(s, { clk: 0, we: 1 });
    for (let r = 0; r < 8; r++) { set(s, { wa: r, wd: 0x10 + r }); tick(s); }
    set(s, { we: 0 });
    for (let r = 0; r < 8; r++) {
      set(s, { ra1: r, ra2: 7 - r });
      expect(out(s, 'rd1')).toBe(r === 0 ? 0 : 0x10 + r);
      expect(out(s, 'rd2')).toBe(7 - r === 0 ? 0 : 0x10 + 7 - r);
    }
  });
  it('32 × 32 builds and works', () => {
    const s = simulate(regfile(5, 32));
    set(s, { clk: 0, we: 1, wa: 31, wd: 0xdeadbeef }); tick(s);
    set(s, { wa: 1, wd: 0x12345678 }); tick(s);
    set(s, { we: 0, ra1: 31, ra2: 1 });
    expect(out(s, 'rd1')).toBe(0xdeadbeef);
    expect(out(s, 'rd2')).toBe(0x12345678);
  });
});
