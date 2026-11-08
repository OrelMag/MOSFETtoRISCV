// "A DSP core"'s explorers and scenes. The core is lib/dsp24*.ts, its golden model dsp/iss24.ts (the CPU panel steps that model beside the gates and
// compares every register after every clock, as tests/dsp-core-lockstep.test.ts does); the figures are src/bench/dspcore.json (scripts/dsp/dspcore-bench.ts,
// pinned by tests/dsp-core-chapter.test.ts) and the RV32 machines' src/dsp/macbench.json.

import { assemble24 } from '../dsp/asm24';
import macFigures from '../dsp/macbench.json';
import { aguStep, Iss24, rev8 } from '../dsp/iss24';
import { BENCH24, type Bench24 } from '../dsp/programs24';
import { INSTRS24, MODES24, MODE_NOTES24, disasm24 } from '../dsp/isa24';
import figures from '../bench/dspcore.json';
import { DSP24_STATE, dsp24Computer } from '../lib/dsp24core';
import { singleCycleCpu } from '../lib/cpu';
import { xlenCpu } from '../lib/cpu64';
import { stats } from '../sim/stats';
import { findNode } from '../sim/flatten';
import { pack } from '../sim/values';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { slider } from './mosparts';
import { frameRun } from './slowctl';
import '../styles/line.css';
import '../styles/dsp.css';
import '../styles/dspcore.css';
import { groupNum } from '../sim/numfmt';

export const FIG = figures;
export const bench = (id: string): Bench24 => BENCH24.find((b) => b.id === id)!;
const f2 = (v: number) => v.toFixed(2);
const hex = (v: number, d: number) => (v < 0 ? '?'.repeat(d) : v.toString(16).toUpperCase().padStart(d, '0'));
const sgn = (v: number) => (v & 0x8000 ? v - 0x10000 : v);

/** Cycles per multiply-accumulate on the DSP core (setup, loop instructions and rounding included) and the figure per product on an RV32 machine. */
export const dspPerProduct = (id: 'fir16' | 'fir64' | 'biquad' | 'dot'): number => FIG.cycles[id].cycles / FIG.cycles[id].macs;
type MacFig = { period: number; nands: number; benches: Record<string, { kernel: number; products: number }> };
const MACHINES = macFigures.machines as unknown as Record<string, MacFig>;
export const rvPerProduct = (m: string, id: string): number => MACHINES[m].benches[id].kernel / MACHINES[m].benches[id].products;
/** An RV32 machine's NANDs without its data memory (instance dm), to compare with a core that has none. */
export function rvWithoutDm(m: string): number {
  const def = m === 'rv32im' ? xlenCpu([0x13, 0x13], { xlen: 32, m: true }) : singleCycleCpu([0x13, 0x13], m === 'rv32i' ? {} : { mac: true });
  const dm = def.netlist?.().instances.find((i) => i.name === 'dm');
  return MACHINES[m].nands - (dm ? stats(dm.def).nands : 0);
}
export const rvFigure = (m: string): { nands: number; period: number } => ({ nands: MACHINES[m].nands, period: MACHINES[m].period });

const program = (b: Bench24) => assemble24(b.src);

// ---- the CPU panel ------------------------------------------------------------------------------------------------------------------------

interface PanelApi { cycles: () => number; agrees: () => boolean; halted: () => boolean; run: () => void; outs: () => number[] }
export const dspApi = new WeakMap<Stage, PanelApi>();

/** The panel beside the gates: listing, registers, pointers and their windows, the loop, the accumulator, and the golden model's verdict. */
export function dspPanel(id: string): ScenePanel {
  return (stage) => {
    const b = bench(id), asm = program(b);
    let iss = new Iss24(asm.words, b.x, b.y);
    let bad: string | null = null, stopRun: (() => void) | null = null;
    const hw = (path: string) => { const n = findNode(stage.sim!.design.root, path.split('.')); return n ? pack(stage.sim!.getBits(n.ports.q)) : -1; };
    const compare = () => {
      if (!stage.sim) return;
      const want: [string, number][] = [['pc', iss.pc], ...[...iss.r].map((v, i): [string, number] => [`r${i}`, v]), ...[...iss.p].map((v, i): [string, number] => [`p${i}`, v]),
        ['xb', iss.xb], ['xl', iss.xl], ['xm', iss.xm], ['yb', iss.yb], ['yl', iss.yl], ['ym', iss.ym], ['ls', iss.ls], ['le', iss.le], ['lc', iss.lc], ['la', iss.la]];
      const path = (k: string): string => (k === 'pc' ? DSP24_STATE.pc : /^r\d$/.test(k) ? DSP24_STATE.r[+k[1]] : /^p\d$/.test(k) ? DSP24_STATE.p[+k[1]] : (DSP24_STATE as unknown as Record<string, string>)[k]);
      for (const [k, v] of want) if (hw(path(k)) !== v) { bad = `${k} is ${hex(hw(path(k)), 2)} on the gates, ${hex(v, 2)} in the model`; return; }
      if (hw(DSP24_STATE.acc) !== Number(BigInt.asUintN(40, iss.acc))) bad = 'the accumulator differs';
    };
    stage.edgeHooks.add({
      after: () => {
        if (stage.cycles <= 1 && iss.steps > 1) { iss = new Iss24(asm.words, b.x, b.y); bad = null; }
        if (bad) return;
        iss.step();
        compare();
      },
    });
    stage.historyHooks.add({ save: () => ({ s: iss.save(), bad }), restore: (v) => { const o = v as { s: ReturnType<Iss24['save']>; bad: string | null }; iss.restore(o.s); bad = o.bad; } });
    const listing = h('div', { class: 'dsp-list' }), regs = h('div', { class: 'cpu-mem' }), ptrs = h('div', { class: 'cpu-mem dsp-ptrs' }), state = h('div', { class: 'cpu-mem dsp-state' }), verdict = h('div', { class: 'dsp-verdict' });
    const runBtn = h('button', { class: 'btn sm primary', onclick: () => api.run() }, 'Run to halt');
    const title = h('h4', null, 'DSP core', h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel cpu-panel dsp-panel', 'data-dock': 'right', 'data-fold': 'narrow', 'data-phone': 'flow' }, title,
      h('div', null, runBtn), verdict, h('div', { class: 'cpu-sec' }, 'Program'), listing, h('div', { class: 'cpu-sec' }, 'Loop and accumulator'), state,
      h('div', { class: 'cpu-sec' }, 'Pointers and windows'), ptrs, h('div', { class: 'cpu-sec' }, 'Registers'), regs);
    const api: PanelApi = {
      cycles: () => stage.cycles, agrees: () => !bad && iss.steps > 0, halted: () => iss.halted, outs: () => [...iss.out],
      run: () => {
        if (stopRun) { stopRun(); return; }
        stage.checkpoint();
        runBtn.textContent = 'Stop';
        stopRun = frameRun(stage, () => iss.halted || !!bad, () => { stopRun = null; runBtn.textContent = 'Run to halt'; update(); stage.refresh?.(); });
      },
    };
    dspApi.set(stage, api);
    const update = () => {
      const lines = asm.lines;
      listing.replaceChildren(...lines.slice(0, 40).map((l) => h('div', { class: `dsp-line${l.addr === iss.pc ? ' cur' : ''}${iss.la && l.addr >= iss.ls && l.addr <= iss.le ? ' in-loop' : ''}` },
        h('span', { class: 'a' }, hex(l.addr, 2)), h('code', null, disasm24(l.word)))));
      listing.querySelector('.cur')?.scrollIntoView?.({ block: 'nearest' });
      const accN = Number(iss.acc);
      state.replaceChildren(
        h('div', { class: 'm' }, h('span', { class: 'n' }, 'loop'), h('span', { class: 'v' }, iss.la ? `${hex(iss.ls, 2)}–${hex(iss.le, 2)}, ${iss.lc} to go` : 'idle')),
        h('div', { class: 'm' }, h('span', { class: 'n' }, 'acc'), h('span', { class: 'v' }, `${hex(Number(BigInt.asUintN(40, iss.acc)), 10)} = ${accN}`)),
        h('div', { class: 'm' }, h('span', { class: 'n' }, 'cycle'), h('span', { class: 'v' }, String(iss.steps))),
        h('div', { class: 'm' }, h('span', { class: 'n' }, 'out'), h('span', { class: 'v' }, iss.out.length ? `${iss.out.length} words, last ${sgn(iss.out[iss.out.length - 1])}` : 'none yet')));
      const win = (i: number) => {
        const x = i < 4, base = x ? iss.xb : iss.yb, len = x ? iss.xl : iss.yl;
        return h('div', { class: 'm' }, h('span', { class: 'n' }, `p${i}`), h('span', { class: 'v' }, `${hex(iss.p[i], 2)}  window ${hex(base, 2)}+${len}`));
      };
      ptrs.replaceChildren(...[0, 1, 4, 5].map(win), h('div', { class: 'm' }, h('span', { class: 'n' }, 'm'), h('span', { class: 'v' }, `x ${sgn(iss.xm << 8) >> 8}, y ${sgn(iss.ym << 8) >> 8}`)));
      regs.replaceChildren(...Array.from({ length: 8 }, (_, i) => h('div', { class: 'm' }, h('span', { class: 'n' }, `r${i}`), h('span', { class: 'v' }, `${hex(iss.r[i], 4)} ${sgn(iss.r[i])}`))));
      verdict.className = `dsp-verdict ${bad ? 'bad' : 'ok'}`;
      verdict.textContent = bad ? `✗ differs: ${bad}` : iss.steps ? `✓ matches golden model after ${iss.steps} clocks${iss.halted ? ' (halted)' : ''}` : 'Waiting for the first clock';
    };
    update();
    return { el, update };
  };
}

/** The core with a benchmark loaded, on the cycle engine, with the panel. */
export function dspScene(id: string, path?: string[]): () => Scene {
  return () => {
    const b = bench(id);
    return { root: dsp24Computer(program(b).words, b.x, b.y), engine: 'cycle', autoClock: false, ...(path ? { path } : {}), panels: [dspPanel(id)], hiddenOutputs: ['out'] };
  };
}

// ---- the address generator ---------------------------------------------------------------------------------------------------------------

/** The sequence of addresses a pointer visits with a mode (the model's aguStep, which the gates equal on every input). */
export function addressRun(start: number, mode: number, base: number, len: number, m: number, n: number): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) { out.push(p); p = aguStep(p, mode, base, len, m); }
  return out;
}

export function aguWidget(): Widget {
  let mode = 4, base = 4, len = 6, m = 32, start = 4;
  const grid = h('div', { class: 'dsp-cells' }), seq = h('p', { class: 'sub' }), note = h('p', { class: 'sub' });
  const modes = h('div', { class: 'dsp-modes' }, ...MODES24.map((s, i) => h('button', { class: 'btn sm', 'data-mode': String(i), onclick: () => { mode = i; paint(); } }, `x(p)${s || ' '}`)));
  const paint = () => {
    const cells = 64, run = addressRun(mode === 6 ? 0 : start, mode, base, len, m, mode === 6 ? 64 : 14), seen = new Set(run);
    grid.replaceChildren(...Array.from({ length: cells }, (_, i) => h('span', { class: `dsp-cell${seen.has(i) ? ' hit' : ''}${i === run[0] ? ' first' : ''}${(mode === 4 || mode === 5) && i >= base && i < base + len ? ' win' : ''}`, title: String(i) }, run.indexOf(i) >= 0 && run.indexOf(i) < 99 ? String(run.indexOf(i)) : '')));
    seq.textContent = `addresses: ${run.slice(0, 16).join(', ')}${run.length > 16 ? ' …' : ''}`;
    note.textContent = `${MODES24[mode] || '(none)'}: ${MODE_NOTES24[mode]}.${mode === 6 ? ` rev(rev(p) + rev(m)), m = ${m}: reversed ${rev8(m)}.` : ''}`;
    modes.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(+b.getAttribute('data-mode')! === mode)));
  };
  const sb = slider('base', 0, 40, 1, base, (v) => String(v), (v) => { base = v; start = Math.max(start, v); paint(); });
  const sl = slider('length', 1, 20, 1, len, (v) => String(v), (v) => { len = v; paint(); });
  const sm = slider('m', 1, 40, 1, m, (v) => String(v), (v) => { m = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'One pointer, one mode'), modes, grid, seq, note), h('div', { class: 'panel mos-ctl' }, sb.el, sl.el, sm.el)) };
}

// ---- the FFT's two ideas ---------------------------------------------------------------------------------------------------------------

export function fftWidget(): Widget {
  const b = bench('fft');
  const iss = new Iss24(program(b).words, b.x, b.y);
  iss.run();
  const mag = Array.from({ length: 32 }, (_, k) => Math.hypot(sgn(iss.out[k]), sgn(iss.out[64 + k])));
  const peak = Math.max(...mag);
  const bars = h('div', { class: 'dsp-bars' }, ...mag.map((v, k) => h('span', { class: 'dsp-bar', title: `bin ${k}: ${Math.round(v)}`, style: `height:${Math.max(1, Math.round((v / peak) * 100))}%` })));
  const order = addressRun(0, 6, 0, 0, 32, 64);
  const orderEl = h('p', { class: 'sub' }, `bit-reversed addresses, 64 points (m = 32): ${order.slice(0, 16).join(', ')} …`);
  const cyc = FIG.cycles.fft.cycles;
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'The 64-point FFT, run on the model the gates equal'), bars,
    h('p', { class: 'sub' }, `magnitude of bins 0–31: three tones: bins 5 and 17 from the real part, bin 9 from the imaginary part. ${cyc} clocks in all.`), orderEl)) };
}

// ---- cost of a loop -------------------------------------------------------------------------------------------------------------------------

export function loopWidget(): Widget {
  let taps = 16;
  const out = h('div', { class: 'dsp-cost' });
  const paint = () => {
    const rows: [string, number, string][] = [
      ['RV32IM, mul instruction in a plain loop', rvPerProduct('rv32im', 'fir64'), 'rv32im'],
      ['RV32I + MAC, one tap per iteration', rvPerProduct('mac', 'fir64'), 'mac'],
      ['RV32I + packed MAC, two taps per word', rvPerProduct('mac2u', 'fir64'), 'mac2u'],
      [`DSP core, ${taps} + 7 clocks a sample`, (taps + 7) / taps, 'dsp'],
    ];
    const max = Math.max(...rows.map((r) => r[1]));
    out.replaceChildren(...rows.map(([name, v]) => h('div', { class: 'dsp-row' }, h('span', { class: 'n' }, name), h('span', { class: 'bar', style: `width:${Math.round((v / max) * 100)}%` }), h('span', { class: 'v' }, `${f2(v)} clocks a tap`))));
  };
  const s = slider('taps in the loop', 2, 128, 1, taps, (v) => String(v), (v) => { taps = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'What one tap costs'), out), h('div', { class: 'panel mos-ctl' }, s.el)) };
}

// ---- the benchmark table ----------------------------------------------------------------------------------------------------------------

export function benchWidget(): Widget {
  const ids = ['fir16', 'fir64', 'biquad', 'dot'] as const;
  const machines: [string, string][] = [['rv32im', 'RV32IM'], ['mac', 'RV32I + MAC'], ['mac2u', 'RV32I + MAC, packed'], ['dsp', 'DSP core']];
  const row = (id: string) => h('tr', null, h('th', null, bench(id).name), ...machines.map(([m]) => {
    const v = m === 'dsp' ? dspPerProduct(id as 'fir16') : rvPerProduct(m, id);
    const t = v * (m === 'dsp' ? FIG.period : rvFigure(m).period);
    return h('td', null, `${f2(v)} clocks`, h('br'), h('span', { class: 'sub' }, `${Math.round(t)} delays`));
  }));
  const costRow = h('tr', null, h('th', null, 'NANDs, period'), ...machines.map(([m]) => h('td', null, m === 'dsp' ? `${groupNum(FIG.nands.core)}, ${FIG.period}` : `${groupNum(rvFigure(m).nands)}, ${rvFigure(m).period}`)));
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'Clocks and time per product, measured'),
    h('table', { class: 'dsp-table' }, h('thead', null, h('tr', null, h('th', null, ''), ...machines.map(([, n]) => h('th', null, n)))), h('tbody', null, ...ids.map(row), costRow)),
    h('p', { class: 'sub' }, 'Per product, so the machines\' different block lengths do not matter. The RV32 columns are the MAC chapter\'s kernels without setup; the DSP core\'s include its loop set-up, rounding and output instructions. Basis of the last row: the RV32 columns are the whole core without its program ROM, with a 32-word data memory (about a third of the NANDs) and a 32 × 32 register file; the DSP core is without its program ROM and both memories, with 8 × 16 registers. Periods are in NAND delays: the RV32IM has Kogge-Stone adders, the MAC cores do not.'))) };
}

// ---- the instruction set -----------------------------------------------------------------------------------------------------------------

export function instrTable(): string {
  return `<table class="dsp-table"><thead><tr><th>op</th><th>instruction</th><th>does</th></tr></thead><tbody>${INSTRS24.map((i) => `<tr><td>${i.op}</td><td><code>${i.name}</code></td><td>${i.summary}</td></tr>`).join('')}</tbody></table>`;
}
