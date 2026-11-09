// "A MAC on the RV32"'s explorers and scenes. Every number is dsp/mac.ts's, lib/macunit.ts's gates', or the benchmark figures measured on gates (dsp/macbench.json,
// scripts/mac-bench.ts, pinned by tests/dsp-mac-bench.test.ts).

import { ACC_BITS, accHex, macProduct, MacModel, MAC_F3, MAC_OPS, raccOf, wrapAcc, type MacOp } from '../dsp/mac';
import figures from '../dsp/macbench.json';
import { BENCH_NAME, MAC_BENCHES, MAC_MACHINES, MACHINE_NAME, macPlan, type MacBench, type MacMachine } from '../dsp/macbench';
import { macUnit } from '../lib/macunit';
import { stats } from '../sim/stats';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { mkChips } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/dspmac.css';
import { groupNum } from '../sim/numfmt';

import { numOf } from '../chapters/order';
// ---- the measured figures ---------------------------------------------------------------------------------------------------------------

interface BenchFig { cycles: number; setupCycles: number; kernel: number; products: number }
interface MachineFig { nands: number; period: number; benches: Record<MacBench, BenchFig> }
const FIG = figures.machines as unknown as Record<MacMachine, MachineFig>;

/** Measured on gates: the kernel's clocks, the products it performs. */
export const benchFig = (m: MacMachine, b: MacBench): BenchFig => FIG[m].benches[b];
/** Clocks per multiply-accumulate, the setup (the data into memory) taken out. */
export const perProduct = (m: MacMachine, b: MacBench): number => FIG[m].benches[b].kernel / FIG[m].benches[b].products;
export const machineCost = (m: MacMachine): { nands: number; period: number } => ({ nands: FIG[m].nands, period: FIG[m].period });
/** Time per product in NAND delays: clocks × the clock period static timing allows. */
export const timePerProduct = (m: MacMachine, b: MacBench): number => perProduct(m, b) * FIG[m].period;
export const f1 = (v: number) => v.toFixed(1);
export const f2 = (v: number) => v.toFixed(2);
const n0 = (v: number) => groupNum(Math.round(v));

/** What the MAC adds to the core: NANDs and period, against the same core without it. */
export const macDelta = () => ({ nands: FIG.mac.nands - FIG.rv32i.nands, period: FIG.mac.period - FIG.rv32i.period });
export const unitNands = () => stats(macUnit()).nands;

// ---- clocks a product, as bars -----------------------------------------------------------------------------------------------------------

/** Bars of clocks per product for some machines on one benchmark. */
export function barsWidget(machines: readonly MacMachine[], first: MacBench = 'fir64', withTime = false): () => Widget {
  return () => {
    let bench: MacBench = first;
    const bars = h('div', { class: 'ln-bars' }), note = h('p', { class: 'sub' });
    const sel = h('select', { 'aria-label': 'benchmark' }, ...MAC_BENCHES.map((b) => h('option', { value: b }, BENCH_NAME[b]))) as HTMLSelectElement;
    sel.value = bench;
    const paint = () => {
      const vals = machines.map((m) => (withTime ? timePerProduct(m, bench) : perProduct(m, bench))), top = Math.max(...vals);
      bars.replaceChildren(...machines.map((m, i) => h('div', { class: 'ln-bar' }, h('span', null, MACHINE_NAME[m]),
        h('div', { class: 'ln-barbox' }, h('i', { class: 'ok', style: `width:${Math.max(1.5, (vals[i] / top) * 100)}%` })), h('b', null, withTime ? n0(vals[i]) : f2(vals[i])))));
      const p = macPlan(bench, machines[0]);
      note.textContent = `${BENCH_NAME[bench]}: ${p.products} multiply-accumulates. ${withTime ? 'NAND delays a product: clocks × the period static timing allows for that core.' : 'Clocks a product, measured on gates with the data setup taken out.'}`;
    };
    sel.addEventListener('change', () => { bench = sel.value as MacBench; paint(); });
    paint();
    return { el: h('div', { class: 'widget mos dm-w' }, h('div', { class: 'panel' }, h('h3', null, withTime ? 'Time a product' : 'Clocks a product'), h('label', { class: 'dm-sel' }, 'Benchmark ', sel), bars, note)) };
  };
}

// ---- the unit, driven an instruction at a time ---------------------------------------------------------------------------------------------

export const macApi = new WeakMap<Stage, { issued: () => number; agrees: () => boolean; wrapped: () => boolean; issue: (op: MacOp, n: number) => void; fullScale: () => void }>();
const pulse = (st: Stage) => { st.sim!.setInput('clk', 1); st.sim!.settle(); st.sim!.setInput('clk', 0); st.sim!.settle(); };
const u32 = (v: number) => v >>> 0;

const unitPanel: ScenePanel = (stage: Stage): Widget => {
  let op: MacOp = 'mac2', alo = 3000, ahi = -2000, blo = -1234, bhi = 4321, sh = 15;
  let model = new MacModel(), ran = 0, ok = true, wraps = 0;
  const status = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub' }), word = h('div', { class: 'dm-word' });
  const sel = h('select', { 'aria-label': 'instruction' }, ...MAC_OPS.map((o) => h('option', { value: o }, o))) as HTMLSelectElement;
  sel.value = op;
  const a = () => u32(((ahi & 0xffff) << 16) | (alo & 0xffff)), b = () => u32(((bhi & 0xffff) << 16) | (blo & 0xffff));
  const paint = () => {
    const sim = stage.sim;
    const lastY = raccOf(model.acc, sh).y;
    const acc = sim ? BigInt.asIntN(ACC_BITS, BigInt(stage.value('acc'))) : 0n;
    status.replaceChildren(h('span', null, 'issued ', h('b', null, String(ran))), h('span', null, 'acc ', h('b', null, `0x${accHex(acc)}`)), h('span', null, 'y (racc) = ', h('b', null, String(lastY))));
    word.textContent = `rs1 = 0x${u32(a()).toString(16).padStart(8, '0')} (hi ${ahi}, lo ${alo})   rs2 = 0x${u32(b()).toString(16).padStart(8, '0')} (hi ${bhi}, lo ${blo})`;
    note.textContent = !ran ? 'Issue an instruction: the gates take it at the clock edge, and the model is asked the same.' : ok ? `At every clock the gates' accumulator and result matched the model${wraps ? `; the accumulator has wrapped ${wraps} time${wraps === 1 ? '' : 's'} (two's complement, 40 bits)` : ''}.` : 'The gates and the model disagreed.';
  };
  const issue = (o: MacOp, n: number) => {
    const sim = stage.sim;
    if (!sim) return;
    stage.checkpoint();
    for (let i = 0; i < n; i++) {
      const f3 = MAC_F3[o], before = model.acc;
      sim.setInput('a', a()); sim.setInput('b', b()); sim.setInput('op', f3); sim.setInput('en', 1); sim.setInput('sh', sh); sim.settle();
      if (o === 'racc' && BigInt(stage.value('y') | 0) !== BigInt(raccOf(model.acc, sh).y)) ok = false;
      pulse(stage);
      if (o !== 'racc') { model.exec(f3, a(), b()); if (f3 < 2 && wrapAcc(before + macProduct(f3, a(), b())) !== before + macProduct(f3, a(), b())) wraps++; }
      if (BigInt.asIntN(ACC_BITS, BigInt(stage.value('acc'))) !== model.acc) ok = false;
      ran++;
    }
    sim.setInput('en', 0); sim.settle();
    if (BigInt(stage.value('y') | 0) !== BigInt(raccOf(model.acc, sh).y)) ok = false; // y follows the accumulator and the shift at all times
    stage.refresh();
    paint();
  };
  const fullScale = () => { alo = ahi = blo = bhi = -32768; sls.slice(0, 4).forEach((s) => s.set(-32768)); issue('clracc', 1); issue('mac2', 320); };
  macApi.set(stage, { issued: () => ran, agrees: () => ok && ran > 0, wrapped: () => wraps > 0, issue, fullScale });
  sel.addEventListener('change', () => { op = sel.value as MacOp; paint(); });
  const sls = [
    slider('rs1 low', -32768, 32767, 1, alo, String, (v) => { alo = v; paint(); }), slider('rs1 high', -32768, 32767, 1, ahi, String, (v) => { ahi = v; paint(); }),
    slider('rs2 low', -32768, 32767, 1, blo, String, (v) => { blo = v; paint(); }), slider('rs2 high', -32768, 32767, 1, bhi, String, (v) => { bhi = v; paint(); }),
    slider('Shift', 0, 63, 1, sh, String, (v) => { sh = v; stage.sim?.setInput('sh', sh); stage.sim?.settle(); stage.refresh(); paint(); }),
  ];
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'Issue an instruction'),
    h('div', { class: 'dram-ops' }, sel, h('button', { type: 'button', class: 'btn sm', onclick: () => issue(op, 1) }, 'Issue'), h('button', { type: 'button', class: 'btn sm', onclick: () => issue(op, 64) }, 'Issue × 64')),
    ...sls.map((s) => s.el), word, status, note);
  stage.resetHooks.add(() => { model = new MacModel(); ran = 0; ok = true; wraps = 0; paint(); });
  paint();
  return { el, update: paint };
};

export function unitScene(): Scene {
  return { root: macUnit(), inputs: { a: 0, b: 0, op: 0, en: 0, sh: 15, clk: 0 }, clock: 'clk', autoClock: false, powerOn: 'zero', hiddenInputs: ['a', 'b', 'op', 'en', 'sh', 'clk'], panels: [unitPanel] };
}

// ---- the read: shift, round once, clamp once -----------------------------------------------------------------------------------------------

export function readWidget(): Widget {
  let acc = (1n << 36n) - 1n, sh = 15;
  const mag = slider('Accumulator, magnitude (bits)', 1, 40, 1, 36, (v) => `2^${v}`, (v) => { acc = (acc < 0n ? -1n : 1n) * ((1n << BigInt(v)) - 1n); paint(); });
  const neg = h('label', { class: 'cd-check' }, h('input', { type: 'checkbox', onchange: (e: Event) => { acc = (e.target as HTMLInputElement).checked ? -(acc < 0n ? -acc : acc) : (acc < 0n ? -acc : acc); paint(); } }), ' Negative');
  const shs = slider('Shift', 0, 63, 1, sh, String, (v) => { sh = v; paint(); });
  const rows = h('div', { class: 'dm-rows' }), chips = mkChips(3), note = h('p', { class: 'sub' });
  function paint() {
    const r = raccOf(acc, sh), trunc = acc >> BigInt(sh), tie = sh > 0 && ((acc >> BigInt(sh - 1)) & 1n) === 1n;
    rows.replaceChildren(
      h('div', null, h('span', null, 'acc'), h('code', null, `${acc} (0x${accHex(acc)})`)),
      h('div', null, h('span', null, 'acc ≫ shift'), h('code', null, String(trunc))),
      h('div', null, h('span', null, 'first bit dropped'), h('code', null, sh > 0 ? (tie ? '1: add it back' : '0') : 'none at shift 0')),
      h('div', null, h('span', null, 'rounded'), h('code', null, String(r.exact))),
      h('div', null, h('span', null, 'clamped to 32 bits'), h('code', null, String(r.y))));
    chips.set(0, String(r.y), 'racc result');
    chips.set(1, r.sat ? 'clamped' : 'fits', r.sat ? 'the rounded value did not fit 32 bits' : 'the rounded value fits 32 bits', r.sat ? 'bad' : 'ok');
    chips.set(2, acc >= 2n ** 39n || acc < -(2n ** 39n) ? 'out of range' : 'in range', '40-bit accumulator holds −2^39 … 2^39 − 1');
    note.textContent = '';
  }
  paint();
  return { el: h('div', { class: 'widget mos dm-w' }, h('div', { class: 'panel' }, h('h3', null, 'Reading the accumulator'), rows, chips.el, note), h('div', { class: 'panel mos-ctl' }, mag.el, neg, shs.el)) };
}

// ---- pairs: where the packed words line up ------------------------------------------------------------------------------------------------

/** FIR with mac2 on packed 16-bit samples, T taps: for the output n, which coefficient pair meets which data word. */
export function alignRows(T: number, n: number): { word: number; samples: [number, number]; taps: [number | null, number | null] }[] {
  // y[n] = Σ_j hr[j]·xs[n + j]: data word w holds xs[2w], xs[2w+1]; the coefficient index against xs[m] is m − n
  const rows: { word: number; samples: [number, number]; taps: [number | null, number | null] }[] = [];
  const t = (j: number) => (j >= 0 && j < T ? j : null);
  for (let w = Math.floor(n / 2); 2 * w <= n + T; w++) {
    const taps: [number | null, number | null] = [t(2 * w - n), t(2 * w + 1 - n)];
    if (taps[0] !== null || taps[1] !== null) rows.push({ word: w, samples: [2 * w, 2 * w + 1], taps });
  }
  return rows;
}

export function alignWidget(): Widget {
  let n = 0;
  const T = 8;
  const out = h('div', { class: 'dm-rows' }), note = h('p', { class: 'sub' });
  const sn = slider('Output n', 0, 5, 1, n, String, (v) => { n = v; paint(); });
  function paint() {
    const rows = alignRows(T, n);
    out.replaceChildren(h('div', { class: 'dm-head' }, h('span', null, 'data word'), h('code', null, 'lo, hi sample'), h('code', null, 'lo, hi tap')),
      ...rows.map((r) => h('div', null, h('span', null, `w${r.word}`), h('code', null, `x[${r.samples[0]}], x[${r.samples[1]}]`),
        h('code', { class: r.taps[0] === null || r.taps[1] === null ? 'dm-half' : '' }, `${r.taps[0] === null ? '–' : `h'[${r.taps[0]}]`}, ${r.taps[1] === null ? '–' : `h'[${r.taps[1]}]`}`))));
    const edge = rows.filter((r) => r.taps[0] === null || r.taps[1] === null).length;
    note.textContent = `${T} taps, output ${n} (${n % 2 ? 'odd' : 'even'}): ${rows.length} words, ${edge} of them half empty. The words the pairs of taps need are not the same for an even and an odd output, so the program keeps two packed copies of the coefficients and the samples stay where they are.`;
  }
  paint();
  return { el: h('div', { class: 'widget mos dm-w' }, h('div', { class: 'panel' }, h('h3', null, 'Pairs of samples against pairs of taps'), out, note), h('div', { class: 'panel mos-ctl' }, sn.el)) };
}

// ---- the measured table ---------------------------------------------------------------------------------------------------------------------

export function tableWidget(): Widget {
  const rows = (b: MacBench) => MAC_MACHINES.map((m) => h('tr', null, h('th', null, MACHINE_NAME[m]), h('td', null, n0(benchFig(m, b).kernel)), h('td', null, f2(perProduct(m, b))),
    h('td', null, n0(FIG[m].nands)), h('td', null, String(FIG[m].period)), h('td', null, n0(timePerProduct(m, b)))));
  const body = h('tbody');
  let bench: MacBench = 'fir64';
  const sel = h('select', { 'aria-label': 'benchmark' }, ...MAC_BENCHES.map((b) => h('option', { value: b }, BENCH_NAME[b]))) as HTMLSelectElement;
  sel.value = bench;
  const paint = () => body.replaceChildren(...rows(bench));
  sel.addEventListener('change', () => { bench = sel.value as MacBench; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos dm-w' }, h('div', { class: 'panel' }, h('h3', null, 'One benchmark, five machines'), h('label', { class: 'dm-sel' }, 'Benchmark ', sel),
    h('div', { class: 'ln-scroll' }, h('table', { class: 'ln-table' }, h('thead', null, h('tr', null, h('th', null, 'Machine'), h('th', null, 'Kernel clocks'), h('th', null, 'Clocks a product'), h('th', null, 'NANDs'), h('th', null, 'Period'), h('th', null, 'NAND delays a product'))), body)),
    h('p', { class: 'sub' }, `Kernel clocks are measured on gates with the data setup taken out. NANDs are the core without its program ROM, with the 32-word data memory; the period is static timing in NAND delays. RV32IM is chapter ${numOf('widths')}'s one-drawing core at 32 bits (Kogge–Stone adders), because the single-cycle core of chapter 14 has no M.`))) };
}

// ---- a filter on the CPU panel ---------------------------------------------------------------------------------------------------------------

export const FILTER_X = [1200, -800, 3000, 2500, -1500, 700, -300, 2000];
export const FILTER_H = [1000, 3000, 6000, 9000, 8000, 3500, 1500, 500];
/** One output of an 8-tap FIR on packed samples: four words of mac2, read at shift 15. The answer, from the exact model. */
export const FILTER_SUM = FILTER_X.reduce((a, x, i) => a + BigInt(x * FILTER_H[i]), 0n);
export const FILTER_Y = raccOf(FILTER_SUM, 15).y;
const packW = (lo: number, hi: number) => (((hi & 0xffff) << 16) | (lo & 0xffff)) | 0;
export function filterSource(): string {
  const out: string[] = ['# one output of an 8-tap filter, samples and taps packed two to a word'];
  for (let w = 0; w < 4; w++) out.push(`li t0, ${packW(FILTER_X[2 * w], FILTER_X[2 * w + 1])}`, `sw t0, ${4 * w}(zero)`, `li t0, ${packW(FILTER_H[2 * w], FILTER_H[2 * w + 1])}`, `sw t0, ${16 + 4 * w}(zero)`);
  out.push('clracc');
  for (let w = 0; w < 4; w++) out.push(`lw t1, ${4 * w}(zero)`, `lw t2, ${16 + 4 * w}(zero)`, 'mac2 t1, t2');
  out.push('li a1, 15', 'racc a0, a1', 'j .');
  return out.join('\n') + '\n';
}
