// Chapter 'vmem': every number its prose quotes is counted or measured; pinned here, with the models the widgets use held to the golden model.
import { describe, expect, it } from 'vitest';
import { vmFigures, chVmem } from '../src/chapters/ch-vmem';
import { ISS } from '../src/riscv/iss';
import { ACCESSES, leafOutcome } from '../src/sim/pteinfo';
import { TlbModel, missesOf, pagesOf } from '../src/sim/tlbmodel';
import { VM_A, VM_D, VM_R, VM_U, VM_V, VM_W, VM_X, vmPte } from '../src/riscv/vmprograms';
import { WALK_CASES, benchPages, placement, tlbNands, vmCoreNands, walkWorld } from '../src/widgets/vmem';
import { BENCHMARKS } from '../src/riscv/benchprograms';

describe('the figures the chapter quotes', () => {
  it('NANDs and delays of the virtual-memory CPU against the system CPU of chapters 19-20', () => {
    expect(vmFigures()).toEqual({
      tlbI: 3632, tlbD: 3848, walker: 691, mmu: 8765, permitI: 15, permitD: 32,
      base: 67131, vm: 79701, basePeriod: 126, vmPeriod: 169, fetchLookup: 28, dataLookup: 41,
    });
  });
  it('TLBs of 2, 4, 8, 16 and 32 entries, both sides, counted from the generators', () => {
    expect([1, 2, 3, 4, 5].map(tlbNands)).toEqual([3624, 7480, 15174, 30560, 61362]);
    expect(vmCoreNands()).toBe(79701);
  });
  it('the benchmark programs touch one page of code and one of data: two cold misses', () => {
    for (const b of BENCHMARKS.filter((x) => !x.needs)) {
      const r = benchPages(b.id);
      expect([r.codePages, r.dataPages, r.misses]).toEqual([1, 1, 2]);
    }
    expect(benchPages('fib').instructions).toBe(4881);
  });
});

describe('the TLB model', () => {
  it('a cyclic stream over more pages than entries misses every access; one that fits, only the first touches', () => {
    expect(missesOf(pagesOf('stride', 8, 1000), 4).misses).toBe(1000);
    expect(missesOf(pagesOf('stride', 8, 1000), 8).misses).toBe(8);
    expect(missesOf(pagesOf('stride', 16, 1000), 8).misses).toBe(1000);
  });
  it('replaces in turn, not least recently used', () => {
    const t = new TlbModel(2);
    [1, 2, 1].forEach((p) => t.access(p));
    t.access(3); // evicts page 1 (the oldest fill), although page 1 was just used
    expect(t.access(2)).toBe(true);
    expect(t.access(1)).toBe(false);
  });
});

describe('the widgets\' rules against the golden model', () => {
  it('leafOutcome equals ISS.walk for every flag combination, both modes, all three accesses', () => {
    let checked = 0;
    for (let flags = 0; flags < 256; flags++) {
      const iss = new ISS([], { system: true, vm: true, dmemWords: 2 ** 12 });
      iss.dmem[0] = vmPte(0x1000, VM_V); // root[0] -> the second table
      iss.dmem[0x1000 / 4 + 1] = vmPte(0x2000, flags & 0xdf | 0); // leaf [1], G (bit 5) cleared: unused by the walk
      iss.satp = 1 << 31;
      for (const [priv, p] of [[0, 0], [3, 1]] as const) {
        for (const access of ACCESSES) {
          const w = iss.walk(0x1000, access, p === 1 ? 1 : 0);
          void priv;
          expect(leafOutcome(flags & 0xdf, p, access).ok, `flags ${flags.toString(2)} priv ${p} ${access}`).toBe(w.fault === undefined);
          checked++;
        }
      }
    }
    expect(checked).toBe(256 * 6);
    expect([VM_V, VM_R, VM_W, VM_X, VM_U, VM_A, VM_D]).toEqual([1, 2, 4, 8, 16, 64, 128]);
  });
  it('the walk widget\'s five addresses end as it says', () => {
    const iss = walkWorld();
    const outcomes = WALK_CASES.map((c) => { const w = iss.walk(c.va, c.access, 0); return [w.ptes.length, w.fault ?? 0, w.superpage ? 1 : 0, w.pa ?? -1]; });
    expect(outcomes).toEqual([[2, 0, 0, 0x2aa2c], [2, 13, 0, -1], [1, 0, 1, 0x400123], [2, 13, 0, -1], [1, 15, 0, -1]]);
  });
  it('placement: three frames free but not in a row', () => {
    expect(placement('none', false).frames.filter((f) => f === 'A').length).toBe(1);
    expect(placement('base', true).fits).toBe(false);
    const p = placement('paging', true);
    expect(p.fits).toBe(true);
    expect(p.frames.filter((f) => f === 'C')).toHaveLength(3);
  });
});

describe('the chapter', () => {
  it('has ten steps counting the recap, a quiz on the first nine, and no unfilled number', () => {
    expect(chVmem.steps).toHaveLength(9);
    for (const s of chVmem.steps) {
      expect(s.challenge?.kind).toBe('quiz');
      expect(s.body).not.toMatch(/NaN|undefined|\[object/);
    }
    expect(chVmem.recap?.check).toHaveLength(3);
  });
});
