// The switch capstone: the bench holds the reference to the sheet, and refuses switches that break a rule.

import { describe, expect, it } from 'vitest';
import { capstoneChallenge, capstoneRule } from '../src/campaign/capstone';
import { runSwitchSpec } from '../src/campaign/capcomm';
import { checkChallenge } from '../src/editor/challenges';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { Builder } from '../src/lib/builder';
import { define, merger, ones, splitter } from '../src/lib/define';
import { DFF, register } from '../src/lib/sequential';
import { TIE0, TIE1 } from '../src/lib/transistors';
import { tick } from './yieldtick';
import { ethSwitch } from '../src/lib/ethswitch';
import type { ComponentDef } from '../src/sim/types';

const REF = () => ethSwitch({ cellK: 8 });
const OUTS = [0, 1, 2, 3].flatMap((i) => [`rxReady${i}`, `txData${i}`, `txValid${i}`, `txLast${i}`]);

/** The switch with an output changed, or two swapped, as a wrong design might have it. */
function mutant(name: string, change: (b: Builder, wire: (from: string, to: string) => void) => string[]): ComponentDef {
  const ref = REF(), ports = ref.ports.filter((p) => p.dir === 'in' || OUTS.includes(p.name)), ins = ports.filter((p) => p.dir === 'in').map((p) => p.name);
  return define({
    id: `switch_mut_${name}`, name, category: 'routing', summary: '', ports, symbol: { kind: 'box', label: 'M' },
    netlist: () => {
      const b = new Builder(10, 12);
      b.pins(...ins);
      b.add(ref, 'core', 'core');
      for (const p of ins) b.wire(p, `core.${p}`);
      const done = change(b, (from, to) => b.wire(from, to));
      for (const o of OUTS) if (!done.includes(o)) b.wire(`core.${o}`, o);
      return { pins: Object.fromEntries(ports.map((p, i) => [p.name, [p.dir === 'in' ? 0 : b.right, i * 2]])) as Record<string, [number, number]>, instances: b.instances, nets: b.nets() };
    },
  });
}

describe('the switch capstone', () => {
  it('the library switch meets the sheet at the ports', () => {
    const r = runSwitchSpec(REF(), 'gate');
    expect(r.failures).toEqual([]);
    expect(r.tested).toBeGreaterThan(20);
  }, 300_000);
  it('a wrong design fails, and the bench says what was wrong', async () => {
    const cases: [string, Parameters<typeof mutant>[1], RegExp][] = [
      // port 1's output wired to port 2's and the other way round: frames reach the wrong port
      ['swap', (_, w) => { for (const s of ['txData', 'txValid', 'txLast']) { w(`core.${s}1`, `${s}2`); w(`core.${s}2`, `${s}1`); } return ['txData1', 'txValid1', 'txLast1', 'txData2', 'txValid2', 'txLast2']; }, /belongs on/],
      // one data bit stuck: the frames are changed
      ['bit', (b, w) => { const sp = b.op(splitter(ones(8)), ['core.txData3'], undefined, 'sp'), z = b.op(TIE0, [], undefined, 'z'); w(b.op1(merger(ones(8)), Array.from({ length: 8 }, (_, i) => (i === 3 ? `${z}.y` : `${sp}.o${i}`))), 'txData3'); return ['txData3']; }, /changed the frame/],
      // an output that ignores nothing but drops every last: frames never end
      ['nolast', (b, w) => { const z = b.op(TIE0, [], undefined, 'z'); w(`${z}.y`, 'txLast0'); return ['txLast0']; }, /belongs on/],
      // a port that never accepts anything
      ['deaf', (b, w) => { const z = b.op(TIE0, [], undefined, 'z'); w(`${z}.y`, 'txValid2'); return ['txValid2']; }, /belongs on/],
    ];
    for (const [name, change, want] of cases) {
      await tick();
      expect(runSwitchSpec(mutant(name, change), 'gate').failures.join(' | '), name).toMatch(want);
    }
  }, 300_000);
  it('a right design that takes longer passes: nothing in the sheet fixes the latency', () => {
    const late = define({
      id: 'switch_late_inputs', name: 'late', category: 'routing', summary: '', symbol: { kind: 'box', label: 'L' },
      ports: REF().ports.filter((p) => p.dir === 'in' || OUTS.includes(p.name)),
      netlist: () => {
        const b = new Builder(10, 12), ports = late.ports, ins = ports.filter((p) => p.dir === 'in').map((p) => p.name);
        b.pins(...ins);
        b.add(REF(), 'core', 'core');
        b.add(TIE1, 'tie', 'one');
        for (const p of ins) {
          if (!/^rx/.test(p)) { b.wire(p, `core.${p}`); continue; }
          let at = p;
          for (let k = 0; k < 16; k++) at = /^rxData/.test(p) ? b.op1(register(8), [at, 'one.y', 'clk']) : b.op1(DFF, [at, 'clk']);
          b.wire(at, `core.${p}`);
        }
        for (const o of OUTS) b.wire(`core.${o}`, o);
        return { pins: Object.fromEntries(ports.map((p, i) => [p.name, [p.dir === 'in' ? 0 : b.right, i * 2]])) as Record<string, [number, number]>, instances: b.instances, nets: b.nets() };
      },
    });
    expect(runSwitchSpec(late, 'gate').failures).toEqual([]);
  }, 300_000);
  it('the table the sheet asks for is enough, and half of it is not', async () => {
    expect(runSwitchSpec(ethSwitch({ cellK: 8, tableK: 3 }), 'gate').failures).toEqual([]);
    await tick();
    expect(runSwitchSpec(ethSwitch({ cellK: 8, tableK: 2 }), 'gate').failures.length).toBeGreaterThan(0);
  }, 300_000);
  it('the machines are the learner\'s: none of them is a part', () => {
    const lib = (capstoneRule('cap_switch') as { lib: string[] }).lib;
    for (const banned of ['eth_in_8fs_rx', 'eth_in_8fs_tx', 'mac_table7_4_look', 'mac_table7_4_age', 'eth_in_8fs', 'mac_table7_4', 'eth_xbar']) expect(lib, banned).not.toContain(banned);
    for (const given of ['eth_in_8fs_mem', 'mac_table7_4_ram', 'eth_in_8fs_count']) expect(lib, given).toContain(given);
  });
  it('the reference passes, drawn as chips and checked as a learner\'s would be, within its allowed parts', () => {
    const ch = capstoneChallenge('cap_switch')!, chips = ch.answer();
    const ws = { ...emptyWorkspace(), chips: Object.fromEntries(chips.map((d) => [d.id, d])) };
    const r = checkChallenge(ch, new UserLibrary(ws).compiled(chips[chips.length - 1].id));
    expect(r.restrictionViolations).toEqual([]);
    expect(r.failures ?? []).toEqual([]);
    expect(r.ok).toBe(true);
  }, 300_000);
});
