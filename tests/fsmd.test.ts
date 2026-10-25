import { describe, expect, it } from 'vitest';
import '../src/lib';
import { ctlId, detachFsm, ENCODINGS, encodingProblem, fsmOwnerOf, newFsmChip, setFsm } from '../src/editor/fsmchip';
import { controllerOf, dataProblem, fsmdCheck, fsmdStep, type FsmdState, GCD_FSMD, parseExpr, parseTest, planOf } from '../src/editor/fsmd';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace, type FsmDoc, type Workspace } from '../src/editor/model';
import { sanitizeChip } from '../src/editor/store';
import { setUserResolver } from '../src/lib/resolve';
import { simulate } from '../src/sim/harness';
import { pack } from '../src/sim/values';

const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

function compileAll(ws: Workspace, id: string) {
  const lib = new UserLibrary(ws);
  setUserResolver(lib.resolver());
  for (const c of Object.keys(ws.chips)) expect(lib.compiled(c)!.diags.filter((d) => d.level === 'error'), c).toEqual([]);
  return lib.defOf(id)!;
}

function randomFsmd(r: () => number): FsmDoc {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const regs = ['a', 'b', 'c'].slice(0, 1 + Math.floor(r() * 2)), dins = ['x', 'y'].slice(0, 1 + Math.floor(r() * 2));
  const opnd = () => (r() < 0.15 ? String(Math.floor(r() * 16)) : pick([...regs, ...dins]));
  const expr = () => { const k = r(); return k < 0.25 ? opnd() : k < 0.4 ? `${pick(regs)} ${pick(['<<', '>>'])} ${1 + Math.floor(r() * 3)}` : `${opnd()} ${pick(['+', '-', '&', '|', '^'])} ${opnd()}`; };
  const test = () => (r() < 0.3 ? `${pick(regs)}[${Math.floor(r() * 8)}]` : `${pick(regs)} ${pick(['=', '≠', '<', '≤', '>', '≥'])} ${opnd()}`);
  const n = 2 + Math.floor(r() * 3);
  const states = Array.from({ length: n }, (_, i) => ({
    name: `S${i}`, at: [80 + 110 * i, 100] as [number, number],
    act: regs.filter(() => r() < 0.5).map((g) => ({ reg: g, expr: expr() })),
    ...(r() < 0.3 ? { out: ['done'] } : {}),
  }));
  const arcs: FsmDoc['arcs'] = [];
  for (let s = 0; s < n; s++) for (let j = 0; j < 1 + Math.floor(r() * 2); j++) {
    arcs.push({ from: s, to: Math.floor(r() * n), when: r() < 0.5 ? { go: r() < 0.5 ? 1 : 0 } : {}, ...(r() < 0.6 ? { test: [{ expr: test(), is: r() < 0.5 ? 1 : 0 }] } : {}) });
  }
  return { ins: ['go'], outs: ['done'], states, arcs, reset: 0, encoding: 'binary', form: 'nand', data: { width: 8, ins: dins, regs, outs: [{ name: 'out', src: regs[0] }] } };
}

describe('state machines with a datapath (editor/fsmd.ts)', () => {
  const d = GCD_FSMD.data!;

  it('parses transfers and tests, and says what is wrong', () => {
    expect(parseExpr('a − b', d)).toMatchObject({ op: '-', a: { kind: 'reg', name: 'a' }, b: { kind: 'reg', name: 'b' } });
    expect(parseExpr('a << 2', d)).toMatchObject({ op: '<<', k: 2 });
    expect(parseExpr('0x10', d)).toMatchObject({ op: null, a: { kind: 'k', v: 16 } });
    expect(parseExpr('a * b', d)).toHaveProperty('error');
    expect(parseExpr('q + 1', d)).toHaveProperty('error');
    expect(parseExpr('300', d)).toHaveProperty('error');
    expect(parseTest('a ≤ b', d)).toMatchObject({ cmp: 'le' });
    expect(parseTest('b[7]', d)).toMatchObject({ k: 7 });
    expect(parseTest('a[8]', d)).toHaveProperty('error');
    expect(dataProblem(GCD_FSMD)).toBeNull();
    expect(dataProblem({ ...GCD_FSMD, states: GCD_FSMD.states.map((s, i) => (i === 2 ? { ...s, act: [{ reg: 'a', expr: 'a / b' }] } : s)) })).toMatch(/SUBA/);
  });

  it('GCD: one subtractor shared by SUBA and SUBB, a comparator for a and b', () => {
    const plan = planOf(GCD_FSMD);
    expect(plan.units.length).toBe(1);
    expect(plan.units[0].keys.length).toBe(2);
    expect(plan.pairs.length).toBe(1);
    expect(plan.tests.length).toBe(2);
    const ctl = controllerOf(GCD_FSMD, 'u_x');
    if ('error' in ctl) throw new Error(ctl.error);
    expect(ctl.ins).toEqual(['start', 'st0', 'st1']);
    expect(ctl.outs).toEqual(['done', 'ld_a', 'sel_a0', 'ld_b', 'sel_b0', 'u0s0']);
  });

  it('GCD on the gates: the circuit follows the machine every cycle, and gcd(48, 18) = 6', () => {
    const { ws, id } = newFsmChip(emptyWorkspace(), GCD_FSMD, 'GCD');
    expect(Object.keys(ws.chips)).toEqual(expect.arrayContaining([id, ctlId(id), `${ctlId(id)}_next`, `${ctlId(id)}_out`]));
    const def = compileAll(ws, id);
    expect(fsmdCheck(simulate(def), GCD_FSMD, 300, 7)).toBeNull();
    const sim = simulate(def);
    sim.reset('zero');
    const tick = () => { sim.setInput('clk', 0); sim.settle(); sim.setInput('clk', 1); sim.settle(); };
    sim.setInput('rst', 1); tick(); sim.setInput('rst', 0);
    sim.setInput('x', 48); sim.setInput('y', 18); sim.setInput('start', 1);
    let cycles = 0;
    let st: FsmdState = { s: 0, regs: { a: 0, b: 0 } };
    while (cycles < 100) {
      tick();
      cycles++;
      st = fsmdStep(GCD_FSMD, st, { bits: { start: 1 }, data: { x: 48, y: 18 } }).next;
      sim.setInput('clk', 0); sim.settle();
      if (pack(sim.getBits(sim.design.root.ports.done)) === 1) break;
    }
    expect(pack(sim.getBits(sim.design.root.ports.gcd))).toBe(6);
    expect(st.regs.a).toBe(6);
  });

  it('random machines with a datapath match the reference, every encoding and form that fits', () => {
    const r = rng(5);
    let built = 0;
    for (let k = 0; k < 14; k++) {
      const doc = randomFsmd(r);
      expect(dataProblem(doc), JSON.stringify(doc)).toBeNull();
      for (const encoding of ENCODINGS) {
        const form = (['nand', 'andor', 'pla', 'rom'] as const)[(k + encoding.length) % 4];
        const m = { ...doc, encoding, form };
        if (encodingProblem(m, encoding)) continue;
        const ctl = controllerOf(m, 'x');
        if ('error' in ctl) continue; // too many control lines for one controller: refused, said why
        const { ws, id } = newFsmChip(emptyWorkspace(), m);
        expect(fsmdCheck(simulate(compileAll(ws, id)), m, 120, k + 1), JSON.stringify(m)).toBeNull();
        built++;
      }
    }
    expect(built).toBeGreaterThan(20);
  });

  it('the controller is generated (read-only there); detach frees it; the store keeps the datapath', () => {
    const { ws, id } = newFsmChip(emptyWorkspace(), GCD_FSMD, 'GCD');
    expect(fsmOwnerOf(ws, ctlId(id))?.id).toBe(id);
    const back = sanitizeChip(JSON.parse(JSON.stringify(ws.chips[id])))!.fsm!;
    expect(back.data).toEqual(GCD_FSMD.data);
    expect(back.states[2].act).toEqual(GCD_FSMD.states[2].act);
    expect(back.arcs[1].test).toEqual(GCD_FSMD.arcs[1].test);
    expect(sanitizeChip(JSON.parse(JSON.stringify(ws.chips[ctlId(id)])))!.fsm!.of).toBe(id);
    const free = detachFsm(ws, id);
    expect(fsmOwnerOf(free, ctlId(id))).toBeUndefined();
    // an edit that makes the datapath wrong is refused with the reason
    const bad = setFsm(ws, id, { ...GCD_FSMD, data: { ...d, outs: [{ name: 'gcd', src: 'nope' }] } });
    expect(bad).toHaveProperty('error');
  });
});
