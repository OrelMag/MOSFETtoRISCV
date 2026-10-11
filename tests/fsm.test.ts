import { describe, expect, it } from 'vitest';
import { DET101, DET101_FSM, FSMS, MC_FSM, MC_FSM_SPEC, MC_MICRO, MC_STATES, NAND, NOT, OR, RV16_DFF, fsmNext, fsmOut, registry } from '../src/lib';
import { Builder } from '../src/lib/builder';
import { define } from '../src/lib/define';
import { readFsm, readbackOk, readbackSpec } from '../src/sim/fsmread';
import { simulate } from '../src/sim/harness';
import { netlistOf } from '../src/sim/types';
import type { ComponentDef } from '../src/sim/types';

/** DET101 with the bug of the campaign mockup: n1 = ¬x·(s0 + s1), so S2 holds on x = 0. */
const BUGGY: ComponentDef = (() => {
  const b = new Builder(8, 10, 4);
  b.pins('x', 'rst', 'clk');
  const nx = b.op1(NOT, ['x']), nr = b.op1(NOT, ['rst']);
  b.next();
  const n0 = b.op1(NOT, [b.op1(NAND, ['x', nr])]);
  const h1 = b.op1(NOT, [b.op1(NAND, [nx, nr])]);
  b.next();
  const either = b.op1(OR, ['', '']);
  const k1 = b.op1(NAND, [h1, either]);
  b.next();
  const n1 = b.op1(NOT, [k1]);
  b.next();
  const s0 = `${b.op(RV16_DFF, [n0, 'clk'])}.q`, s1 = `${b.op(RV16_DFF, [n1, 'clk'])}.q`;
  const og = either.split('.')[0];
  b.wire(s0, `${og}.a`);
  b.wire(s1, `${og}.b`);
  b.next();
  b.wire(b.op1(NOT, [b.op1(NAND, ['x', s1])]), 'y');
  const R = b.right;
  return define({
    id: 'test_det101_bug', name: 'buggy 101', category: 'sequential',
    ports: [{ name: 'x', width: 1, dir: 'in' }, { name: 'rst', width: 1, dir: 'in' }, { name: 'clk', width: 1, dir: 'in', clock: true }, { name: 'y', width: 1, dir: 'out' }],
    symbol: { kind: 'box', label: 'bug' },
    netlist: () => ({ pins: { x: [0, 4], rst: [0, 8], clk: [0, 12], y: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

describe('state machine specs', () => {
  it('every registered spec reads back from its circuit exactly', () => {
    for (const [id, spec] of Object.entries(FSMS)) {
      const r = readFsm(simulate(registry.get(id)!, 'gate'), spec);
      expect(r.arcs.filter((a) => !a.ok), id).toEqual([]);
      expect(readbackOk(r), id).toBe(true);
      expect(r.states.map((s) => s.spec).sort((a, b) => a - b), id).toEqual(spec.states.map((_, i) => i));
    }
  });

  it('the multicycle spec is the state table', () => {
    expect(MC_FSM_SPEC.states.map((s) => s.name)).toEqual(MC_STATES.map((s) => s.name));
    // a load: Fetch → Decode → MemAdr → MemRead → MemWB → Fetch
    const op = 0x03;
    const path = [0];
    for (let i = 0; i < 5; i++) path.push(fsmNext(MC_FSM_SPEC, path[path.length - 1], { op }));
    expect(path.map((i) => MC_STATES[i].name)).toEqual(['Fetch', 'Decode', 'MemAdr', 'MemRead', 'MemWB', 'Fetch']);
    expect(fsmOut(MC_FSM_SPEC, 0, { op }).irWrite).toBe(1);
  });

  it('arc parts name instances of the reference circuit', () => {
    for (const [def, spec] of [[MC_FSM, MC_FSM_SPEC], [DET101, DET101_FSM]] as const) {
      const names = new Set(netlistOf(def)!.instances.map((i) => i.name));
      for (const a of spec.arcs) for (const p of a.parts ?? []) expect(names.has(p), `${def.id}: ${p}`).toBe(true);
    }
    // every opcode-dependent AND gate of the hardwired controller belongs to an arc
    const lit = new Set(MC_FSM_SPEC.arcs.flatMap((a) => a.parts ?? []));
    for (const i of netlistOf(MC_FSM)!.instances) if (/^t\d+$/.test(i.name)) expect(lit.has(i.name), i.name).toBe(true);
  });

  it('the microcode controller reads back the same machine', () => {
    const a = readFsm(simulate(MC_FSM, 'gate'), MC_FSM_SPEC), b = readFsm(simulate(MC_MICRO, 'gate'), MC_FSM_SPEC);
    expect(b.arcs.map((x) => [x.from, x.to, x.inp.op])).toEqual(a.arcs.map((x) => [x.from, x.to, x.inp.op]));
  });

  it('a wrong circuit shows the wrong arc and the expected one', () => {
    const r = readFsm(simulate(BUGGY, 'gate'), DET101_FSM);
    expect(readbackOk(r)).toBe(false);
    const bad = r.arcs.filter((a) => !a.ok);
    expect(bad.map((a) => [r.states[a.from].name, a.inp.x, r.states[a.to].name, DET101_FSM.states[a.specTo].name])).toEqual([['S2', 0, 'S2', 'S0']]);
    const d = readbackSpec(DET101_FSM, r);
    expect(d.arcs.filter((a) => a.cls === 'bad').map((a) => [a.from, a.to, a.label])).toEqual([[2, 2, '0/0']]);
    expect(d.arcs.filter((a) => a.cls === 'spec').map((a) => [a.from, a.to, a.label])).toEqual([[2, 0, '0/0']]);
  });
});
