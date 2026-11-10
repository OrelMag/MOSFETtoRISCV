// The virtual-memory codex entries and act 7's optional levels (y_tlb, y_walk, p_switch): every number their text quotes is
// the chapters' own or measured here, and the benches catch the mistakes their levels are about.

import { describe, expect, it } from 'vitest';
import { caseOf } from '../src/campaign/cases';
import { tlbSeq, walkSeq } from '../src/campaign/buildvm';
import { CODEX } from '../src/campaign/codex';
import { moreOf } from '../src/campaign/codexmore';
import { nodeById } from '../src/campaign/nodes';
import { PUZZLES, runPuzzle } from '../src/campaign/puzzles';
import { vmFigures } from '../src/chapters/ch-vmem';
import { osFigures } from '../src/chapters/ch-os';
import { chapters } from '../src/chapters';
import { TlbModel, missesOf } from '../src/sim/tlbmodel';
import { Tlb16Model, Walk16Model } from '../src/lib/rv16/vm16';
import { WALK_CYCLES } from '../src/riscv/vmprograms';
import { groupDigits } from '../src/sim/numfmt';

const n = groupDigits;
const plain = (h: string) => h.replace(/<[^>]+>/g, '');

describe('the entries', () => {
  it('quote the chapters\' own numbers', () => {
    const o = osFigures();
    const ctx = moreOf('ctxswitch')!.example!.body;
    for (const v of [o.saveInstr, o.chooseInstr, o.restoreInstr, o.switchInstr, o.switchCycles]) expect(ctx, String(v)).toContain(String(v));
    const sch = moreOf('scheduler')!.example!.body;
    for (const v of [o.overhead, o.overheadShort, o.overheadLong, o.slice]) expect(sch, String(v)).toContain(String(v));
    expect(plain(CODEX.find((e) => e.id === 'process')!.body)).toBeTruthy();
    // the chapters' syscall numbers: 1 putchar, 2 write, 3 yield, 93 exit
    expect(moreOf('syscall')!.idea).toContain('1 puts a character, 2 writes a number, 3 yields, 93 exits');
  });

  it('the TLB example: five pages in turn through four round-robin entries always miss, four pages miss four times', () => {
    const cyc = (pages: number, rounds: number) => Array.from({ length: pages * rounds }, (_, i) => i % pages);
    expect(missesOf(cyc(5, 8), 4).misses).toBe(40);
    expect(missesOf(cyc(4, 8), 4).misses).toBe(4);
    const t = new TlbModel(4);
    [1, 2, 3, 4].forEach((p) => t.access(p));
    expect(t.access(5)).toBe(false);
    expect(t.has(1)).toBe(false); // entry 0 was replaced
    expect(t.access(1)).toBe(false);
    expect(t.has(2)).toBe(false);
  });

  it('every link names a step by its title (campaign-content checks the rest) and the walk is three cycles', () => {
    expect(WALK_CYCLES).toBe(3);
    for (const id of ['page', 'pagetable', 'sv32', 'tlb', 'pagefault', 'privmode', 'syscall', 'process', 'ctxswitch', 'scheduler']) {
      for (const l of moreOf(id)!.chapters ?? []) expect(chapters.find((c) => c.id === l.chapter)!.steps[l.step!].title, id).toBe(l.label);
    }
  });
});

describe('level texts', () => {
  it('y_tlb and y_walk quote their own par and the system CPU\'s blocks', () => {
    const f = vmFigures();
    const t = nodeById('y_tlb')!, w = nodeById('y_walk')!;
    expect(t.why).toContain(`${t.par!.nand} NANDs, period ${t.par!.period}`);
    expect(t.why).toContain(`${n(f.tlbI)} and ${n(f.tlbD)}`);
    expect(caseOf('y_tlb')!.cost).toContain(`${t.par!.nand} NANDs, period ${t.par!.period}`);
    expect(caseOf('y_tlb')!.cost).toContain(`${n(f.tlbI)} (instruction side) and ${n(f.tlbD)} (data side)`);
    expect(w.why).toContain(`${w.par!.nand} NANDs, period ${w.par!.period}`);
    expect(w.why).toContain(`stalls the CPU for ${WALK_CYCLES} cycles`);
    expect(caseOf('y_walk')!.cost).toContain(`${w.par!.nand} NANDs, period ${w.par!.period}`);
    expect(caseOf('y_walk')!.cost).toContain(`takes ${WALK_CYCLES} cycles of stall`);
    expect(w.why).toContain(`is ${f.walker}`);
    expect(caseOf('y_walk')!.cost).toContain(`is ${f.walker}`);
  });

  it('p_switch quotes the handler\'s length, the program\'s size and the chapter kernel\'s switch', () => {
    const p = PUZZLES.p_switch, node = nodeById('p_switch')!, o = osFigures();
    const body = p.ref.slice(p.ref.indexOf('handler:')).split('\n').slice(1);
    const handler = body.slice(0, body.findIndex((l) => /^\s*mret\b/.test(l)) + 1).filter((l) => l.trim() && !l.trim().startsWith('#')).length;
    expect(node.why).toContain(`${handler} instructions of handler`);
    expect(caseOf('p_switch')!.cost).toContain(`${handler} instructions of handler for each switch, in a program of ${node.par!.size} words`);
    expect(caseOf('p_switch')!.cost).toContain(`${o.switchInstr} instructions, ${o.switchCycles} cycles`);
  });
});

describe('the benches', () => {
  it('the TLB sequence covers an eviction, a flush, a fill with a flush and every entry', () => {
    const steps = tlbSeq();
    const fills = steps.filter((s) => s.tick && s.set?.fill);
    expect(fills.length).toBeGreaterThan(30);
    expect(steps.some((s) => s.tick && s.set?.flush && s.set?.fill)).toBe(true);
    expect(steps.some((s) => s.tick && s.set?.flush && !s.set?.fill)).toBe(true);
    // replay it on the model: the pointer visits all four entries, and misses are checked as misses
    const m = new Tlb16Model();
    const seen = new Set<number>();
    for (const s of steps) {
      if (s.tick) { if (s.set!.fill) seen.add(m.ptr); m.edge(s.set as never); }
      else { const e = m.find(s.set!.key); expect(s.expect.hit, 'hit').toBe(e < 0 ? 0 : 1); }
    }
    expect(seen.size).toBe(4);
  });

  it('the walker sequence meets a fill at each flag mix, a fault of each kind and garbage while idle', () => {
    const steps = walkSeq();
    const fills = steps.filter((s) => 'fppn' in s.expect);
    expect(new Set(fills.map((s) => s.expect.fflags)).size).toBeGreaterThanOrEqual(4);
    expect(steps.filter((s) => s.expect.fault === 1).length).toBeGreaterThanOrEqual(7);
    const m = new Walk16Model();
    const kinds = new Set<string>();
    let root = 0, vpn = 0;
    for (const s of steps) {
      if (s.tick) continue;
      root = s.set!.root; vpn = s.set!.vpn;
      const pte = s.set!.pte;
      if (m.state === 1 || m.state === 2) {
        expect(s.expect.pteAddr).toBe(m.addr(root, vpn));
        kinds.add(`${m.state}:${m.kind(pte)}`);
      } else expect('pteAddr' in s.expect).toBe(false);
      m.edge(s.set!.start, pte);
    }
    // a pointer and a leaf where they belong, and every way to be wrong
    for (const k of ['1:ptr', '2:leaf', '1:fault', '2:fault']) expect(kinds.has(k), k).toBe(true);
  });
});

describe('p_switch', () => {
  const p = PUZZLES.p_switch;
  const broken = (from: string, to: string) => runPuzzle(p, p.ref.replace(from, to));

  it('the reference passes and the starter does not', () => {
    expect(runPuzzle(p, p.ref).ok).toBe(true);
    expect(runPuzzle(p, p.starter).ok).toBe(false);
  });

  it('a handler that does not save a register, mepc or the acknowledge fails', () => {
    for (const [what, from, to] of [
      ['t1 not saved', '        sw   t1, 6(sp)\n', ''],
      ['a1 not restored', '        lw   a1, 3(sp)\n', ''],
      ['sp parked wrong', '        sw   t0, 1(sp)            # the process\'s sp\n', ''],
      ['mepc not saved', '        sw   t0, 7(sp)\n', ''],
      ['no acknowledge', '        sw   x0, -7(x0)           # acknowledge\n', ''],
    ]) {
      const r = broken(from, to);
      expect(r.ok, what).toBe(false);
    }
  });
});

describe('the sequences notice the usual mistakes (replayed on mutated models)', () => {
  const tlbFails = (mutant: Tlb16Model): boolean => {
    for (const s of tlbSeq()) {
      if (s.tick) mutant.edge(s.set as never);
      else {
        const e = mutant.find(s.set!.key);
        if (e < 0 ? s.expect.hit !== 0 : s.expect.hit !== 1 || s.expect.ppn !== mutant.ppn[e] || s.expect.flags !== mutant.flags[e]) return true;
      }
    }
    return false;
  };
  it('a TLB that evicts the least recently used entry, or in which a fill beats a flush, is caught', () => {
    expect(tlbFails(new Tlb16Model())).toBe(false);
    // least-recently-used instead of round robin: a hit refreshes the entry, so a different page is evicted
    class Lru extends Tlb16Model {
      used = [0, 0, 0, 0]; t = 0;
      override find(key: number) { const e = super.find(key); if (e >= 0) this.used[e] = ++this.t; return e; }
      override edge(i: { key: number; fill: number }) {
        if (i.fill) {
          const free = this.valid.indexOf(false);
          this.ptr = free >= 0 ? free : this.used.indexOf(Math.min(...this.used));
          this.used[this.ptr] = ++this.t;
        }
        super.edge(i as never);
      }
    }
    class FillWins extends Tlb16Model { override edge(i: never) { const x = i as { fill: number; flush: number }; if (x.fill && x.flush) { super.edge({ ...x, flush: 0 } as never); } else super.edge(i); } }
    expect(tlbFails(new Lru())).toBe(true);
    expect(tlbFails(new FillWins())).toBe(true);
  });

  const walkFails = (mutant: Walk16Model): boolean => {
    for (const s of walkSeq()) {
      if (s.tick) continue;
      const o = mutant.out(s.set!.start, s.set!.pte);
      for (const k of ['stall', 'fill', 'fault'] as const) if (s.expect[k] !== o[k]) return true;
      mutant.edge(s.set!.start, s.set!.pte);
    }
    return false;
  };
  it('a walker that takes a leaf at level 1, or a pointer at level 0, is caught', () => {
    expect(walkFails(new Walk16Model())).toBe(false);
    class SuperLeaf extends Walk16Model { override kind(pte: number) { const k = super.kind(pte); return this.state === 1 && k === 'fault' && (pte & 1) && (pte & 10) ? 'leaf' : k; } }
    class PtrAtZero extends Walk16Model { override kind(pte: number) { const k = super.kind(pte); return this.state === 2 && k === 'fault' && (pte & 1) && !(pte & 10) ? 'ptr' : k; } }
    expect(walkFails(new SuperLeaf())).toBe(true);
    expect(walkFails(new PtrAtZero())).toBe(true);
  });
});
