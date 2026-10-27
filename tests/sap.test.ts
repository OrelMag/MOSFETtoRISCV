// Appendix C's SAP-1 at gate level: the 74xx chips' clocked behaviour, the modules, and the whole computer in lock step
// with the golden model (src/sap/iss.ts) every clock cycle on every sample program. The computer's clock is gated by
// HLT, so it runs on GateSim (the cycle engine refuses a gated clock).

import { describe, expect, it } from 'vitest';
import '../src/lib';
import {
  eeprom2k, LS161, LS173, LS189, LS273, LS76, DFFE_R, SAP_ALU, SAP_BUS, SAP_CLOCK, SAP_CONTROL, SAP_DISPLAY, SAP_STATE,
  sapChips, sapComputer, sapCost, TTL_PINS, ttlKind, registry,
} from '../src/lib';
import { sapBytes } from '../src/sap/asm';
import { CTRL, displayDigits, microcode, SAP_CTRL, SAP_DISPLAY_ROM, SAP_ROM_HI } from '../src/sap/isa';
import { SapISS } from '../src/sap/iss';
import { SAP_PROGRAMS } from '../src/sap/programs';
import { findNode, flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { evalOnce, simulate } from '../src/sim/harness';
import type { Sim } from '../src/sim/sim';
import { stats } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { tick } from './yieldtick';

const out = (sim: Sim, port: string) => pack(sim.getBits(sim.design.root.ports[port]));
const set = (sim: Sim, vals: Record<string, number>) => {
  for (const [k, v] of Object.entries(vals)) sim.setInput(k, v);
  sim.settle();
};

/** A structure simulated as gates (not the behaviour a chip may prefer). */
const gates = (d: ComponentDef) => new GateSim(flatten(d, { expand: () => true }));

describe('74xx chips: clocked behaviour', () => {
  it('74LS173 loads with G1 = G2 = 0, clears with CLR, drives with M = N = 0', () => {
    const s = simulate(LS173);
    set(s, { m: 0, n: 0, g1_n: 1, g2_n: 1, clr: 0, clk: 0, d: 0xa });
    set(s, { clk: 1 }); set(s, { clk: 0 });
    expect(out(s, 'q')).toBe(0);
    set(s, { g1_n: 0 }); set(s, { clk: 1 }); set(s, { clk: 0 });
    expect(out(s, 'q')).toBe(0); // one enable is not enough
    set(s, { g2_n: 0 }); set(s, { clk: 1 });
    expect(out(s, 'q')).toBe(0xa);
    set(s, { d: 5 }); set(s, { clk: 0 });
    expect(out(s, 'q')).toBe(0xa); // only at the rising edge
    set(s, { m: 1 }); expect(out(s, 'q')).toBe(0);
    set(s, { m: 0, n: 1 }); expect(out(s, 'q')).toBe(0);
    set(s, { n: 0 }); expect(out(s, 'q')).toBe(0xa);
    set(s, { clr: 1 }); expect(out(s, 'q')).toBe(0); // at once
    set(s, { clr: 0 }); set(s, { clk: 1 });
    expect(out(s, 'q')).toBe(5);
  });

  it('74LS161 counts, loads, clears at once, and carries', () => {
    const s = simulate(LS161);
    set(s, { clr_n: 1, clk: 0, d: 0, enp: 1, ent: 1, load_n: 1 });
    for (let i = 1; i <= 17; i++) {
      set(s, { clk: 1 }); set(s, { clk: 0 });
      expect(out(s, 'q')).toBe(i % 16);
      expect(out(s, 'rco')).toBe(i % 16 === 15 ? 1 : 0);
    }
    set(s, { enp: 0 }); set(s, { clk: 1 }); set(s, { clk: 0 });
    expect(out(s, 'q')).toBe(1);
    set(s, { d: 12, load_n: 0 }); set(s, { clk: 1 }); set(s, { clk: 0 });
    expect(out(s, 'q')).toBe(12); // LOAD wins over the enables
    set(s, { load_n: 1, enp: 1 }); set(s, { clk: 1 }); set(s, { clk: 0 });
    expect(out(s, 'q')).toBe(13);
    set(s, { clr_n: 0 });
    expect(out(s, 'q')).toBe(0);
  });

  it('74LS273 takes D at the rising edge; CLR clears', () => {
    const s = simulate(LS273);
    set(s, { clr_n: 1, clk: 0, d: 0x5a });
    expect(out(s, 'q')).toBe(0);
    set(s, { clk: 1 }); expect(out(s, 'q')).toBe(0x5a);
    set(s, { d: 0xff }); set(s, { clk: 0 }); expect(out(s, 'q')).toBe(0x5a);
    set(s, { clr_n: 0 }); expect(out(s, 'q')).toBe(0);
  });

  it('74LS189 writes while ME = WE = 0, reads inverted while WE = 1', () => {
    const s = simulate(LS189);
    set(s, { cs_n: 0, we_n: 1 });
    for (let a = 0; a < 16; a++) { set(s, { a, d: (a * 7 + 3) & 15 }); set(s, { we_n: 0 }); set(s, { we_n: 1 }); } // address before WE: no setup race
    for (let a = 0; a < 16; a++) {
      set(s, { a, d: 0 });
      expect(out(s, 'q_n'), `word ${a}`).toBe(~((a * 7 + 3) & 15) & 15);
    }
    set(s, { we_n: 0 }); expect(out(s, 'q_n')).toBe(0); // 3-state while writing
    set(s, { we_n: 1, cs_n: 1, a: 3, d: 9 }); set(s, { we_n: 0 }); set(s, { we_n: 1, cs_n: 0 });
    expect(out(s, 'q_n')).toBe(~((3 * 7 + 3) & 15) & 15); // not selected: no write
  });

  it('DFFE_R loads only when enabled; rst_n clears', () => {
    const s = simulate(DFFE_R);
    set(s, { d: 1, en: 0, clk: 0, rst_n: 1 }); set(s, { clk: 1 }); set(s, { clk: 0 });
    expect(out(s, 'q')).toBe(0);
    set(s, { en: 1 }); set(s, { clk: 1 });
    expect(out(s, 'q')).toBe(1);
    set(s, { rst_n: 0 }); expect(out(s, 'q')).toBe(0);
  });

  it('74LS76 toggles on the falling edge with J = K = 1; preset and clear', () => {
    const s = simulate(LS76);
    set(s, { clk1: 0, pre1_n: 1, clr1_n: 0, j1: 1, k1: 1, clk2: 0, pre2_n: 0, clr2_n: 1, j2: 0, k2: 0 });
    expect([out(s, 'q1'), out(s, 'q1_n'), out(s, 'q2'), out(s, 'q2_n')]).toEqual([0, 1, 1, 0]);
    set(s, { clr1_n: 1, pre2_n: 1 });
    const seq: number[] = [];
    for (let i = 0; i < 4; i++) { set(s, { clk1: 1 }); seq.push(out(s, 'q1')); set(s, { clk1: 0 }); seq.push(out(s, 'q1')); }
    expect(seq).toEqual([0, 1, 1, 0, 0, 1, 1, 0]);
    set(s, { j2: 0, k2: 1 }); set(s, { clk2: 1 }); set(s, { clk2: 0 });
    expect(out(s, 'q2')).toBe(0); // K resets
    set(s, { j2: 1, k2: 0 }); set(s, { clk2: 1 }); set(s, { clk2: 0 });
    expect(out(s, 'q2')).toBe(1); // J sets
  });

  it('the 28C16: behaviour and structure agree, 3-state', () => {
    const e = eeprom2k(SAP_ROM_HI);
    expect(eeprom2k(Array.from(SAP_ROM_HI))).toBe(e); // memoized by content
    const fast = simulate(e), slow = gates(e);
    for (let i = 0; i < 300; i++) {
      const a = (i * 977 + 13) % 2048, ce = i % 7 === 0 ? 1 : 0, oe = i % 11 === 0 ? 1 : 0;
      const want = e.spec!([a, ce, oe, 1]);
      expect(evalOnce(fast, [a, ce, oe, 1])).toEqual(want);
      expect(evalOnce(slow, [a, ce, oe, 1])).toEqual(want);
    }
  });

  it('pin tables name every port bit once, and the power pins', () => {
    for (const key of Object.keys(TTL_PINS)) {
      const d = key === 'at28c16' ? eeprom2k([]) : registry.get(key)!;
      expect(d, key).toBeTruthy();
      expect(ttlKind(d)).toBe(key);
      const pins = TTL_PINS[key];
      expect([8, 14, 16, 20, 24]).toContain(pins.length);
      expect(pins.filter((p) => p.name === 'VCC').length, key).toBe(1);
      expect(pins.filter((p) => p.name === 'GND').length, key).toBe(1);
      const seen = new Set(pins.filter((p) => p.port).map((p) => `${p.port}.${p.bit}`));
      const want = new Set(d.ports.flatMap((p) => Array.from({ length: p.width }, (_, i) => `${p.name}.${i}`)));
      expect(seen, key).toEqual(want);
    }
  });
});

describe('SAP-1 modules', () => {
  it('the clock gates on HLT', () => {
    const s = simulate(SAP_CLOCK);
    expect(evalOnce(s, [1, 0])).toEqual([1, 0]);
    expect(evalOnce(s, [1, 1])).toEqual([0, 1]);
  });

  it('the control unit steps T0–T4 on nclk and reads the microcode', () => {
    const s = simulate(SAP_CONTROL);
    set(s, { nclk: 0, op: 0x2, cf: 0, zf: 0 });
    const lines = () => SAP_CTRL.reduce((w, n, i) => w | (out(s, n) << (15 - i)), 0);
    for (let k = 0; k < 12; k++) {
      expect(out(s, 't')).toBe(k % 5);
      expect(out(s, 'ts')).toBe(1 << (k % 5));
      expect(lines()).toBe(microcode(0x2, k % 5, 0, 0));
      set(s, { nclk: 1 }); set(s, { nclk: 0 });
    }
  });

  it('the display shows ones, tens, hundreds', () => {
    const s = simulate(SAP_DISPLAY);
    for (const v of [0, 7, 42, 199, 255]) expect(evalOnce(s, [v])).toEqual(displayDigits(v));
    expect(SAP_DISPLAY_ROM[(2 << 8) | 199]).toBe(displayDigits(199)[2]);
  });

  it('the ALU and the bus (spec, sampled)', () => {
    for (const d of [SAP_ALU, SAP_BUS]) {
      const s = simulate(d);
      let seed = 7;
      const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
      for (let i = 0; i < 400; i++) {
        const v = d.ports.filter((p) => p.dir === 'in').map((p) => rnd(2 ** p.width));
        expect(evalOnce(s, v), `${d.id}(${v})`).toEqual(d.spec!(v));
      }
    }
  });
});

/** The gate-level computer, its clock driven by hand, its state read at the chips' outputs. */
class Bench {
  readonly sim: GateSim;
  constructor(readonly def: ComponentDef) {
    this.sim = new GateSim(flatten(def));
    for (const [k, v] of Object.entries({ clk: 0, prog: 0, addrSw: 0, dataSw: 0, write: 0 })) this.sim.setInput(k, v);
    this.sim.reset('zero');
    this.sim.settle();
  }
  read(path: string, port: string): number {
    const n = findNode(this.sim.design.root, path.split('.'));
    if (!n) throw new Error(`no ${path}`);
    return pack(this.sim.getBits(n.ports[port]));
  }
  reg(k: keyof typeof SAP_STATE): number { const [p, q] = SAP_STATE[k]; return this.read(p, q); }
  state() {
    const nib = (lo: keyof typeof SAP_STATE, hi: keyof typeof SAP_STATE) => (this.reg(hi) << 4) | this.reg(lo);
    const f = this.reg('flags');
    return {
      pc: this.reg('pc'), mar: this.reg('mar'), ir: nib('irLo', 'irHi'), a: nib('aLo', 'aHi'), b: nib('bLo', 'bHi'),
      out: this.reg('out'), cf: f & 1, zf: (f >> 1) & 1, step: this.reg('step'),
    };
  }
  ram(): number[] {
    return Array.from({ length: 16 }, (_, i) => {
      let v = 0;
      for (let j = 0; j < 8; j++) v |= this.read(`ram.${j < 4 ? 'lo' : 'hi'}.mem.w${i}.l${j % 4}`, 'q') << j;
      return v;
    });
  }
  cycle(): void {
    set(this.sim, { clk: 1 });
    set(this.sim, { clk: 0 });
  }
}

/** NANDs of the computer without its five EEPROMs' ROM trees (each 65 524): a change to a module shows here. */
const SAP_LOGIC_NANDS = 3306;

const issState = (m: SapISS) => ({ pc: m.pc, mar: m.mar, ir: m.ir, a: m.a, b: m.b, out: m.out, cf: m.cf, zf: m.zf, step: m.step });

describe('SAP-1 computer', () => {
  it('its chips at their contract paths, and what it costs', () => {
    const d = sapComputer(sapBytes(SAP_PROGRAMS[0].src));
    const chips = sapChips(d);
    const paths = new Map(chips.map((c) => [c.path, c.kind]));
    for (const [p, k] of Object.entries({
      'clock.inv': 'ls04', 'clock.and': 'ls08', 'pc.cnt': 'ls161', 'pc.drv': 'ls245', 'mar.reg': 'ls173', 'mar.sel': 'ls157',
      'ram.lo': 'ls189', 'ram.hi': 'ls189', 'ram.ilo': 'ls04', 'ram.ihi': 'ls04', 'ram.dlo': 'ls157', 'ram.dhi': 'ls157', 'ram.drv': 'ls245',
      'ir.hi': 'ls173', 'ir.lo': 'ls173', 'ir.drv': 'ls245', 'ctl.step': 'ls161', 'ctl.dec': 'ls138', 'ctl.inv': 'ls04',
      'ctl.romhi': 'at28c16', 'ctl.romlo': 'at28c16', 'a.hi': 'ls173', 'a.lo': 'ls173', 'a.drv': 'ls245',
      'alu.add0': 'ls283', 'alu.add1': 'ls283', 'alu.x0': 'ls86', 'alu.x1': 'ls86', 'alu.drv': 'ls245',
      'flags.reg': 'ls173', 'flags.nor': 'ls02', 'flags.and': 'ls08', 'b.hi': 'ls173', 'b.lo': 'ls173', 'out.reg': 'ls273', 'out.clk': 'ls08',
      'disp.rom0': 'at28c16', 'disp.rom1': 'at28c16', 'disp.rom2': 'at28c16',
    })) expect(paths.get(p), p).toBe(k);
    for (const c of chips) expect(findNode(flatten(d).root, c.path.split('.')), c.path).toBeTruthy();
    const cost = sapCost(d);
    expect(cost.nands).toBe(stats(d).nands);
    expect(cost.logicNands).toBe(SAP_LOGIC_NANDS);
    expect(cost.chips).toBe(chips.length);
  });

  it('programming mode: the DIP switches write the RAM, then it runs', async () => {
    const p = SAP_PROGRAMS.find((q) => q.id === 'mul')!;
    const bytes = sapBytes(p.src);
    const hw = new Bench(sapComputer([]));
    set(hw.sim, { prog: 1 });
    bytes.forEach((v, i) => {
      set(hw.sim, { addrSw: i, dataSw: v });
      set(hw.sim, { write: 1 });
      set(hw.sim, { write: 0 });
    });
    set(hw.sim, { prog: 0 });
    expect(hw.ram()).toEqual([...bytes, ...Array(16 - bytes.length).fill(0)]);
    const m = new SapISS(bytes);
    for (let c = 0; c < 2000 && !m.halted; c++) {
      m.cycle();
      hw.cycle();
      expect(hw.state(), `cycle ${c}`).toEqual(issState(m));
      if (c % 200 === 199) await tick();
    }
    expect(m.halted && out(hw.sim, 'halt')).toBe(1);
    expect(out(hw.sim, 'out')).toBe(p.outs[0]);
  });

  it.each(SAP_PROGRAMS.map((p) => [p.id, p] as const))('%s: gates and golden model in lock step every cycle', async (_, p) => {
    const bytes = sapBytes(p.src);
    const hw = new Bench(sapComputer(bytes));
    const m = new SapISS(bytes);
    expect(hw.ram()).toEqual(Array.from(m.ram));
    const outs: number[] = [];
    for (let c = 0; c < 4000; c++) {
      const at = `cycle ${c}`;
      expect(hw.state(), at).toEqual(issState(m));
      const { bus, drivers } = m.drive();
      expect(out(hw.sim, 'bus'), `${at}: bus`).toBe(bus);
      expect(out(hw.sim, 'clash'), at).toBe(drivers > 1 ? 1 : 0);
      expect(out(hw.sim, 'halt'), at).toBe(m.halted ? 1 : 0);
      expect(out(hw.sim, 'out'), at).toBe(m.out);
      expect([0, 1, 2].map((k) => out(hw.sim, `d${k}`)), at).toEqual(displayDigits(m.out));
      if (m.halted) {
        const before = hw.state();
        hw.cycle();
        expect(hw.state(), 'halted: the clock is gated').toEqual(before);
        break;
      }
      const oi = m.control() & CTRL.oi;
      m.cycle();
      if (oi) outs.push(m.out);
      hw.cycle();
      expect(hw.sim.unstable, at).toBe(false);
      if (c % 200 === 199) await tick();
    }
    expect(m.halted).toBe(true);
    expect(outs).toEqual(p.outs);
    expect(hw.ram()).toEqual(Array.from(m.ram));
  }, 120_000);
});
