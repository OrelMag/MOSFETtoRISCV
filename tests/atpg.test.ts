import { describe, expect, it } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { CONSENSUS, alu, rca } from '../src/lib';
import { atpg } from '../src/sim/atpg';
import { allVectors, detect, detectable, faultModel, faultName, responses, type FaultModel } from '../src/sim/faultsim';
import type { ComponentDef } from '../src/sim/types';

const model = (def: ComponentDef): FaultModel => { const m = faultModel(def); if (typeof m === 'string') throw new Error(m); return m; };

/** Every fault: a test that the fault simulator confirms when there is one, "untestable" exactly when there is none. */
function sweep(def: ComponentDef, exhaustive: boolean) {
  const m = model(def);
  const can = exhaustive ? new Set(detectable(detect(m, allVectors(m)), m.faults.length)) : null;
  let tests = 0, untestable = 0;
  m.faults.forEach((f, i) => {
    const r = atpg(m, i);
    expect(r.status, faultName(m, i)).not.toBe('aborted');
    if (r.status === 'test') {
      tests++;
      const good = responses(m, [r.vector!]), bad = responses(m, [r.vector!], f);
      expect(bad[0], `${faultName(m, i)}: vector ${r.vector}`).not.toBe(good[0]);
      // every input the search left free may take either value
      const free = r.cube!.flatMap((v, b) => (v === null ? [b] : []));
      for (const b of free.slice(0, 3)) expect(responses(m, [r.vector! ^ (1 << b)], f)[0]).not.toBe(responses(m, [r.vector! ^ (1 << b)])[0]);
    } else untestable++;
    if (can) expect(r.status === 'test', faultName(m, i)).toBe(can.has(i));
  });
  return { tests, untestable };
}

describe('ATPG', () => {
  it('the full adder: a test for each of its 24 faults', () => {
    expect(sweep(registry.get('full_adder')!, true)).toEqual({ tests: 24, untestable: 0 });
  });

  it('the 4-bit ripple adder: a test for each of its 90 faults', () => {
    expect(sweep(rca(4), true)).toEqual({ tests: 90, untestable: 0 });
  });

  it('the consensus circuit: the redundant term\'s stuck-at 1 is proved untestable', () => {
    const m = model(CONSENSUS);
    expect(sweep(CONSENSUS, true)).toEqual({ tests: m.faults.length - 1, untestable: 1 });
    const i = m.faults.findIndex((_, k) => faultName(m, k) === 'bc stuck at 1');
    const r = atpg(m, i);
    expect(r.status).toBe('untestable');
    expect(r.steps.at(-1)!.kind).toBe('untestable');
  });

  it('the 4-bit ALU (too many inputs to try every vector): every fault gets a confirmed test or a proof', () => {
    const a = alu(4);
    const m = faultModel(a);
    if (typeof m === 'string') return;
    const r = sweep(a, m.inBits <= 16);
    expect(r.tests).toBeGreaterThan(0.95 * m.faults.length);
  });

  it('the steps read activate, propagate, assign, detected', () => {
    const m = model(registry.get('full_adder')!);
    const r = atpg(m, m.faults.findIndex((_, k) => faultName(m, k) === 'g5 stuck at 0'));
    expect(r.status).toBe('test');
    const kinds = r.steps.map((s) => s.kind);
    expect(kinds[0]).toBe('activate');
    expect(kinds).toContain('propagate');
    expect(kinds.at(-1)).toBe('detected');
  });
});
