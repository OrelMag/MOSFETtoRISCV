// Appendix C's scenes: the breadboard layouts are valid for the designs they draw, the SAP panel's lock step
// (widgets/sapmon.ts) follows every sample program to its HLT as the stage's edge hooks drive it, notices a
// difference, survives programming by the switches, and the tri-state scene shorts when two drivers disagree.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { SAP_ALU, SAP_AREG, SAP_CLOCK, SAP_COMPUTER, SAP_PC, sapChips, sapComputer } from '../src/lib/sap';
import { sapBytes } from '../src/sap/asm';
import { SAP_PROGRAMS } from '../src/sap/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { shortText, SwitchSim } from '../src/sim/switchsim';
import { B0, B1 } from '../src/sim/types';
import { validateLayout } from '../src/view/bblayout';
import { TRISTATE_BUS } from '../src/widgets/sap';
import { moduleLayout, SAP_ROLES, sapLayout } from '../src/widgets/saplayout';
import { microTable, SapFollower, sapGloss, sapHw, sapRam } from '../src/widgets/sapmon';
import { tick } from './yieldtick';

describe('SAP-1 breadboards', () => {
  it('the computer\'s layout is valid, with every chip once, numbered U1… in board order', () => {
    for (const d of [SAP_COMPUTER, sapComputer(sapBytes(SAP_PROGRAMS[3].src))]) {
      const l = sapLayout(d);
      expect(validateLayout(l, d)).toEqual([]);
      const placed = l.boards.flatMap((b) => b.chips.filter((c) => c.path).map((c) => c.path!.join('.')));
      expect(placed.sort()).toEqual(sapChips(d).map((c) => c.path).sort());
      const refs = l.boards.flatMap((b) => b.chips.map((c) => c.ref));
      expect(refs).toEqual(refs.map((_, i) => `U${i + 1}`));
      for (const b of l.boards) for (const c of b.chips) expect(c.role, `${c.ref} ${c.part}`).toBeTruthy();
    }
    for (const p of sapChips(SAP_COMPUTER).map((c) => c.path)) expect(SAP_ROLES[p], p).toBeTruthy();
  });

  it('single-module boards are valid', () => {
    for (const d of [SAP_AREG, SAP_ALU, SAP_PC, SAP_CLOCK]) expect(validateLayout(moduleLayout(d, { title: d.name, drives: d === SAP_CLOCK ? undefined : d.ports.find((p) => /^(ao|eo|co)$/.test(p.name))?.name }), d)).toEqual([]);
  });

  it('microcode in words', () => {
    expect(sapGloss(0x4000 | 0x0004)).toBe('PC → MAR'); // CO MI
    expect(microTable(2)).toContain('AI ΣO FI');
    expect(microTable(2)).toContain('A + B → A, flags');
  });
});

/** The stage's clock as its edge hooks see it: before, the rising edge settled, after, the fall. */
function edge(sim: GateSim, mon: SapFollower): void {
  mon.before(sim);
  sim.setInput('clk', 1);
  sim.settle();
  mon.after(sim);
  sim.setInput('clk', 0);
  sim.settle();
}

function boot(bytes: number[]): GateSim {
  const sim = new GateSim(flatten(sapComputer(bytes)));
  for (const [k, v] of Object.entries({ clk: 0, prog: 0, addrSw: 0, dataSw: 0, write: 0 })) sim.setInput(k, v);
  sim.reset('zero');
  sim.settle();
  return sim;
}

describe('SAP panel: the golden model in lock step', () => {
  it.each(SAP_PROGRAMS.map((p) => [p.id, p] as const))('%s runs to HLT in step', async (_, p) => {
    const bytes = sapBytes(p.src);
    const sim = boot(bytes), mon = new SapFollower(bytes);
    let c = 0;
    for (; c < 4000 && sapHw(sim).cw >> 15 !== 1; c++) {
      edge(sim, mon);
      expect(mon.mismatch, `cycle ${c}`).toBeNull();
      if (c % 200 === 199) await tick();
    }
    expect(mon.iss.halted).toBe(true);
    expect(mon.outs).toEqual(p.outs);
    // halted: more edges change nothing, still in step
    edge(sim, mon);
    expect(mon.mismatch).toBeNull();
  }, 120_000);

  it('a difference is caught at the next edge, Back restores', () => {
    const bytes = sapBytes(SAP_PROGRAMS[0].src);
    const sim = boot(bytes), mon = new SapFollower(bytes);
    for (let i = 0; i < 7; i++) edge(sim, mon);
    const saved = mon.save();
    mon.iss.a ^= 1;
    edge(sim, mon);
    expect(mon.mismatch).toMatch(/A is .* in the hardware/);
    mon.restore(saved);
    expect(mon.mismatch).toBeNull();
  });

  it('programming by the switches pauses the model, which then takes the hardware\'s RAM', async () => {
    const p = SAP_PROGRAMS.find((q) => q.id === 'countdown')!;
    const bytes = sapBytes(p.src);
    const sim = boot([]), mon = new SapFollower([]);
    sim.setInput('prog', 1);
    sim.settle();
    mon.look(sim);
    expect(mon.stale).toBe(true);
    bytes.forEach((v, i) => {
      for (const [k, x] of [['addrSw', i], ['dataSw', v], ['write', 1], ['write', 0]] as const) { sim.setInput(k, x); sim.settle(); }
    });
    sim.setInput('prog', 0);
    sim.settle();
    expect(sapRam(sim).slice(0, bytes.length)).toEqual(bytes);
    for (let c = 0; c < 2000 && !mon.iss.halted; c++) {
      edge(sim, mon);
      expect(mon.mismatch, `cycle ${c}`).toBeNull();
      if (c % 200 === 199) await tick();
    }
    expect(mon.outs).toEqual(p.outs);
  }, 60_000);
});

describe('the real bus: tri-state drivers at switch level', () => {
  const run = (v: Record<string, number>) => {
    const s = new SwitchSim(flatten(TRISTATE_BUS, { mode: 'switch' }));
    for (const [k, x] of Object.entries(v)) s.setInput(k, x);
    s.settle();
    return s;
  };
  it('one driver sets the line, none leaves it to the pull-down', () => {
    expect(run({ en0: 1, d0: 1, en1: 0, d1: 0, en2: 0, d2: 0 }).getBits(flatten(TRISTATE_BUS, { mode: 'switch' }).root.ports.line)[0]).toBe(B1);
    const s = run({ en0: 0, d0: 1, en1: 0, d1: 1, en2: 0, d2: 1 });
    expect(s.getBits(s.design.root.ports.line)[0]).toBe(B0);
    expect(s.hasShort).toBe(false);
  });
  it('two that disagree short VDD to GND, named', () => {
    const s = run({ en0: 1, d0: 1, en1: 1, d1: 0, en2: 0, d2: 0 });
    expect(s.hasShort).toBe(true);
    expect(shortText(s, s.shorts()[0])).toMatch(/VDD.*GND|GND.*VDD/);
    const agree = run({ en0: 1, d0: 1, en1: 1, d1: 1, en2: 0, d2: 0 });
    expect(agree.hasShort).toBe(false);
  });
});

describe('Appendix C quotes measured numbers', () => {
  it('SAP_COST matches the library', async () => {
    const { SAP_COST } = await import('../src/chapters/ch-sap');
    const { stats } = await import('../src/sim/stats');
    const S = await import('../src/lib/sap');
    const T = await import('../src/lib/ttl');
    const cost = S.sapCost(SAP_COMPUTER);
    expect(cost.chips).toBe(SAP_COST.chips);
    expect(cost.logicNands).toBe(SAP_COST.logic);
    expect(cost.eepromNands).toBe(SAP_COST.perEeprom * SAP_COST.eeproms);
    expect(sapLayout(SAP_COMPUTER).boards.flatMap((b) => b.chips).filter((c) => !c.path).length).toBe(SAP_COST.drawn);
    expect(stats(S.SAP_BUS).nands).toBe(SAP_COST.bus);
    expect(stats(S.SAP_CONTROL).nands - 2 * SAP_COST.perEeprom).toBe(SAP_COST.control);
    expect([stats(S.SAP_CLOCK).nands, stats(S.SAP_AREG).nands, stats(S.SAP_ALU).nands, stats(S.SAP_PC).nands, stats(S.SAP_RAM).nands])
      .toEqual([SAP_COST.clock, SAP_COST.areg, SAP_COST.alu, SAP_COST.pc, SAP_COST.ram]);
    expect([stats(T.LS173).nands, stats(T.LS161).nands, stats(T.LS189).nands]).toEqual([SAP_COST.ls173, SAP_COST.ls161, SAP_COST.ls189]);
  });
});
