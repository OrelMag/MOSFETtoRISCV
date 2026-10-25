// The numbers and timelines the codex's newer texts quote (codexmore3.ts, the examples added to rowbuffer, pagepolicy,
// arbitration, wearlevel and loader, the longer summaries), each against the model, the gates or the library it
// describes: a change to either side fails here. Hand-worked timelines are replayed on the bench's own models.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { codexById } from '../src/campaign/codex';
import { CODEX_NEW3 } from '../src/campaign/codexnew3';
import { NODES } from '../src/campaign/nodes';
import { CHECKS } from '../src/campaign/codexcheck';
import { moreOf } from '../src/campaign/codexmore';
import { BUS_WAIT } from '../src/campaign/buildm';
import { LOADER_FEED, loaderDecks } from '../src/campaign/buildcard';
import { DCMD, DRAM16, Dram16Model, FLASH16 } from '../src/campaign/memcheck';
import { nodeById } from '../src/campaign/nodes';

import { FlashDevice, Ftl } from '../src/flash/model';
import { fpAdd } from '../src/lib/fpu';
import { resolveComponent } from '../src/lib/resolve';
import { busOf } from '../src/lib/rv16/mem16';
import { RV16_MUX2 } from '../src/lib/rv16/logic';
import { flatten } from '../src/sim/flatten';
import { F16, fpAddX } from '../src/sim/fpref';
import { simulate } from '../src/sim/harness';
import { logicDepth, stats } from '../src/sim/stats';
import { CLK_TO_Q, PS_PER_NAND, SETUP, analyzeTiming } from '../src/sim/timing';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { pack } from '../src/sim/values';

const lib = (id: string): ComponentDef => {
  const d = resolveComponent(id);
  if (!d) throw new Error(id);
  return d;
};
const nands = (id: string) => stats(lib(id)).nands;
const period = (d: ComponentDef) => analyzeTiming(flatten(d, { mode: 'gate' }))!;
/** Everything an entry says: summary, fuller text, questions. */
function text(id: string): string {
  const m = moreOf(id)!;
  return [codexById(id)!.body, m.idea, m.example?.title, m.example?.body, ...(m.mistakes ?? []),
    ...(CHECKS[id] ?? []).flatMap((q) => [q.question, q.explain, ...q.options, ...(q.why ?? [])])].join(' ');
}
const sp = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// ---- DRAM: commands replayed on m_ctrl's chip model ---------------------------------------------------------

type Cmd = [cycle: number, cmd: keyof typeof DCMD, bank: number, row: number, col: number];
/** Replay commands (NOP between them) on a fresh chip; the broken rule, or the cycles each read's word is on dq. */
function replay(cmds: Cmd[]): { why: string; data: number[] } {
  const d = new Dram16Model(1);
  const data: number[] = [];
  const end = Math.max(...cmds.map((c) => c[0])) + DRAM16.tCAS + 1;
  for (let c = 0; c <= end; c++) {
    if (d.dq(c).addr >= 0) data.push(c);
    const x = cmds.find((k) => k[0] === c);
    d.edge(x ? DCMD[x[1]] : DCMD.NOP, x?.[2] ?? 0, x?.[3] ?? 0, x?.[4] ?? 0, 0, c);
  }
  return { why: d.why, data };
}
/** Each command bound by a rule (`tight`), one cycle earlier, breaks it. */
function tight(cmds: Cmd[], which: number[]): void {
  for (const i of which) {
    const early = cmds.map((c, k): Cmd => (k === i ? [c[0] - 1, c[1], c[2], c[3], c[4]] : c));
    expect(replay(early).why, `command ${i} one cycle early`).not.toBe('');
  }
}

describe('row buffer and page policy timelines (m_ctrl\'s chip)', () => {
  it('three reads in one bank: 8, a hit 4, a conflict 12; in bank 1, 8', () => {
    const t: Cmd[] = [[0, 'ACT', 0, 5, 0], [4, 'RD', 0, 5, 0], [8, 'RD', 0, 5, 1], [12, 'PRE', 0, 0, 0], [16, 'ACT', 0, 9, 0], [20, 'RD', 0, 9, 0]];
    expect(replay(t)).toEqual({ why: '', data: [8, 12, 24] });
    tight(t, [1, 4, 5]);
    const other: Cmd[] = [[0, 'ACT', 0, 5, 0], [4, 'RD', 0, 5, 0], [8, 'RD', 0, 5, 1], [12, 'ACT', 1, 9, 0], [16, 'RD', 1, 9, 0]];
    expect(replay(other)).toEqual({ why: '', data: [8, 12, 20] });
    const ex = moreOf('rowbuffer')!.example!.body;
    for (const s of ['cycle  4  RD word 0        tRCD = 4', 'tCAS = 4: the first read took 8', 'a row hit: 4 (tRAS = 9 has passed)', 'tRP = 4', 'cycle 24  data             a row conflict: 12', 'ACT at 12, RD at 16, data at 20, 8 cycles'])
      expect(ex).toContain(s);
    expect([DRAM16.tRCD, DRAM16.tCAS, DRAM16.tRP, DRAM16.tRAS]).toEqual([4, 4, 4, 9]);
  });

  it('rows 3 3 3 7: open page 28, closed page 47; a late conflict 12 against 8', () => {
    const open: Cmd[] = [[0, 'ACT', 0, 3, 0], [4, 'RD', 0, 3, 0], [8, 'RD', 0, 3, 1], [12, 'RD', 0, 3, 2], [16, 'PRE', 0, 0, 0], [20, 'ACT', 0, 7, 0], [24, 'RD', 0, 7, 0]];
    expect(replay(open)).toEqual({ why: '', data: [8, 12, 16, 28] });
    tight(open, [1, 5, 6]);
    const closed: Cmd[] = [];
    [3, 3, 3, 7].forEach((row, i) => {
      const a = 13 * i;
      closed.push([a, 'ACT', 0, row, 0], [a + 4, 'RD', 0, row, i]);
      if (i < 3) closed.push([a + 9, 'PRE', 0, 0, 0]);
    });
    expect(replay(closed)).toEqual({ why: '', data: [8, 21, 34, 47] });
    tight(closed, [1, 2, 3]);
    const ex = moreOf('pagepolicy')!.example!.body;
    for (const s of ['RD 24  data 28          28 cycles', 'PRE 9 (tRAS)', 'ACT 13  RD 17  data 21  PRE 22', 'ACT 26  RD 30  data 34  PRE 35', 'ACT 39  RD 43  data 47                   47 cycles'])
      expect(ex).toContain(s);
    // a read of row 7 at cycle 30, after one of row 3 at 0
    expect(replay([[0, 'ACT', 0, 3, 0], [4, 'RD', 0, 3, 0], [30, 'PRE', 0, 0, 0], [34, 'ACT', 0, 7, 0], [38, 'RD', 0, 7, 0]]).data).toEqual([8, 42]);
    expect(replay([[0, 'ACT', 0, 3, 0], [4, 'RD', 0, 3, 0], [9, 'PRE', 0, 0, 0], [30, 'ACT', 0, 7, 0], [34, 'RD', 0, 7, 0]]).data).toEqual([8, 38]);
    expect(ex).toContain('takes 8 cycles, where open page pays PRE, ACT, RD: 12');
    // back-to-back conflicts: 13 an access either way (ACT → PRE ≥ tRAS, PRE → ACT ≥ tRP)
    expect(DRAM16.tRAS + DRAM16.tRP).toBe(13);
    expect(moreOf('pagepolicy')!.mistakes!.join(' ')).toContain('(13 cycles an access here)');
  });
});

describe('arbitration on m_bus\'s gates', () => {
  /** m1 alone on slave 0 (it is then served last), then on slave 1 from cycle 2, m0 asking slave 1 from cycle 3. */
  function grants(fault?: 'nolock'): string[] {
    const sim = simulate(busOf(fault), 'gate');
    const get = (p: string) => pack(sim.getBits(sim.design.root.ports[p]));
    for (const p of ['mv0', 'ma0', 'md0', 'mw0', 'mv1', 'ma1', 'md1', 'mw1', 'sr0', 'sq0', 'sr1', 'sq1', 'sr2', 'sq2', 'clk']) sim.setInput(p, 0);
    sim.setInput('rst', 1); sim.settle(); sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.setInput('rst', 0); sim.settle();
    const cnt = [0, 0, 0], out: string[] = [];
    let m1first = true;
    for (let c = 1; c <= 7; c++) {
      sim.setInput('mv0', c >= 3 ? 1 : 0); sim.setInput('ma0', 0x8100);
      sim.setInput('mv1', 1); sim.setInput('ma1', m1first ? 0x0010 : 0x8200);
      for (let k = 0; k < 3; k++) sim.setInput(`sr${k}`, cnt[k] >= BUS_WAIT[k] ? 1 : 0);
      sim.settle();
      const sv = [0, 1, 2].map((k) => get(`sv${k}`)), who = get('sa') === 0x8100 ? 'm0' : 'm1', mr0 = get('mr0'), mr1 = get('mr1');
      out.push(`${who}${mr0 || mr1 ? ' done' : ''}`);
      for (let k = 0; k < 3; k++) cnt[k] = sv[k] && !(mr0 || mr1) ? cnt[k] + 1 : 0;
      if (mr1) m1first = false;
      sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    }
    return out;
  }

  it('held round robin against re-arbitrating every cycle, as the example draws it', () => {
    expect(BUS_WAIT[1]).toBe(2);
    expect(grants()).toEqual(['m1 done', 'm1', 'm1', 'm1 done', 'm0', 'm0', 'm0 done']);
    expect(grants('nolock')).toEqual(['m1 done', 'm1', 'm0', 'm0 done', 'm1', 'm1', 'm1 done']);
    const ex = moreOf('arbitration')!.example!.body;
    for (const s of ['4    m0 m1    m1 done                m0 done, on m1\'s wait states', '7    m0 m1    m0 done                m1 done', 'Slave 1 has 2 wait states', 'answers m0 after 2 cycles'])
      expect(ex).toContain(s);
  });
});

describe('flash: wear and the loader', () => {
  it('one hot page on chapter 37\'s FTL: erases 0 0 0 0 8 8 7 0, write amplification 1.00', () => {
    for (const wearLevel of [false, true]) {
      const dev = new FlashDevice({ blocks: 8, pagesPerBlock: 4, wordsPerPage: 1 });
      const f = new Ftl(dev, { logical: 16, wearLevel });
      for (let i = 0; i < 16; i++) f.write(i, [i]);
      for (let i = 0; i < 100; i++) f.write(0, [i]);
      expect([...dev.erases].join(' ')).toBe('0 0 0 0 8 8 7 0');
      expect(f.writeAmplification.toFixed(2)).toBe('1.00');
    }
    const ex = moreOf('wearlevel')!.example!.body;
    expect(ex).toContain('erases per block 0 0 0 0 8 8 7 0');
    expect(ex).toContain('write amplification 1.00');
    expect([FLASH16.tE, FLASH16.tP, FLASH16.tE + 4 * FLASH16.tP]).toEqual([20, 6, 44]);
    expect(ex).toContain('an erase (tE = 20 cycles) and four programs (tP = 6), 44 cycles against one program, 6');
  });

  it('h_loader: a card every LOADER_FEED + 1 edges, 89 + 93 = 182 = par', () => {
    const n = loaderDecks().map((d) => d.words.length);
    expect(n).toEqual([23, 24]);
    const c = n.map((k) => 1 + (k - 1) * (LOADER_FEED + 1));
    expect(c).toEqual([89, 93]);
    expect(c[0] + c[1]).toBe(nodeById('h_loader')!.par!.cycles);
    const ex = moreOf('loader')!.example!.body;
    expect(ex).toContain(`a card every ${LOADER_FEED + 1} edges: ${LOADER_FEED} to feed it`);
    expect(ex).toContain('1 + 22 × 4 = 89');
    expect(ex).toContain('1 + 23 × 4 = 93');
    expect(ex).toContain('182: par');
    // the one safe clock gate, named from both entries
    expect(moreOf('loader')!.idea).toContain('clk AND run');
    expect(moreOf('clockgating')!.idea).toContain('clk AND run');
  });
});

describe('summaries and new entries, measured', () => {
  it('every new entry has its texts, two questions (answer first), chapters and a teaching level', () => {
    for (const e of CODEX_NEW3) {
      const m = moreOf(e.id)!;
      expect(m.idea && m.example && m.mistakes?.length, e.id).toBeTruthy();
      expect(m.chapters?.length, `${e.id}: chapters`).toBeGreaterThan(0);
      expect(CHECKS[e.id]?.map((q) => q.answer), `${e.id}: questions`).toEqual([0, 0]);
      expect(NODES.some((n) => n.codex.includes(e.id)), `${e.id}: level`).toBe(true);
    }
  });

  it('not, and, or, latch, counter', () => {
    expect([nands('not'), logicDepth(lib('not')), stats(lib('inv_cmos')).transistors, stats(lib('nand')).transistors]).toEqual([1, 1, 2, 4]);
    expect(codexById('not')!.body).toContain('1 NAND, depth 1. In CMOS a real inverter is 2 transistors, half a NAND');
    expect([nands('and'), logicDepth(lib('and'))]).toEqual([2, 2]);
    expect(codexById('and')!.body).toContain('2 NANDs, depth 2');
    expect([nands('or'), logicDepth(lib('or'))]).toEqual([3, 2]);
    expect(codexById('or')!.body).toContain('3 NANDs, depth 2');
    expect([nands('sr_latch'), stats(lib('sr_latch')).transistors]).toEqual([2, 8]);
    expect(codexById('latch')!.body).toContain('2 NANDs, 8 transistors');
    expect([nands('counter4'), period(lib('counter4')).period]).toEqual([80, 17]);
    expect(codexById('counter')!.body).toContain('4-bit counter: 80 NANDs, period 17');
  });

  it('pipeline register: 208 + 49 + 3 = 260, period 8 like the register alone', () => {
    const preg = lib('rv16_preg');
    const parts = netlistOf(preg)!.instances.map((i) => (typeof i.def === 'string' ? lib(i.def) : i.def));
    const of = (id: string) => stats(parts.find((p) => p.id === id)!).nands;
    expect([stats(preg).nands, of('rv16_reg16'), of('rv16_mux16'), of('or')]).toEqual([260, 208, 49, 3]);
    expect([period(preg).period, period(lib('rv16_reg16')).period]).toEqual([8, 8]);
    const t = text('preg');
    for (const s of ['260 NANDs, 208 of them', 'register with enable   208', 'bus mux: d or 0 (clr)          49', 'OR: load when en or clr         3', '260 NANDs, period 8']) expect(t).toContain(s);
  });

  it('clock: 3 + 35 + 3 = 41 for the PC; 25 ps a NAND', () => {
    const pc = period(lib('rv16_pc'));
    expect([CLK_TO_Q, pc.logic, SETUP, pc.period]).toEqual([3, 35, 3, 41]);
    expect(PS_PER_NAND).toBe(25);
    expect((pc.period * PS_PER_NAND / 1000).toFixed(3)).toBe('1.025');
    expect(Math.round(1e6 / (pc.period * PS_PER_NAND))).toBe(976);
    const reg = period(lib('rv16_reg16'));
    expect([reg.logic, reg.period]).toEqual([2, 8]);
    const t = text('clock');
    for (const s of ['3 + 35 + 3 = 41', 'incrementer and muxes        35', '1.025 ns: about 976 MHz', '3 + 2 + 3 = 8', '26 NAND delays: 3 clk-to-q + 20 + 3 setup']) expect(t).toContain(s);
  });

  it('reset: a flip-flop with async reset is 19 NANDs against 11; 16 × 8 = 128; one bus mux 49', () => {
    expect([nands('dff_r'), nands('dff'), nands('rv16_mux16')]).toEqual([19, 11, 49]);
    const t = text('reset');
    for (const s of ['19 NANDs instead of 11', '19 NANDs against 11', '16 × (19 − 11): flip-flops with reset      128 NANDs', 'or the next PC     49 NANDs']) expect(t).toContain(s);
    expect(lib('rv16_pc').summary).toContain('pc ← rst ? 0');
  });

  it('FP adder: 3 755 NANDs, depth 163, normalize & round 2 058; the two sums on the reference', () => {
    const fa = fpAdd(F16, RV16_MUX2);
    const parts = netlistOf(fa)!.instances.map((i) => (typeof i.def === 'string' ? lib(i.def) : i.def));
    const nr = parts.find((p) => p.id.startsWith('fpnr'))!;
    expect([stats(fa).nands, logicDepth(fa), stats(nr).nands]).toEqual([3755, 163, 2058]);
    expect(stats(nr).nands / stats(fa).nands).toBeGreaterThan(0.5);
    expect(fpAddX(0x3e00, 0x3600, false, F16).y).toBe(0x3f80);
    expect(fpAddX(0x3c00, 0x3bff, true, F16)).toEqual({ y: 0x1000, fl: 0 });
    expect(2 ** -11).toBe(1 - 0.99951171875);
    const t = text('fpadder');
    for (const s of [`${sp(3755)} NANDs, depth 163`, `${sp(2058)} of them`, '3 755 NANDs and 163 delays deep', '1.875 (0x3F80)', '(0x3BFF)', 'a left shift of 11, exact: 0x1000']) expect(t).toContain(s);
  });

  it('tri-state: TRIBUF 8 transistors; a 4:1 mux 3 × 4 NANDs, 48 transistors', () => {
    expect([stats(lib('tribuf')).transistors, stats(lib('tribuf')).nands]).toEqual([8, 0]);
    expect([nands('mux2'), stats(lib('mux2')).transistors]).toEqual([4, 16]);
    const t = text('tristate');
    for (const s of ['TRIBUF: 8 transistors', '4 TRIBUFs = 32 transistors', '3 two-input muxes = 12 NANDs = 48 transistors']) expect(t).toContain(s);
  });

  it('binary to decimal: at most 32 subtractions (59 999), x · 52 429 >> 19 exact through 262 148', () => {
    const subs = (x: number) => [10000, 1000, 100, 10].reduce((s, p) => { const d = Math.floor(x / p); x -= d * p; return s + d; }, 0);
    let max = 0, at = 0;
    for (let x = 0; x < 65536; x++) if (subs(x) > max) { max = subs(x); at = x; }
    expect([max, subs(59999), at, subs(1234)]).toEqual([32, 32, 59990, 6]);
    let first = -1;
    for (let x = 0n; x < 300000n; x++) if ((x * 52429n) >> 19n !== x / 10n) { first = Number(x); break; }
    expect(first).toBe(262149);
    expect(40000 - 65536).toBe(-25536);
    const t = text('bin2dec');
    for (const s of ['at most 32 subtractions', '(x · 52 429) >> 19', '6 subtractions', '→ 32, the most for 16 bits', 'first wrong at 262 149', '−25 536']) expect(t).toContain(s);
  });
});
