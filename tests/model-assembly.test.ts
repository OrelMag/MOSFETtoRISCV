// The pipeline as an assembly line (widgets/assembly3d*): its schedule is riscv/pipetrace.ts, held here to the gate-level
// pipelinedCpu cycle by cycle (every stage's PC and valid bit, the stall and flush lines), then the parts' geometry.
import { describe, expect, it } from 'vitest';
import { pipelinedCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { decode } from '../src/riscv/isa';
import { clockCycle, pipeSnap } from '../src/riscv/cosim';
import { pipeSchedule } from '../src/riscv/pipetrace';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { HAZARDS, INDEP } from '../src/chapters/ch-pipe';
import { PROGRAMS } from '../src/riscv/programs';
import { tick } from './yieldtick';
import { assemblyAnchors, palletBox, assemblyParts, lampsOf, palletsAt, stationX } from '../src/widgets/assembly3dparts';

/** Plus a program with jal, jalr and a load whose result feeds a jalr: none of the chapter's three uses them. */
const CALLS = `# call and return
        li   a0, 3
        jal  ra, f
        sw   a0, 0(zero)
        lw   t1, 0(zero)
        add  t2, t1, t1
        jal  zero, halt      # a jump to the very next word still flushes
halt:   j    halt
f:      addi a0, a0, 1
        sw   ra, 16(zero)
        lw   ra, 16(zero)
        jalr zero, ra, 0     # load-use into a jalr`;

const SUM = PROGRAMS.find((p) => p.id === 'sum')!.source;
const CASES: [string, string, number][] = [['indep', INDEP, 30], ['hazards', HAZARDS, 50], ['sum', SUM, 80], ['calls', CALLS, 60]];

describe('pipeSchedule against the gate-level pipeline', () => {
  for (const [name, source, cycles] of CASES) {
    it(`${name}: every stage, stall and flush, ${cycles} cycles`, async () => {
      const design = flatten(pipelinedCpu(assemble(source).words));
      const sim = new GateSim(design);
      sim.setInput('clk', 0);
      sim.settle();
      const plan = pipeSchedule(assemble(source).words, cycles);
      for (let c = 0; c < cycles; c++) {
        const hw = pipeSnap(sim, design.root, c)!, mine = plan[c];
        const strip = (s: { pc: number; valid: boolean }[]) => s.map((x) => (x.valid ? x.pc : null));
        expect(strip(mine.slots), `${name} cycle ${c}`).toEqual(strip(hw.slots));
        expect([mine.stall, mine.flush], `${name} cycle ${c} stall/flush`).toEqual([hw.stall, hw.flush]);
        clockCycle(sim);
        if (c % 8 === 7) await tick();
      }
    }, 120_000);
  }
});

describe('what the programs exercise', () => {
  const run = (src: string, n: number) => pipeSchedule(assemble(src).words, n);
  it('independent work never stalls or flushes until the halt loop jumps', () => {
    const p = run(INDEP, 30);
    expect(p.slice(0, 9).some((c) => c.stall || c.flush)).toBe(false);
    // the line is full at cycle 4 and one instruction retires a cycle
    expect(p[4].slots.map((s) => s.pc)).toEqual([16, 12, 8, 4, 0]);
    expect(p[4].slots.every((s) => s.valid)).toBe(true);
  });
  it('the load-use stall holds F and D one cycle and sends one bubble into E', () => {
    const p = run(HAZARDS, 50), k = p.findIndex((c) => c.stall);
    expect(k).toBe(7); // the chapter's tour: seven cycles in, lw t4 is in E with addi t5, t4, 1 behind it
    expect(p[k + 1].slots[0].pc).toBe(p[k].slots[0].pc);
    expect(p[k + 1].slots[1].pc).toBe(p[k].slots[1].pc);
    expect(p[k + 1].slots[2].valid).toBe(false);
  });
  it('a taken branch flushes the two behind it (the chapter\'s tour: seven cycles in, pcF 28, then 12)', () => {
    const p = run(SUM, 40);
    expect(p[7].flush).toBe(true);
    expect(p[7].slots[0].pc).toBe(28);
    expect(p[7].pulled.length).toBe(2);
    expect(p[8].slots[0].pc).toBe(12);
    expect(p[8].slots[1].valid || p[8].slots[2].valid).toBe(false);
    // five cycles a lap
    expect(p.filter((c) => c.flush).slice(0, 3).map((c) => p.indexOf(c))).toEqual([7, 12, 17]);
  });
  it('jal and jalr always pay the two flushed slots', () => {
    const p = run(CALLS, 60);
    expect(p.filter((c) => c.flush).length).toBeGreaterThanOrEqual(4);
    expect(p.some((c) => c.stall)).toBe(true);
  });
});

describe('the pallets', () => {
  const ctx = { kindOf: () => 'alu' as const, mnemonicOf: () => 'x' };
  const plan = pipeSchedule(assemble(HAZARDS).words, 30);
  it('settled, every slot has exactly one pallet at its station', () => {
    for (const t of [0, 5, 8, 12]) {
      const p = palletsAt(plan, t, 1, ctx);
      expect(p.map((q) => q.x).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4].map(stationX));
    }
  });
  it('a flush lifts its two pallets off the line while the next cycle slides in', () => {
    const k = plan.findIndex((c) => c.flush), mid = palletsAt(plan, k + 1, 0.5, ctx);
    expect(mid.filter((q) => q.z < 0 && q.wrong).length).toBe(plan[k].pulled.length);
    expect(palletsAt(plan, k, 1, ctx).filter((q) => q.wrong).length).toBe(plan[k].pulled.length);
  });
  it('mid-flush, the pulled pallets are named, clear of every other pallet, and every station keeps its name', () => {
    const k = plan.findIndex((c) => c.flush), N = ['Fetch', 'Decode', 'Execute', 'Memory', 'Writeback'];
    for (const u of [0.05, 0.1, 0.25, 0.5, 0.75, 0.95]) {
      const mid = palletsAt(plan, k + 1, u, ctx), pulled = mid.filter((q) => q.leaving === 'pulled');
      expect(pulled.length).toBe(plan[k].pulled.length);
      for (const a of pulled) for (const b of mid) {
        if (a === b || b.size === 0) continue;
        const [x0, x1, y0, y1, z0, z1] = palletBox(a), [p0, p1, q0, q1, r0, r1] = palletBox(b);
        const hit = x0 < p1 && p0 < x1 && y0 < q1 && q0 < y1 && z0 < r1 && r0 < z1;
        expect(hit, `u=${u}: pulled pallet at x=${a.x} meets one at x=${b.x}`).toBe(false);
      }
      expect(pulled.every((q) => q.text.endsWith(' · pulled'))).toBe(true);
      const texts = assemblyAnchors(mid).map((a) => a.text);
      expect(N.every((n) => texts.includes(n))).toBe(true);
      expect(texts.filter((t) => t.endsWith(' · pulled')).length).toBe(pulled.length);
      expect(texts.includes('bubble')).toBe(false);
    }
  });
  it('the retiring pallet leaves past Writeback', () => {
    const mid = palletsAt(plan, 8, 0.5, ctx);
    expect(Math.max(...mid.map((q) => q.x))).toBeGreaterThan(stationX(4));
  });
  it('parts and labels exist for every pallet and station', () => {
    const p = palletsAt(plan, 8, 1, ctx), rgb: [number, number, number] = [0.5, 0.5, 0.5];
    const pal = Object.fromEntries(['frame', 'belt', 'plate', 'bubble', 'alu', 'load', 'store', 'ctl', 'wrong', 'off', 'hold', 'flush'].map((k) => [k, rgb])) as unknown as Parameters<typeof assemblyParts>[2];
    expect(assemblyParts(p, lampsOf(plan[8]), pal).length).toBeGreaterThan(p.length * 2);
    expect(assemblyAnchors(p).length).toBe(5 + p.filter((q) => q.kind !== 'bubble').length);
  });
});

describe('the note\'s claims about the chapter\'s programs', () => {
  it('every stall is a real dependence: the instruction in D reads the load\'s register', () => {
    for (const [name, source] of [['indep', INDEP], ['hazards', HAZARDS], ['sum', SUM]]) {
      const words = assemble(source).words;
      for (const c of pipeSchedule(words, 80)) {
        if (!c.stall) continue;
        const e = decode(words[c.slots[2].pc >>> 2]), d = decode(words[c.slots[1].pc >>> 2]);
        const reads = [d.fmt === 'U' || d.fmt === 'J' ? 0 : d.rs1, d.fmt === 'R' || d.fmt === 'S' || d.fmt === 'B' ? d.rs2 : 0];
        expect(reads.includes(e.rd) && e.rd !== 0, `${name} stall at pc ${c.slots[1].pc}`).toBe(true);
      }
    }
  });
  it('no taken branch targets the next word', () => {
    for (const source of [INDEP, HAZARDS, SUM]) {
      const words = assemble(source).words;
      words.forEach((w, i) => { if ((w & 0x7f) === 0x63) expect(decode(w).imm).not.toBe(4); void i; });
    }
  });
});
