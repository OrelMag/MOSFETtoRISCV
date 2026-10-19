// The walkthroughs of acts P and 3–10 (walks3–7) quote numbers and behaviours their reference circuits must keep:
// each is measured or simulated here and compared with the text that quotes it, so an edit to either fails.

import { describe, expect, it } from 'vitest';
import { WALKS3 } from '../src/campaign/walks3';
import { WALKS4 } from '../src/campaign/walks4';
import { WALKS5 } from '../src/campaign/walks5';
import { WALKS6 } from '../src/campaign/walks6';
import { WALKS7 } from '../src/campaign/walks7';
import { nodeById } from '../src/campaign/nodes';
import { FP_REF } from '../src/campaign/buildfp';
import type { WalkScript } from '../src/campaign/walk';
import { RELAY_CLOCK } from '../src/lib/relays';
import { DEC3, RV16_DFF, RV16_DFFE, RV16_REG16, RV16_REG4 } from '../src/lib/rv16/logic';
import { LANEDEC16, MASK16, STACK16, VRF16 } from '../src/lib/rv16/lanes16';
import { resolveComponent } from '../src/lib/resolve';
import { levelChallenge } from '../src/campaign/levels';
import { UserLibrary } from '../src/editor/library';
import { workspace } from './editorkit';
import { BANK16 } from '../src/lib/rv16/mem16';
import { EDGE16, RASTER16 } from '../src/lib/rv16/raster16';
import { RV16_FRAME, RV16_WARPS } from '../src/lib/rv16/warps16';
import { SETUP16 } from '../src/gfx/raster16';
import { RELAY_STEP_MS } from '../src/phys/relay';
import { flatten } from '../src/sim/flatten';
import { evalOnce, simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import { SwitchSim } from '../src/sim/switchsim';
import type { ComponentDef, NetDef } from '../src/sim/types';

const nands = (d: ComponentDef) => stats(d).nands;
const step = (walk: WalkScript | undefined, title: string) => {
  const s = walk?.find((x) => x.title === title);
  if (!s) throw new Error(`no step "${title}"`);
  return s;
};
/** A number as the walks write it: grouped by thin spaces or not. */
const has = (text: string, n: number) => text.includes(String(n)) || text.includes(n.toLocaleString('en-US').replace(/,/g, ' '));

describe('r_clock: the toggle relay and its wrong wirings', () => {
  // k's make contact (k.no2) fed from t's break line (the reference), from VDD, or from y.
  const variant = (feed: 'break' | 'vdd' | 'y'): ComponentDef => {
    const nl = RELAY_CLOCK.netlist!();
    const nets: NetDef[] = nl.nets.flatMap((n): NetDef[] => {
      if (feed === 'break') return [n];
      if (n.name === 'N') return []; // t's break line left open
      if (n.name === (feed === 'vdd' ? 'vdd t' : 'y')) return [{ ...n, ends: [...n.ends, 'k.no2'] }];
      return [n];
    });
    return { ...RELAY_CLOCK, id: `t_relay_clock_${feed}`, netlist: () => ({ ...nl, nets }) };
  };
  const run = (feed: 'break' | 'vdd' | 'y') => {
    const sim = new SwitchSim(flatten(variant(feed), { mode: 'switch' }));
    sim.setInput('en', 1);
    const qs: number[] = [];
    for (let i = 0; i < 24; i++) { sim.step(); qs.push(sim.getBits(sim.design.root.ports.q)[0]); }
    return qs.slice(8);
  };

  it('fed from t\'s break line, q changes every second relay step', () => {
    const q = run('break');
    expect(new Set(q).size).toBe(2);
    for (let i = 4; i < q.length; i++) expect(q[i]).toBe(q[i - 4]);
  });

  it('the whys say what VDD and y really do: q sticks at 1, q sticks at 0', () => {
    expect(new Set(run('vdd'))).toEqual(new Set([1]));
    expect(new Set(run('y'))).toEqual(new Set([0]));
    const why = step(WALKS3.r_clock, 'A relay that toggles').ask!.why!;
    expect(why[2]).toMatch(/q sticks at 1/);
    expect(why[3]).toMatch(/q sticks at 0/);
  });

  it('quotes the model\'s relay step', () => {
    expect(step(WALKS3.r_clock, 'The buzzer').text).toContain(`${2 * RELAY_STEP_MS} ms at ${RELAY_STEP_MS} ms a step`);
  });
});

describe('act 3: gating a clock', () => {
  it('h_loader says why its gate is safe; the act 3 whys name the condition, not a blanket rule', () => {
    expect(step(WALKS3.h_loader, 'Hold the CPU by its clock').text).toMatch(/run changes only while clk is low/);
    const whys = [WALKS4.s_cnt4, WALKS4.m_ram].flatMap((w) => (w ?? []).flatMap((s) => s.ask?.why ?? []));
    expect(whys.filter((w) => /Never gate the clock[:. (]/.test(w))).toEqual([]);
    expect(whys.filter((w) => /can change while (clk|it) is high/.test(w)).length).toBeGreaterThanOrEqual(2);
  });
});

describe('k_frame: 7-bit vertex registers', () => {
  const total = nands(RV16_FRAME);
  const vertex = nands(RV16_REG4) + 3 * nands(RV16_DFFE);
  const regs = 6 * vertex + nands(RV16_REG16);

  it('par is the reference', () => {
    expect(nodeById('k_frame')!.par!.nand).toBe(total);
  });

  it('the walk quotes the registers, their saving over 16 bits and the total', () => {
    const t = step(WALKS6.k_frame, 'The device registers').text;
    expect(has(t, vertex)).toBe(true);
    expect(has(t, regs)).toBe(true);
    expect(has(t, 6 * (nands(RV16_REG16) - vertex))).toBe(true);
    const h = step(WALKS6.k_frame, 'Hold while busy').text;
    const rest = total - nands(RV16_WARPS) - nands(RASTER16) - regs;
    expect(h).toMatch(new RegExp(`^.*${total} NANDs: the two-warp core, the rasterizer, ${regs} for the registers and ${rest} for the rest`));
  });
});

describe('numbers in other act 8–10 walks', () => {
  it('k_raster: the set-up chain is load, two sign steps, 14 shift-and-add steps, bias, cull', () => {
    expect(SETUP16).toBe(1 + 2 + 14 + 1 + 1);
    expect(step(WALKS6.k_raster, 'Set-up steps').text).toMatch(new RegExp(`14 shift-and-add steps.*${SETUP16} cycles`));
  });

  it('k_edge: |E| fits 16 bits', () => {
    expect(2 * 127 * 127).toBeLessThan(2 ** 15);
    expect(step(WALKS6.k_edge, 'E and R').text).toContain(`${(2 * 127 * 127).toLocaleString('en-US').replace(',', ' ')}`);
  });

  it('m_bank: the state is three 4-bit registers and a flip-flop', () => {
    const t = step(WALKS7.m_bank, 'The refresh state').text;
    expect(has(t, 3 * nands(RV16_REG4) + nands(RV16_DFF))).toBe(true);
    expect(has(t, nands(BANK16))).toBe(true);
  });

  it('o_fpcvt: unsigned 65 520 and up overflows to ∞ when rounding to nearest', () => {
    const d = FP_REF.cvt(), sim = simulate(d);
    const at = (x: number, rm: number) => evalOnce(sim, [x, 0, rm]);
    expect(at(65519, 0)).toEqual([0x7bff, 1]); // NX
    expect(at(65520, 0)).toEqual([0x7c00, 5]); // OF + NX
    expect(at(65535, 1)).toEqual([0x7bff, 1]); // toward zero: the largest finite
    expect(step(WALKS5.o_fpcvt, 'Normalize and round').text).toMatch(/65 520.*65 504/);
  });
});

describe('costs the act 4–9 walks quote, measured live', () => {
  // A reference's NANDs as Check counts them: its chips compiled, the top's stats.
  const ref = (id: string) => {
    const ch = levelChallenge(nodeById(id)!)!, chips = ch.answer(), main = chips[chips.length - 1];
    return nands(new UserLibrary(workspace(main, ...chips.slice(0, -1))).compiled(main.id)!.def);
  };
  const lib = (id: string) => nands(resolveComponent(id)!);
  const expectIn = (walk: WalkScript | undefined, title: string, ...ns: number[]) => {
    const t = step(walk, title).text;
    for (const n of ns) expect(has(t, n), `${title}: ${n} in "${t}"`).toBe(true);
  };

  it('single-cycle cores (walks4, walks5)', () => {
    const core3 = ref('c_core3');
    expectIn(WALKS4.c_fast, 'Write back', ref('c_fast'), ref('c_fast') - core3);
    expectIn(WALKS4.o_bpred, 'Check in E', ref('o_bpred'));
    expectIn(WALKS4.o_mc, 'The PC loads in W', ref('o_mc'), ref('o_mc') - core3);
    expectIn(WALKS5.o_mcore, 'Core III, as before', core3);
    expectIn(WALKS5.o_mcore, 'Write the product', ref('o_mcore'), ref('o_mcore') - core3);
    expectIn(WALKS5.o_dcore, 'Write once, at the end', ref('o_dcore'));
  });

  it('lane and warp cores, the rasterizer (walks6)', () => {
    const rf = lib('rv16_rf'), vrf = nands(VRF16), simd = ref('k_simd'), simt = ref('k_simt'), warps = nands(RV16_WARPS);
    expect(vrf).toBe(4 * rf);
    expectIn(WALKS6.k_vrf, 'Lane 0\'s registers', rf);
    expectIn(WALKS6.k_vrf, 'Lanes 2 and 3', rf, vrf, simd);
    expectIn(WALKS6.k_simd, 'One front end', nands(LANEDEC16));
    expectIn(WALKS6.k_simd, 'Lane registers', vrf, Math.round((100 * vrf) / simd));
    expectIn(WALKS6.k_simd, 'The PC', simd);
    expectIn(WALKS6.k_simt, 'The join\'s jump', simt, simt - simd);
    const warp = lib('rv16_reg16') + nands(MASK16) + nands(STACK16) + vrf + nands(RV16_DFF);
    expectIn(WALKS6.k_warps, 'State, twice', vrf, warp);
    expectIn(WALKS6.k_warps, 'bar', warps, simt);
    expectIn(WALKS6.k_edge, 'Decode the command', nands(DEC3));
    expectIn(WALKS6.k_edge, 'inside', nands(EDGE16));
    expectIn(WALKS6.k_raster, 'Three edge steppers', nands(EDGE16));
    expectIn(WALKS6.k_raster, 'Write a pixel', nands(RASTER16));
    expectIn(WALKS6.k_frame, 'State per warp, as before', warp);
    expectIn(WALKS6.k_frame, 'Masks, stacks, PCs, bar, as before', warps);
    expectIn(WALKS6.k_frame, 'The rasterizer', nands(RASTER16));
  });
});
