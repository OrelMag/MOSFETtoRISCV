import { describe, expect, it } from 'vitest';
import '../src/lib';
import {
  childIds, codesOf, detachFsm, ENCODINGS, encodingCosts, encodingProblem, FSM_TEMPLATE, fsmProblem, fsmWarnings, newFsmChip, nextTable, outTable, ownerOf, setFsm, specOf,
} from '../src/editor/fsmchip';
import { isGenerated } from '../src/editor/hdl';
import { builderViolations, type BuildChallenge } from '../src/editor/challenges';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace, type FsmDoc, type Workspace } from '../src/editor/model';
import { sanitizeChip } from '../src/editor/store';
import { equation } from '../src/editor/ttable';
import { setUserResolver } from '../src/lib/resolve';
import { readbackOk, readFsm } from '../src/sim/fsmread';
import { simulate } from '../src/sim/harness';

const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

function compileAll(ws: Workspace, id: string) {
  const lib = new UserLibrary(ws);
  setUserResolver(lib.resolver());
  for (const c of Object.keys(ws.chips)) expect(lib.compiled(c)!.diags.filter((d) => d.level === 'error'), c).toEqual([]);
  return lib.defOf(id)!;
}

/** Build the machine and read the circuit back: every reachable state and arc as drawn. */
function check(doc: FsmDoc) {
  const { ws, id } = newFsmChip(emptyWorkspace(), doc);
  const r = readFsm(simulate(compileAll(ws, id)), specOf(doc, true));
  const bad = r.arcs.filter((a) => !a.ok).map((a) => `${r.states[a.from].name} ${JSON.stringify(a.inp)} → ${r.states[a.to].name} ${JSON.stringify(a.out)} (spec ${a.specTo} ${JSON.stringify(a.specOut)})`);
  expect(bad, JSON.stringify(doc)).toEqual([]);
  expect(readbackOk(r), JSON.stringify(doc)).toBe(true);
}

function randomFsm(r: () => number): FsmDoc {
  const n = 2 + Math.floor(r() * 5), ni = Math.floor(r() * 3), no = 1 + Math.floor(r() * 2);
  const ins = ['x', 'en'].slice(0, ni), outs = ['y', 'z'].slice(0, no);
  const states = Array.from({ length: n }, (_, i) => ({ name: `S${i}`, at: [80 + 120 * i, 100] as [number, number], ...(r() < 0.4 ? { out: outs.filter(() => r() < 0.6) } : {}) }));
  const arcs: FsmDoc['arcs'] = [];
  for (let s = 0; s < n; s++) {
    const k = Math.floor(r() * 3);
    for (let j = 0; j < k; j++) {
      const when: Record<string, 0 | 1> = {};
      for (const x of ins) if (r() < 0.7) when[x] = r() < 0.5 ? 0 : 1;
      arcs.push({ from: s, to: Math.floor(r() * n), when, ...(r() < 0.3 ? { out: outs.filter(() => r() < 0.7) } : {}) });
    }
  }
  return { ins, outs, states, arcs, reset: Math.floor(r() * n), encoding: 'binary', form: 'nand', ...(r() < 0.3 ? { safe: true as const } : {}) };
}

describe('state-machine chips (editor/fsmchip.ts)', () => {
  it('the 101 detector: binary next state n1 = s0·¬x, n0 = x; y = s1·x', () => {
    const t = nextTable(FSM_TEMPLATE), o = outTable(FSM_TEMPLATE);
    expect(equation(t, 0)).toBe('n1 = s0·¬x');
    expect(equation(t, 1)).toBe('n0 = x');
    expect(equation(o, 0)).toBe('y = s1·x');
  });

  it('builds the template in every encoding and form, with and without safe codes', () => {
    for (const encoding of ENCODINGS) for (const form of ['nand', 'andor', 'pla', 'rom'] as const) for (const safe of [undefined, true as const]) {
      check({ ...FSM_TEMPLATE, encoding, form, ...(safe ? { safe } : {}) });
    }
  });

  it('random machines read back as drawn, in every encoding that fits', () => {
    const r = rng(42);
    for (let k = 0; k < 24; k++) {
      const doc = randomFsm(r);
      expect(fsmProblem(doc)).toBeNull();
      for (const encoding of ENCODINGS) if (!encodingProblem(doc, encoding)) check({ ...doc, encoding });
    }
  });

  it('the read-back catches a circuit that is not the drawn machine', () => {
    const { ws, id } = newFsmChip(emptyWorkspace());
    const wrong: FsmDoc = { ...FSM_TEMPLATE, arcs: FSM_TEMPLATE.arcs.map((a) => (a.out ? { ...a, out: undefined } : a)), outs: ['y'] };
    const r = readFsm(simulate(compileAll(ws, id)), specOf({ ...wrong, states: wrong.states.map((s, i) => (i === 1 ? { ...s, out: ['y'] } : s)) }, true));
    expect(readbackOk(r)).toBe(false);
  });

  it('arcs placed by hand survive the store and reach the diagram; the lock refuses a machine where one is asked for', () => {
    const doc: FsmDoc = { ...FSM_TEMPLATE, arcs: FSM_TEMPLATE.arcs.map((a, i) => (i === 5 ? { ...a, bend: -40, dx: 6, dy: -3 } : i === 0 ? { ...a, loop: 180 } : a)) };
    const { ws, id } = newFsmChip(emptyWorkspace(), doc);
    const back = sanitizeChip(JSON.parse(JSON.stringify(ws.chips[id])))!.fsm!;
    expect(back.arcs[5]).toMatchObject({ bend: -40, dx: 6, dy: -3 });
    expect(back.arcs[0].loop).toBe(180);
    const spec = specOf(back);
    expect(spec.arcs[5]).toMatchObject({ bend: -40, dx: 6, dy: -3 });
    expect(spec.arcs[0].loop).toBe(180);
    const fsmLevel = { fsm: 'rv16_det101', check: { kind: 'sequence', steps: [] } } as unknown as BuildChallenge;
    expect(builderViolations(ws, [id, ...childIds(id) ? [childIds(id).next, childIds(id).out] : []], fsmLevel).length).toBe(1);
  });

  it('codes: the reset state is zero (bit 0 one-hot)', () => {
    const doc = { ...FSM_TEMPLATE, reset: 2 };
    expect(codesOf(doc, 'binary')[2]).toBe(0);
    expect(codesOf(doc, 'gray')).toEqual([1, 3, 0]);
    expect(codesOf(doc, 'onehot')[2]).toBe(1);
  });

  it('costs the encodings and warns about arcs never taken and states never reached', () => {
    const c = encodingCosts(FSM_TEMPLATE);
    expect(c.map((x) => x.dffs)).toEqual([2, 2, 3]);
    expect(c.every((x) => x.nands > x.logic && x.logic > 0)).toBe(true);
    const doc: FsmDoc = { ...FSM_TEMPLATE, states: [...FSM_TEMPLATE.states, { name: 'S3', at: [460, 100] }], arcs: [...FSM_TEMPLATE.arcs, { from: 0, to: 2, when: { x: 1 } }] };
    const w = fsmWarnings(doc);
    expect(w.some((x) => x.includes('never taken'))).toBe(true);
    expect(w.some((x) => x.includes('S3 cannot be reached'))).toBe(true);
  });

  it('three chips, generated; detach frees them; the sanitizer keeps the machine', () => {
    const { ws, id } = newFsmChip(emptyWorkspace());
    expect(Object.keys(ws.chips).sort()).toEqual(['u_fsm', 'u_fsm_next', 'u_fsm_out', 'u_main']);
    expect(isGenerated(ws, id) && isGenerated(ws, 'u_fsm_next')).toBe(true);
    expect(ownerOf(ws, 'u_fsm_next')?.id).toBe(id);
    expect(sanitizeChip(JSON.parse(JSON.stringify(ws.chips[id])))!.fsm).toEqual(ws.chips[id].fsm);
    expect(sanitizeChip(JSON.parse(JSON.stringify(ws.chips.u_fsm_next)))!.table!.of).toBe(id);
    const d = detachFsm(ws, id);
    expect(d.chips[id].fsm).toBeUndefined();
    expect(d.chips.u_fsm_next.table!.of).toBeUndefined();
    expect(ownerOf(d, 'u_fsm_next')).toBeUndefined();
    // an edit redraws all three; a bad name is refused
    const w2 = setFsm(ws, id, { ...ws.chips[id].fsm!, encoding: 'onehot' });
    if ('error' in w2) throw new Error(w2.error);
    expect(w2.chips[id].parts.filter((p) => 'lib' in p.ref && p.ref.lib === 'dff').length).toBe(3);
    expect(setFsm(ws, id, { ...ws.chips[id].fsm!, ins: ['clk'] })).toHaveProperty('error');
  });
});
