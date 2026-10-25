// Acts 9 and 10 (the GPU, memory): the thread data is complete, and every number the whys, cases, lessons and
// thread quote is measured here (pars, library parts, the puzzle runner on the references and on the variants
// the texts compare them with, the benchmark results, PIPE_COSTS) and read back from the text.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import results from '../src/bench/results.json';
import { caseOf } from '../src/campaign/cases';
import { dependents } from '../src/campaign/graph';
import { mapLayout, wrapText } from '../src/campaign/layout';
import { LESSONS } from '../src/campaign/lessons';
import { libCost } from '../src/campaign/measure';
import { DRAM16 } from '../src/campaign/memcheck';
import { ACTS, NODES, nodeById } from '../src/campaign/nodes';
import { NUDGES } from '../src/campaign/nudges';
import { puzzleMachine, PUZZLES, runPuzzle } from '../src/campaign/puzzles';
import { threadOf } from '../src/campaign/thread';
import { chapterById } from '../src/chapters';
import { TIMING } from '../src/dram/timing';
import { PIPE_COSTS } from '../src/gfx/pipeline';
import { axiBus } from '../src/lib/axi';
import { WB_MISS_CLEAN, WB_MISS_DIRTY } from '../src/lib/cache2';
import { BITLINE_C, CELL_C } from '../src/lib/dram';
import { dramCtrl } from '../src/lib/dramctrl';
import { ram } from '../src/lib/memory';
import { arrayMul } from '../src/lib/muldiv';
import { resolveComponent } from '../src/lib/resolve';
import { RV16_WARPS } from '../src/lib/rv16/warps16';
import { copiesIn } from '../src/lib/usage';
import { accessUnit } from '../src/lib/warpmem';
import { assemble16 } from '../src/riscv/rv16/asm16';
import type { Warps16 } from '../src/riscv/rv16/warps16';
import { stats } from '../src/sim/stats';

const fmt = (v: number) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const par = (id: string) => nodeById(id)!.par!;
const nand = (id: string) => libCost(id)!.nand;
const why = (id: string) => plain(nodeById(id)!.why);
const kase = (id: string) => { const c = caseOf(id)!; return plain(`${c.problem} ${c.without ?? ''} ${c.cost ?? ''}`); };
const T = (id: string) => plain([...Object.values(threadOf(id)?.usedFor ?? {}), ...(threadOf(id)?.pitfalls ?? [])].join(' '));
const pct = (a: number, b: number) => Math.round((100 * a) / b);
const MINE = NODES.filter((n) => n.act === 9 || n.act === 10);

// The variants the texts measure the references against.
const SAXPY_ONE_LANE = PUZZLES.p_saxpy.ref
  .replace('        csrr t0, tid\n', '        li   t0, 1\n        tmc  t0\n        li   t0, 0\n')
  .replace('addi t0, t0, 4', 'addi t0, t0, 1');
const REDUCE_HEAD = PUZZLES.p_reduce.ref.slice(0, PUZZLES.p_reduce.ref.indexOf('        li   t1, 1'));
const REDUCE_TREE = `${REDUCE_HEAD}        li   t1, 3
        tmc  t1               # lanes 0, 1
        lw   a2, 2(t0)
        add  a1, a1, a2
        sw   a1, 0(t0)
        li   t1, 1
        tmc  t1
        lw   a2, 1(x0)
        add  a1, a1, a2
        sw   a1, -2(sp)
        halt
`;
const REDUCE_ALL = `${REDUCE_HEAD}        lw   a1, 0(x0)
        lw   a2, 1(x0)
        add  a1, a1, a2
        lw   a2, 2(x0)
        add  a1, a1, a2
        lw   a2, 3(x0)
        add  a1, a1, a2
        sw   a1, -2(sp)
        halt
`;
const BOOT_FLASH = `        li   t0, 0x8000
        lw   a1, 0(t0)       # n
        li   a0, 0
loop:   addi t0, t0, 1
        lw   t1, 0(t0)
        add  a0, a0, t1
        addi a1, a1, -1
        bnez a1, loop
        sw   a0, -3(x0)
        halt
`;
const BOOT_WAIT = `        li   t0, 0x8000
        lw   a1, 0(t0)       # n
        addi t0, t0, 1
        sw   t0, -16(x0)
        li   t1, 0x100
        sw   t1, -15(x0)
        sw   a1, -14(x0)
        li   a0, 0
w:      lw   t0, -7(x0)
        beqz t0, w
        sw   x0, -13(x0)
loop:   lw   t0, 0(t1)
        add  a0, a0, t0
        addi t1, t1, 1
        addi a1, a1, -1
        bnez a1, loop
        sw   a0, -3(x0)
        halt
`;

describe('acts 9–10: the thread is filled', () => {
  it('every level has pitfalls and a clause for every dependent; builds and cores of the lanes and act 10 name a block', () => {
    for (const n of MINE) {
      const t = threadOf(n.id);
      expect(t?.pitfalls?.length, `${n.id} pitfalls`).toBeGreaterThanOrEqual(2);
      expect(t!.pitfalls!.length).toBeLessThanOrEqual(4);
      for (const d of dependents(n.id)) expect(t?.usedFor?.[d.id], `${n.id} → ${d.id}`).toBeTruthy();
    }
    for (const id of ['k_lanes', 'k_vrf', 'k_mask', 'k_stack', 'k_coal', 'k_frame', 'm_sense', 'm_bank', 'm_ctrl', 'o_cache', 'm_bus', 'm_dma', 'm_flash']) {
      expect(threadOf(id)?.uses?.length, id).toBeTruthy();
    }
  });

  it('every level that is not a lesson has a nudge and a case; build and core levels have at least two tips', () => {
    for (const n of MINE) {
      if (n.kind === 'lesson') continue;
      expect(NUDGES[n.id], `${n.id} nudge`).toBeTruthy();
      expect(caseOf(n.id), `${n.id} case`).toBeDefined();
      if (n.kind === 'build' || n.kind === 'core') expect(n.tips.length, n.id).toBeGreaterThanOrEqual(2);
    }
    for (const id of ['k_lesson', 'm_lesson']) expect(caseOf(id)?.cost, id).toBeTruthy();
  });

  it('whys stay short enough for the map panel, and link real chapter steps', () => {
    for (const n of MINE) {
      expect(plain(n.why).length, n.id).toBeLessThanOrEqual(470);
      for (const c of n.chapters ?? []) {
        const ch = chapterById(c.chapter);
        expect(ch, `${n.id} → ${c.chapter}`).toBeDefined();
        const s = ch!.steps[c.step ?? 0];
        expect(s, `${n.id} → ${c.chapter}/${c.step}`).toBeDefined();
        expect(c.label, `${n.id} → ${c.chapter}/${c.step}`).toBe(c.step === undefined && c.label === ch!.title ? ch!.title : s.title);
      }
    }
  });

  it('the act blurbs name the act\'s parts and fit their two lines on the map', () => {
    const b9 = ACTS.find((a) => a.num === 9)!.blurb, b10 = ACTS.find((a) => a.num === 10)!.blurb;
    for (const w of ['Core III', 'Lanes', 'Warps', 'Pixels']) expect(b9).toContain(w);
    for (const w of ['A computer', 'DRAM', 'controller', 'cache', 'bus', 'DMA', 'flash']) expect(b10).toContain(w);
    // as acts 0–8's do from three columns on (narrower maps cut every act's blurb; the tooltip has it whole)
    for (const cols of [3, 4, Infinity]) {
      const L = mapLayout(cols, new Set(), { blurb: (a) => ACTS.find((x) => x.num === a)?.blurb, end: () => undefined });
      for (const act of [9, 10]) {
        const band = L.bands.find((b) => b.act === act)!;
        if (band.folded || !band.sub) continue;
        expect(band.sub.join(' ').endsWith('…'), `act ${act} at ${cols} columns`).toBe(false);
      }
    }
    expect(wrapText(b9, 10000, 2)).toHaveLength(1);
  });
});

describe('acts 9–10: the lane numbers', () => {
  const four = 4 * nand('rv16_cpu');
  it('the SIMD core against four single-cycle cores, the lanes, registers, mask and stack', () => {
    expect(nand('rv16_simd')).toBe(par('k_simd').nand);
    for (const t of [why('k_lesson'), why('k_simd'), kase('k_lesson'), plain(LESSONS.gpu)]) {
      expect(t).toContain(`${fmt(par('k_simd').nand!)} NANDs`);
      expect(t).toContain(fmt(four));
    }
    expect(plain(LESSONS.gpu)).toContain(`${fmt(par('k_simd').nand! - nand('rv16_cpu'))} more than your single-cycle core`);
    expect(why('k_lanes')).toContain(`${fmt(par('k_lanes').nand!)} NANDs`);
    expect(nand('rv16_vrf4')).toBe(par('k_vrf').nand);
    expect(why('k_vrf')).toContain(`${fmt(par('k_vrf').nand!)} NANDs, ${pct(par('k_vrf').nand!, par('k_simd').nand!)}% of the SIMD core`);
    for (const t of [kase('k_lesson'), plain(LESSONS.gpu)]) expect(t).toContain(fmt(nand('rv16_vrf4')));
    expect(why('k_mask')).toContain(`${par('k_mask').nand} NANDs`);
    expect(why('k_stack')).toContain(`${fmt(par('k_stack').nand!)} NANDs`);
    expect(why('k_simt')).toContain(`+${fmt(par('k_simt').nand! - par('k_simd').nand!)} NANDs, period unchanged`);
    expect(par('k_simt').period).toBe(par('k_simd').period);
  });

  it('a second warp costs its registers; the coalescer is not placed in the two-warp core', () => {
    const extra = nand('rv16_warps') - nand('rv16_simt');
    expect(nand('rv16_warps')).toBe(par('k_warps').nand);
    expect(why('k_warps')).toContain(`+${fmt(extra)} NANDs, ${pct(nand('rv16_vrf4'), extra)}% of them lane registers`);
    expect(plain(LESSONS.gpu)).toContain(`+${fmt(extra)} NANDs, ${fmt(nand('rv16_vrf4'))} of them its lane registers`);
    expect(kase('k_lesson')).toContain(`A second warp adds ${fmt(extra)}`);
    const dev = par('k_frame').nand! - par('k_warps').nand!;
    expect(kase('k_lesson')).toContain(`another ${fmt(dev)} (A frame: ${fmt(par('k_frame').nand!)})`);
    expect(copiesIn(RV16_WARPS, resolveComponent('rv16_coal4')!)).toBe(0);
    expect(RV16_WARPS.ports.filter((p) => /^drdata\d$/.test(p.name))).toHaveLength(4);
    expect(why('k_coal')).toContain(`${par('k_coal').nand} NANDs`);
    expect(why('k_coal')).toContain(`(${fmt(stats(accessUnit(4)).nands)} NANDs)`);
    expect(T('k_coal')).toContain('not placed');
  });

  it('the rasterizer\'s parts, and why it is fixed-function (chapter 34\'s measured frames)', () => {
    const soft = PIPE_COSTS.frames.find((f) => f.id === 'soft')!, tri = PIPE_COSTS.frames.find((f) => f.id === 'triangle')!;
    const rast = PIPE_COSTS.stages.find((s) => s.id === 'rast')!;
    expect(soft.name).toContain('16 threads');
    expect(why('k_edge')).toContain(`${fmt(soft.draw)} cycles for one triangle on 16 threads, against ${fmt(tri.draw)} on a rasterizer of ${fmt(rast.nands)} NANDs`);
    expect(why('k_edge')).toContain(`${par('k_edge').nand} NANDs an edge`);
    expect(why('k_tile')).toContain(`${par('k_tile').nand} NANDs`);
    expect(why('k_raster')).toContain(`${fmt(par('k_raster').nand!)} NANDs`);
    expect(plain(LESSONS.gpu)).toContain(`a rasterizer (${fmt(par('k_raster').nand!)} NANDs)`);
    expect(why('k_frame')).toContain(`${fmt(par('k_frame').nand!)} NANDs`);
    const mul = stats(arrayMul(8)).nands;
    expect(kase('k_edge')).toContain(`six 8 × 8 array multipliers (${mul} NANDs each, ${fmt(6 * mul)} in all)`);
    const word = PIPE_COSTS.frames.find((f) => f.id === 'triangle_w')!;
    expect(kase('p_spin')).toContain(`a word a cycle, ${fmt(word.clear)} cycles where its pipeline's clear took ${fmt(tri.clear)}`);
  });
});

describe('acts 9–10: the kernels, on the puzzle runner', () => {
  it('saxpy against one lane doing everything', () => {
    const r = runPuzzle(PUZZLES.p_saxpy, PUZZLES.p_saxpy.ref), one = runPuzzle(PUZZLES.p_saxpy, SAXPY_ONE_LANE);
    expect(one.ok).toBe(true);
    expect([r.size, r.cycles, r.laneOps, r.idle]).toEqual([23, par('p_saxpy').cycles, par('p_saxpy').laneops, 0]);
    expect(why('p_saxpy')).toContain(`${r.cycles} cycles, against ${one.cycles} for the same program on one lane`);
    const speed = (one.cycles / r.cycles).toFixed(1);
    expect(kase('p_saxpy')).toContain(`${one.cycles} cycles on average against ${r.cycles}, ${speed}× slower, with the other three lanes masked ${one.idle}% of the time`);
    expect(kase('p_saxpy')).toContain(`${r.size} words, ${r.cycles} cycles, ${r.laneOps} lane-ops, no lane idle`);
    expect(kase('p_saxpy')).toContain(`fewer lane-ops (${one.laneOps})`);
    expect(kase('p_saxpy')).toContain(`${pct(r.laneOps! - one.laneOps!, one.laneOps!)}% more work for ${speed}× the speed`);
    // 7 instructions per element per set bit: the inner loop
    const inner = PUZZLES.p_saxpy.ref.slice(PUZZLES.p_saxpy.ref.indexOf('elem:'), PUZZLES.p_saxpy.ref.indexOf('next:'));
    expect(inner.trim().split('\n')).toHaveLength(7);
    expect(kase('p_saxpy')).toContain('7 instructions per element per set bit');
  });

  it('a reduction: the combine\'s idle lanes, a tree, every lane repeating it', () => {
    const r = runPuzzle(PUZZLES.p_reduce, PUZZLES.p_reduce.ref), tree = runPuzzle(PUZZLES.p_reduce, REDUCE_TREE), all = runPuzzle(PUZZLES.p_reduce, REDUCE_ALL);
    expect([tree.ok, all.ok]).toEqual([true, true]);
    expect([r.cycles, r.laneOps]).toEqual([par('p_reduce').cycles, par('p_reduce').laneops]);
    const at = (n: number) => r.results.find((t) => t.name.includes(`(${n} words)`))!.idle!;
    for (const t of [why('p_reduce'), kase('p_reduce')]) expect(t).toContain(`${at(4)}% of the lane-steps idle on 4 words, ${at(32)}% on 32`);
    expect(kase('p_reduce')).toContain(`${r.size} words, ${r.cycles} cycles, ${r.laneOps} lane-ops`);
    expect(tree.cycles).toBe(r.cycles + 1);
    expect(tree.laneOps).toBeGreaterThan(r.laneOps!);
    expect(kase('p_reduce')).toContain(`is ${tree.cycles} cycles and ${tree.laneOps} lane-ops`);
    expect(all.cycles).toBe(r.cycles - 1);
    expect(kase('p_reduce')).toContain(`${all.laneOps} lane-ops, and lane-ops are graded`);
  });

  it('a histogram: privatized counters, and what goes wrong without bar', () => {
    const r = runPuzzle(PUZZLES.p_hist, PUZZLES.p_hist.ref);
    const nobar = runPuzzle(PUZZLES.p_hist, PUZZLES.p_hist.ref.replace(/^\s*bar.*\n/m, ''));
    expect([r.size, r.cycles, r.laneOps, r.idle]).toEqual([41, par('p_hist').cycles, par('p_hist').laneops, 0]);
    expect(why('p_hist')).toContain(`${16 * 8} words`);
    expect(why('p_hist')).toContain(`${r.cycles} cycles, every lane busy`);
    expect(kase('p_hist')).toContain(`${r.size} words, ${r.cycles} cycles, ${r.laneOps} lane-ops, no lane idle`);
    expect(nobar.ok).toBe(false);
    expect(nobar.results.some((t) => /warp 1 runs ahead/.test(t.why ?? ''))).toBe(true);
    expect(kase('p_hist')).toContain(`while the warps take turns (${nobar.cycles} cycles)`);
  });

  it('spin: the clear is most of a frame; without the second bar warp 1 clears too early', () => {
    const p = PUZZLES.p_spin, a = assemble16(p.ref);
    const lo = assemble16(p.ref.slice(0, p.ref.indexOf('frame:'))).words.length;
    const hi = assemble16(p.ref.slice(0, p.ref.indexOf('        srli t1, t0, 2'))).words.length;
    const t = p.tests()[0];
    expect(t.name.startsWith('1 frame')).toBe(true);
    const m = puzzleMachine(p, a.words, a.data, t) as Warps16;
    let clear = 0;
    while (!m.halted && m.steps < p.maxSteps) {
      const pc = m.pc;
      if (m.step().step && pc >= lo && pc < hi) clear++;
    }
    expect(clear / m.steps).toBeGreaterThan(0.75);
    expect(why('p_spin')).toContain(`The clear is ${clear} of the reference's ${m.steps} cycles a frame`);
    expect(kase('p_spin')).toContain(`Of the reference's ${m.steps} cycles for one frame, the clear is ${clear}`);
    const r = runPuzzle(p, p.ref);
    const frames = p.tests().reduce((s, x) => s + (x.mem![0xff] as number), 0) / p.tests().length;
    expect(kase('p_spin')).toContain(`${r.size} words, ${fmt(r.cycles)} cycles over the four tests (${frames} frames on average), ${fmt(r.laneOps!)} lane-ops, ${r.idle}% of the lane-steps idle`);
    const one = runPuzzle(p, p.ref.replace('next:   bar                   # drawn before the next clear', 'next:'));
    expect(one.ok).toBe(false);
    expect(one.results.some((x) => /warp 1 runs ahead/.test(x.why ?? ''))).toBe(true);
  });
});

describe('acts 9–10: the memory numbers', () => {
  it('the computer\'s RAM, the cell and the bit line', () => {
    const ramN = stats(ram(6, 16)).nands, ramT = stats(ram(6, 16)).transistors;
    const c = par('c_computer').nand!;
    expect(why('m_lesson')).toContain(`${fmt(c)} NANDs, and ${fmt(ramN)} of them (${pct(ramN, c)}%)`);
    expect(why('m_lesson')).toContain(`about ${Math.round(ramT / (64 * 16))} transistors a bit`);
    expect(kase('m_lesson')).toContain(`${fmt(ramN)} of its ${fmt(c)} NANDs`);
    for (const t of [why('m_sense'), kase('m_lesson')]) expect(t).toContain(`${CELL_C} fF`);
    expect(why('m_sense')).toContain(`${BITLINE_C} fF`);
    expect(why('m_sense')).toContain(`${par('m_sense').transistors} transistors`);
  });

  it('bank, controller and cache: their costs, the timings, the scaled refresh', () => {
    expect(why('m_bank')).toContain(`${par('m_bank').nand} NANDs`);
    expect(why('m_ctrl')).toContain(`${par('m_ctrl').nand} NANDs against the bank's ${par('m_bank').nand}`);
    expect(caseOf('m_bank')!.alts!.map((x) => x.lib)).toEqual(['rv16_dramctrl']);
    expect(caseOf('m_ctrl')!.alts![0].lib).toBe('rv16_bank');
    const ch36 = stats(dramCtrl({ k: 6, banks: 2, rowWords: 16, policy: 'open' })).nands;
    expect(caseOf('m_ctrl')!.alts![1].nand).toBe(ch36);
    expect([DRAM16.tRCD, DRAM16.tCAS, DRAM16.tRP, DRAM16.tRAS]).toEqual([TIMING.tRCD, TIMING.tCAS, TIMING.tRP, TIMING.tRAS]);
    expect(kase('m_ctrl')).toContain(`(${TIMING.tRCD}, ${TIMING.tCAS}, ${TIMING.tRP} and ${TIMING.tRAS} cycles)`);
    expect(kase('m_ctrl')).toContain(`tREFI is ${DRAM16.tREFI} cycles here, ${fmt(TIMING.tREFI)} for the real 7.8 µs`);
    const hit = DRAM16.tCAS, miss = DRAM16.tRP + DRAM16.tRCD + DRAM16.tCAS;
    expect(why('o_cache')).toContain(`tCAS = ${hit} cycles after its read, a word of another row only after tRP + tRCD + tCAS = ${miss}`);
    expect(kase('o_cache')).toContain(`tCAS = ${hit} cycles on the open row, tRP + tRCD + tCAS = ${miss}`);
    expect(T('m_ctrl')).toContain(`${hit} cycles on an open row, ${miss} on another`);
    expect(T('m_ctrl')).toContain(`tRFC = ${DRAM16.tRFC}`);
    expect(why('o_cache')).toContain(`${fmt(par('o_cache').nand!)} NANDs for 128 data bits`);
  });

  it('what DRAM costs a processor: the benchmarks\' matmul behind a cache', () => {
    type Run = { bench: string; cycles: number; dmiss: number; dstall: number };
    const run = (id: string) => (results.cpus.find((c) => c.id === id)!.runs as Run[]).find((r) => r.bench === 'matmul')!;
    const [fast, open, closed] = ['sc-wb2', 'sc-wb2-dram', 'sc-wb2-dramc'].map(run);
    expect(new Set([fast.dmiss, open.dmiss, closed.dmiss]).size).toBe(1);
    expect([WB_MISS_CLEAN, WB_MISS_DIRTY]).toEqual([8, 12]);
    const lesson = plain(LESSONS.memwall);
    expect(lesson).toContain(`misses ${fast.dmiss} times on matmul`);
    expect(lesson).toContain(`(${WB_MISS_CLEAN} cycles, ${WB_MISS_DIRTY} when a dirty line goes back first)`);
    expect(lesson).toContain(`stall it ${fast.dstall} cycles, ${fmt(fast.cycles)} in all`);
    expect(lesson).toContain(`open pages ${fmt(open.dstall)} (${fmt(open.cycles)}); with closed pages ${fmt(closed.dstall)} (${fmt(closed.cycles)})`);
    expect(kase('m_lesson')).toContain(`misses ${fast.dmiss} times`);
    expect(kase('m_lesson')).toContain(`stall ${fast.dstall} cycles (${fmt(fast.cycles)} in all), over chapter 36's DRAM controller with open pages ${fmt(open.dstall)} (${fmt(open.cycles)}), with closed pages ${fmt(closed.dstall)} (${fmt(closed.cycles)})`);
    expect(kase('o_cache')).toContain(`matmul misses ${fast.dmiss} times: ${fast.dstall} stall cycles`);
    expect(kase('o_cache')).toContain(`${fmt(open.dstall)} behind chapter 36's open-page controller`);
  });

  it('the bus against a crossbar and chapter 38\'s bus; the DMA engine', () => {
    const d = resolveComponent('rv16_bus')!;
    const by = (id: string) => d.netlist!().instances.filter((i) => i.def.id === id).reduce((s, i) => s + stats(i.def).nands, 0);
    const mux = nand('rv16_mux16');
    expect(by('rv16_mux16')).toBe(4 * mux);
    expect(why('m_bus')).toContain(`${par('m_bus').nand} NANDs, ${4 * mux} of them the muxes`);
    expect(kase('m_bus')).toContain(`The four 16-bit muxes are ${4 * mux} of them, the arbiter's three flip-flops ${by('rv16_dff')}`);
    expect(kase('m_bus')).toContain(`the same ${mux}-NAND muxes needs ten`);
    expect(kase('m_bus')).toContain(`${10 * mux} NANDs before its three arbiters`);
    expect(caseOf('m_bus')!.alts![0].nand).toBe(stats(axiBus(2, [0, 1])).nands);
    expect(why('m_dma')).toContain(`${fmt(par('m_dma').nand!)} NANDs`);
    expect(libCost('dma')).toBeDefined();
    expect(why('m_flash')).toContain(`${fmt(par('m_flash').nand!)} NANDs`);
  });

  it('booting from flash: straight from flash, after the copy, behind it', () => {
    const at64 = (src: string) => { const r = runPuzzle(PUZZLES.p_boot, src); expect(r.ok).toBe(true); return r.results.find((t) => t.name === '64 words')!.steps; };
    const [flash, wait, ref] = [BOOT_FLASH, BOOT_WAIT, PUZZLES.p_boot.ref].map(at64);
    expect(why('m_dma')).toContain(`straight from flash takes ${flash} cycles, copied by DMA first ${wait}`);
    expect(kase('m_dma')).toContain(`straight from flash is ${flash} cycles, copied by DMA and then summed ${wait}, summed behind the copy ${ref}`);
    expect(why('p_boot')).toContain(`${wait} cycles on 64 words, summing each word as it lands ${ref}`);
    expect(kase('p_boot')).toContain(`${flash} cycles for 64 words`);
    expect(kase('p_boot')).toContain(`${wait} cycles for 64 words`);
    expect(kase('p_boot')).toContain(`landed (0xFFF2 says how many are left): ${ref}`);
    expect(kase('p_boot')).toContain(`only the ${wait}-cycle version`);
  });
});
