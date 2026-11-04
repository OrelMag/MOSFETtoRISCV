// Chapter 43's widgets (A UART): the transmitter and receiver scenes with their panels, the clock-error panel with its
// search for the limit, the core on a bench for the error cases, the baud-rate table, the FIFO budget, the UART on the
// bus, and two computers on a wire. Models: comm/uart.ts (edge by edge, equal to the gates), comm/startstop.ts.

import '../styles/clocks.css';
import '../styles/uart.css';
import { frameUnits, levelAt, receive, segments, tolerance, toleranceClosedForm, UART_8N1 } from '../comm/startstop';
import { bytesPerSecond, divisorFor, fifoBudget, FIFO_DEPTH, lineStream, ST_FRAMING, ST_OVERRUN, ST_RXNE, ST_TXFULL, ST_TXIDLE, RX_STATE_NAMES, UART_TOLERANCE } from '../comm/uart';
import { UART_CORE, UART_RX_BENCH, UART_TX_BENCH } from '../lib/uart';
import { busComputer } from '../lib/soc';
import { twoComputers } from '../lib/uartlink';
import { assemble } from '../riscv/asm';
import { UART_COSTS, uartChatSource, uartIrqSource } from '../riscv/uartprograms';
import { findNode } from '../sim/flatten';
import { stats } from '../sim/stats';
import { pack } from '../sim/values';
import { h, s } from '../ui/dom';
import type { Scene, Stage, Widget } from '../view/stage';
import { slider } from './mosparts';

const hex2 = (v: number) => v.toString(16).padStart(2, '0').toUpperCase();
const chr = (v: number) => (v >= 32 && v < 127 ? String.fromCharCode(v) : '·');
const pct = (x: number, d = 2) => `${(100 * x).toFixed(d)} %`;
const words = (src: string): number[] => { const a = assemble(src); if (a.errors.length) throw new Error(a.errors[0].message); return a.words; };

// ---- helpers over a stage's simulation ---------------------------------------------------------------------------------

const outp = (st: Stage, name: string): number => pack(st.sim!.getBits(st.sim!.design.root.ports[name]));
const outAt = (st: Stage, path: string[], name: string): number => { const n = findNode(st.sim!.design.root, path); return n ? pack(st.sim!.getBits(n.ports[name])) : -1; };
function pulse(st: Stage, clk: string): void { const sim = st.sim!; sim.settle(); sim.setInput(clk, 1); sim.settle(); sim.setInput(clk, 0); sim.settle(); }

/** A timer-driven loop of `step` calls (`perTick` of them every `ms`) until step returns false; one history checkpoint at the start. */
class Loop {
  private t: ReturnType<typeof setInterval> | null = null;
  constructor(private stage: Stage, private step: () => boolean, private after: () => void, private perTick = 40, private ms = 30) {}
  get running(): boolean { return this.t !== null; }
  start(): void {
    if (this.t) return;
    this.stage.checkpoint();
    this.t = setInterval(() => {
      let go = true;
      for (let i = 0; i < this.perTick && go; i++) go = this.step();
      this.stage.refresh(); this.after();
      if (!go) this.stop();
    }, this.ms);
  }
  stop(): void { if (this.t) clearInterval(this.t); this.t = null; this.after(); }
}

const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls, title }, label); b.addEventListener('click', f); return b; };
const select = (label: string, opts: [string, string][], value: string, on: (v: string) => void) => {
  const sel = h('select', { class: 'mc-sel', 'aria-label': label }) as HTMLSelectElement;
  for (const [v, t] of opts) sel.append(h('option', { value: v }, t));
  sel.value = value;
  sel.addEventListener('change', () => on(sel.value));
  return sel;
};

/** A waveform of one line level per cycle with the frame's cells marked: `labels` start at `from`, each `cell` cycles wide. */
function waveSvg(levels: number[], total: number, from: number, cell: number, labels: string[], aria: string, marks: { x: number; cls: string; text?: string }[] = []): SVGSVGElement {
  const W = 640, H = 96, L = 8, R = 8, Y1 = 26, Y0 = 62;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot uart-wave', role: 'img', 'aria-label': aria }) as SVGSVGElement;
  const X = (i: number) => L + (i / Math.max(1, total)) * (W - L - R);
  if (from >= 0) labels.forEach((t, k) => {
    const x0 = X(from + k * cell), x1 = X(from + (k + 1) * cell);
    svg.append(s('line', { x1: x0, x2: x0, y1: 14, y2: 76, class: 'grid' }), s('text', { x: (x0 + x1) / 2, y: 90, 'text-anchor': 'middle', class: 'tick' }, t));
  });
  let d = '';
  levels.forEach((v, i) => { const y = v ? Y1 : Y0; d += i === 0 ? `M${X(0)},${y}` : `L${X(i)},${levels[i - 1] ? Y1 : Y0}L${X(i)},${y}`; });
  if (levels.length) d += `L${X(levels.length)},${levels[levels.length - 1] ? Y1 : Y0}`;
  if (!levels.length) d = `M${X(0)},${Y1}L${X(total)},${Y1}`;
  svg.append(s('path', { d, class: 'uart-line' }));
  for (const m of marks) svg.append(s('line', { x1: X(m.x), x2: X(m.x), y1: 10, y2: 80, class: m.cls }), ...(m.text ? [s('text', { x: X(m.x) + 2, y: 10, class: 'tick' }, m.text)] : []));
  return svg;
}

// ---- the transmitter scene ---------------------------------------------------------------------------------------------

export function txScene(): Scene {
  return {
    root: UART_TX_BENCH, inputs: { div: 2, go: 0, din: 0x52, clk: 0 }, hiddenInputs: ['go', 'din'], autoClock: false,
    panels: [(stage: Stage): Widget => {
      let code = 0x52, wave: number[] = [], at = -1, total = 0;
      const svgBox = h('div', { class: 'uart-svg' }), read = h('div', { class: 'mc-status' });
      const div = () => Math.max(1, outp(stage, 'div'));
      const record = () => { wave.push(outp(stage, 'tx')); if (at < 0 && wave[wave.length - 1] === 0) at = wave.length - 1; };
      const hook = { after: () => { record(); paint(); } };
      stage.edgeHooks.add(hook);
      const reset = () => { wave = []; at = -1; total = 0; paint(); };
      stage.resetHooks.add(reset);
      stage.historyHooks.add({ save: () => ({ wave: [...wave], at, total, code }), restore: (v) => { const x = v as { wave: number[]; at: number; total: number; code: number }; wave = x.wave; at = x.at; total = x.total; code = x.code; paint(); } });
      let sent = 0;
      const loop = new Loop(stage, () => {
        stage.sim!.setInput('go', sent === 0 ? 1 : 0);
        pulse(stage, 'clk'); record(); sent++;
        return sent < total;
      }, () => paint(), 24, 30);
      const send = () => {
        if (loop.running) return;
        stage.checkpoint(); wave = []; at = -1;
        stage.sim!.setInput('din', code); sent = 0; total = 1 + 11 * 16 * div();
        loop.start();
      };
      const sel = select('Byte to send', [['82', "0x52  'R'"], ['85', "0x55  'U'"], ['165', '0xA5'], ['0', '0x00'], ['255', '0xFF']], '82', (v) => { code = Number(v); });
      const paint = () => {
        const d = div(), cell = 16 * d, len = Math.max(wave.length, 1);
        const svg = waveSvg(wave, Math.max(len, total || 12 * cell), at, cell, ['start', ...Array.from({ length: 8 }, (_, i) => `d${i}`), 'stop'], 'The transmitter\'s line over time, one cell per bit');
        svgBox.replaceChildren(svg);
        const bits = segments(UART_8N1, code).map((g) => g.level).join('');
        read.replaceChildren(h('span', null, 'byte ', h('b', null, `0x${hex2(code)}`), ` ${chr(code)}`), h('span', null, 'frame ', h('b', null, bits.slice(0, 1) + ' ' + bits.slice(1, 9).split('').join('') + ' ' + bits.slice(9))),
          h('span', null, 'bit ', h('b', null, `${cell} cycles`), ` (${d} per tick)`), h('span', null, 'frame ', h('b', null, `${10 * cell} cycles`)));
      };
      paint();
      const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel', 'data-dock': 'right' }, h('h4', null, 'The line, bit by bit', h('span', { class: 'fold-hint' })),
        h('div', { class: 'mc-row' }, sel, btn('Send byte', 'Load the byte and clock the transmitter through the whole frame', send, 'btn sm primary')),
        svgBox, read, h('p', { class: 'sub' }, 'Change div on the bar to stretch the bit: it is always 16 ticks, a tick being div clock cycles. The line moves only on a tick.'));
      return { el, update: paint, destroy: () => { loop.stop(); stage.edgeHooks.delete(hook); stage.resetHooks.delete(reset); } };
    }],
  };
}

// ---- the receiver scene and the clock-error panel ----------------------------------------------------------------------

/** The last search's result, for challenges. */
export interface RxState { err: number; found: { fast: number; slow: number } | null; last: { ok: boolean; byte: number; err: number } | null; set(err: number): void; send(): void }
const rxStates = new WeakMap<Stage, RxState>();
export const rxState = (st: Stage) => rxStates.get(st);

export function rxScene(): Scene {
  return {
    root: UART_RX_BENCH, inputs: { div: 2, rx: 1, clk: 0 }, hiddenInputs: ['rx'], autoClock: false,
    panels: [(stage: Stage): Widget => {
      const S: RxState = { err: 0, found: null, last: null, set: (e) => { S.err = e; errSl.set(100 * e); paint(); }, send: () => send() };
      rxStates.set(stage, S);
      let code = 0x52, phase = 0.5;
      const svgBox = h('div', { class: 'uart-svg' }), read = h('div', { class: 'clk-verdict' }), live = h('div', { class: 'mc-status' }), limit = h('p', { class: 'sub' });
      const div = () => Math.max(1, outp(stage, 'div'));
      let q: number[] = [], k = 0, got = -1, pushes = 0, ferrs = 0, lastState = 0;
      const step = () => {
        const sim = stage.sim!;
        sim.setInput('rx', k < q.length ? q[k] : 1); k++;
        pulse(stage, 'clk');
        if (outp(stage, 'push') === 1) { pushes++; got = outp(stage, 'data'); }
        if (outp(stage, 'ferr') === 1) ferrs++;
        lastState = outp(stage, 'state');
        return k < q.length + 8 * 16 * div();
      };
      const loop = new Loop(stage, step, () => paintLive(), 40, 30);
      const slSet = { v: 0 };
      const errSl = slider('Clock error', -8, 8, 0.05, 0, (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} %`, (v) => { slSet.v = v; S.err = v / 100; paint(); });
      const phSl = slider('Start phase', 0, 0.99, 0.01, phase, (v) => `${v.toFixed(2)}`, (v) => { phase = v; paint(); });
      const sel = select('Byte', [['82', "0x52  'R'"], ['85', "0x55  'U'"], ['0', '0x00'], ['255', '0xFF'], ['128', '0x80'], ['127', '0x7F']], '82', (v) => { code = Number(v); paint(); });
      const send = () => {
        if (loop.running) return;
        stage.checkpoint();
        const d = div();
        // the line's bit lasts 16·div·(1 + err) receiver cycles: err > 0 is a receiver clock fast by err
        const f = lineStream([code], 16 * d * (1 + S.err), 3 * d + phase * d);
        q = Array.from({ length: Math.ceil(11 * 16 * d * (1 + S.err)) + 3 * d + 2 }, (_, i) => f(i));
        k = 0; got = -1; pushes = 0; ferrs = 0;
        loop.start();
      };
      const find = () => {
        const t = tolerance(UART_8N1, { ticks: 16, pos: 0.5 }, 2e-4);
        S.found = { fast: t.fast, slow: t.slow };
        S.err = t.fast; errSl.set(100 * t.fast); slSet.v = 100 * t.fast;
        paint();
      };
      const paint = () => {
        const r = receive(UART_8N1, code, { err: S.err, ticks: 16, phase });
        const W = 640, H = 120, L = 10, T = frameUnits(UART_8N1), X = (u: number) => L + (u / (T + 0.4)) * (W - 2 * L);
        const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot uart-wave', role: 'img', 'aria-label': 'A UART frame with the receiver\'s sampling instants' }) as SVGSVGElement;
        for (const g of segments(UART_8N1, code)) {
          svg.append(s('rect', { x: X(g.from), y: g.level ? 22 : 56, width: X(g.to) - X(g.from), height: 4, class: 'uart-seg' }), s('line', { x1: X(g.from), x2: X(g.from), y1: 20, y2: 62, class: 'grid' }),
            s('text', { x: (X(g.from) + X(g.to)) / 2, y: 78, 'text-anchor': 'middle', class: 'tick' }, g.label));
          if (g.from > 0) svg.append(s('line', { x1: X(g.from), x2: X(g.from), y1: g.level === levelAt(UART_8N1, code, g.from - 0.01).level ? 24 : 24, y2: 24, class: 'grid' }));
        }
        const prev = (u: number) => levelAt(UART_8N1, code, u).level;
        let d = `M${X(-0.3)},22`;
        let last: 0 | 1 = 1;
        d += `L${X(0)},22`;
        for (const g of segments(UART_8N1, code)) { if (g.level !== last) d += `L${X(g.from)},${last ? 22 : 56}L${X(g.from)},${g.level ? 22 : 56}`; d += `L${X(g.to)},${g.level ? 22 : 56}`; last = g.level; }
        d += `L${X(T + 0.3)},22`;
        void prev;
        svg.append(s('path', { d, class: 'uart-line' }));
        for (const sm of r.samples) {
          const good = sm.sees === sm.label;
          svg.append(s('line', { x1: X(sm.at), x2: X(sm.at), y1: 14, y2: 66, class: good ? 'uart-smp ok' : 'uart-smp bad' }), s('circle', { cx: X(sm.at), cy: sm.level ? 22 : 56, r: 3.5, class: good ? 'uart-dot ok' : 'uart-dot bad' }));
        }
        svgBox.replaceChildren(svg);
        const got8 = r.word;
        read.className = `clk-verdict ${r.ok ? 'ok' : 'bad'}`;
        read.textContent = r.ok ? `Receiver clock ${S.err > 0 ? '+' : ''}${pct(S.err)}: reads 0x${hex2(got8)} '${chr(got8)}', stop bit 1. Every sample is in its own cell.`
          : `Receiver clock ${S.err > 0 ? '+' : ''}${pct(S.err)}: reads 0x${hex2(got8)} '${chr(got8)}'${r.stopOk ? '' : ', stop bit reads 0: framing error'}. A sample has left its cell.`;
        limit.textContent = S.found ? `Search result: a receiver fast by up to ${pct(S.found.fast)} or slow by up to ${pct(S.found.slow)} reads every one of the 256 codes at three start-edge phases (a continuous clock would allow ${pct(toleranceClosedForm(UART_8N1).fast)} either way). The gates measured ${pct(UART_TOLERANCE.measured[1].senderSlow)} and ${pct(UART_TOLERANCE.measured[1].senderFast)} at divisor 4.` : '';
      };
      const paintLive = () => {
        live.replaceChildren(h('span', null, 'gates: state ', h('b', null, RX_STATE_NAMES[lastState] ?? '?')), h('span', null, 'frames ', h('b', null, String(pushes))), h('span', null, 'framing errors ', h('b', null, String(ferrs))),
          h('span', null, 'byte ', h('b', null, got >= 0 ? `0x${hex2(got)} '${chr(got)}'` : '—')));
        if (!loop.running && (pushes || ferrs)) S.last = { ok: pushes > 0 && got === code, byte: got, err: S.err };
      };
      stage.resetHooks.add(() => { q = []; k = 0; got = -1; pushes = ferrs = 0; paintLive(); });
      stage.historyHooks.add({ save: () => ({ q, k, got, pushes, ferrs }), restore: (v) => { const x = v as { q: number[]; k: number; got: number; pushes: number; ferrs: number }; q = x.q; k = x.k; got = x.got; pushes = x.pushes; ferrs = x.ferrs; paintLive(); } });
      paint(); paintLive();
      const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel', 'data-dock': 'right' }, h('h4', null, 'A receiver whose clock is off', h('span', { class: 'fold-hint' })),
        h('div', { class: 'mc-row' }, sel, btn('Send to the gates', 'Drive rx with this frame from the sender\'s clock and clock the receiver', send, 'btn sm primary'), btn('Find the limit', 'Search for the largest clock error at which every byte is received', find)),
        h('div', { class: 'mc-row' }, errSl.el, phSl.el), svgBox, read, limit, live,
        h('p', { class: 'sub' }, 'Sampling: the receiver sees the start edge at the next tick (phase), counts 8 ticks to the middle of the start bit, then 16 per bit. A clock off by e puts the k-th sample e·(k + ½) bit times from where it should be.'));
      return { el, destroy: () => loop.stop() };
    }],
  };
}

// ---- the core on a bench: errors, overrun, FIFOs -----------------------------------------------------------------------

export interface CoreState { popped: number[]; status: () => number; sent: number; busy: () => boolean }
const coreStates = new WeakMap<Stage, CoreState>();
export const coreState = (st: Stage) => coreStates.get(st);
export interface CoreApi { frame(code: number, stopOk?: boolean): void; glitch(): void; brk(): void; flood(n: number): void; readAll(): void; clear(): void }
const coreApis = new WeakMap<Stage, CoreApi>();
export const coreApi = (st: Stage) => coreApis.get(st);

const BIT = 16;
/** The line levels of one frame at `div` (a bad stop when stopOk is false), then `idle` idle bits. */
const frameLevels = (code: number, div: number, stopOk = true, idle = 2): number[] => {
  const out: number[] = [];
  for (let u = 0; u < 10 + idle; u++) {
    const v = u === 0 ? 0 : u <= 8 ? (code >> (u - 1)) & 1 : u === 9 ? (stopOk ? 1 : 0) : 1;
    for (let i = 0; i < BIT * div; i++) out.push(v);
  }
  return out;
};

export function coreScene(): Scene {
  return {
    root: UART_CORE, inputs: { rx: 1, push: 0, data: 0, pop: 0, divWe: 0, ieWe: 0, clrWe: 0, wval: 0, clk: 0 },
    hiddenInputs: ['rx', 'push', 'data', 'pop', 'divWe', 'ieWe', 'clrWe', 'wval'], autoClock: false,
    panels: [(stage: Stage): Widget => {
      const DIV = 1;
      let q: number[] = [], k = 0, popPending = 0, clearPending = false, init = false, hist: number[] = [];
      const popped: number[] = [];
      const lamps = h('div', { class: 'uart-lamps' }), log = h('div', { class: 'mc-status' }), strip = h('div', { class: 'uart-svg' });
      const st = () => outp(stage, 'status');
      const api: CoreApi = {
        frame: (c, ok = true) => { q = q.slice(k).concat(frameLevels(c, DIV, ok)); k = 0; loop.start(); },
        glitch: () => { q = q.slice(k).concat([...Array(2 * DIV).fill(0), ...Array(BIT * DIV * 3).fill(1)]); k = 0; loop.start(); },
        brk: () => { q = q.slice(k).concat([...Array(12 * BIT * DIV).fill(0), ...Array(BIT * DIV * 2).fill(1)]); k = 0; loop.start(); },
        flood: (n) => { let a: number[] = []; for (let i = 0; i < n; i++) a = a.concat(frameLevels(0x41 + i, DIV, true, 0)); q = q.slice(k).concat(a, Array(BIT * DIV).fill(1)); k = 0; loop.start(); },
        readAll: () => { popPending = 16; loop.start(); },
        clear: () => { clearPending = true; loop.start(); },
      };
      const step = () => {
        const sim = stage.sim!;
        const first = !init;
        sim.setInput('divWe', first ? 1 : 0); sim.setInput('wval', first ? DIV : clearPending ? 0x18 : 0); sim.setInput('clrWe', clearPending ? 1 : 0);
        init = true; clearPending = false;
        const lvl = k < q.length ? q[k] : 1; k++;
        sim.setInput('rx', lvl);
        let doPop = 0;
        if (popPending > 0 && (st() & ST_RXNE)) { doPop = 1; popped.push(outp(stage, 'rxData')); popPending--; } else if (popPending > 0) popPending = 0;
        sim.setInput('pop', doPop);
        pulse(stage, 'clk');
        hist.push(lvl); if (hist.length > 640) hist = hist.slice(-640);
        return k < q.length || popPending > 0 || clearPending;
      };
      const loop = new Loop(stage, step, () => paint(), 40, 30);
      stage.resetHooks.add(() => { q = []; k = 0; init = false; popped.length = 0; hist = []; paint(); });
      stage.historyHooks.add({ save: () => ({ q, k, init, popped: [...popped], hist }), restore: (v) => { const x = v as { q: number[]; k: number; init: boolean; popped: number[]; hist: number[] }; q = x.q; k = x.k; init = x.init; popped.length = 0; popped.push(...x.popped); hist = x.hist; paint(); } });
      coreStates.set(stage, { popped, status: st, sent: 0, busy: () => loop.running });
      coreApis.set(stage, api);
      const lamp = (on: boolean, label: string, bad = false) => h('span', { class: `uart-lamp${on ? ' on' : ''}${bad && on ? ' bad' : ''}` }, label);
      const paint = () => {
        const v = st();
        lamps.replaceChildren(lamp(!!(v & ST_RXNE), 'rx not empty'), lamp(!!(v & ST_TXFULL), 'tx full'), lamp(!!(v & ST_TXIDLE), 'tx idle'), lamp(!!(v & ST_FRAMING), 'framing error', true), lamp(!!(v & ST_OVERRUN), 'overrun', true));
        log.replaceChildren(h('span', null, 'status ', h('b', null, `0x${hex2(v)}`)), h('span', null, 'read so far ', h('b', null, popped.length ? popped.map((b) => `${hex2(b)}'${chr(b)}'`).join(' ') : '—')));
        strip.replaceChildren(waveSvg(hist, 640, -1, 1, [], 'The rx line over the last 640 cycles'));
      };
      paint();
      const b = (label: string, title: string, f: () => void) => btn(label, title, () => { if (!loop.running) f(); });
      const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel', 'data-dock': 'right' }, h('h4', null, 'What arrives, and what the status says', h('span', { class: 'fold-hint' })),
        h('div', { class: 'dram-ops' }, b('Good frame', "Send 'A' with a proper stop bit", () => api.frame(0x41)), b('Bad stop bit', 'Send a frame whose stop bit is 0', () => api.frame(0x42, false)), b('Glitch', 'A 2-cycle low pulse on an idle line', api.glitch),
          b('Break', 'Hold the line low for 12 bit times', api.brk), b('Send 20', '20 good frames; nothing reads them', () => api.flood(20)), b('Read all', 'Pop the receive FIFO until empty', api.readAll), b('Clear flags', 'Write 1 to the framing-error and overrun bits', api.clear)),
        lamps, log, strip, h('p', { class: 'sub' }, 'Divisor 1: a bit is 16 cycles. The panel plays the sender and the driver; the circuit is the one you can open.'));
      return { el, update: paint, destroy: () => loop.stop() };
    }],
  };
}

// ---- the baud table ----------------------------------------------------------------------------------------------------

const CLOCKS: [number, string][] = [[1.8432e6, '1.8432 MHz'], [3.6864e6, '3.6864 MHz'], [12e6, '12 MHz'], [16e6, '16 MHz'], [25e6, '25 MHz'], [27e6, '27 MHz'], [50e6, '50 MHz'], [100e6, '100 MHz']];
const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 921600, 3e6];

export function baudWidget(): Widget {
  let ci = 4;
  const tbl = h('div', { class: 'scroll' }), note = h('p', { class: 'sub' });
  const paint = () => {
    const f = CLOCKS[ci][0], th = h('tr', null, h('th', null, 'baud'), h('th', null, 'divisor'), h('th', null, 'actual'), h('th', null, 'error'), h('th', null, 'byte'));
    const rows = BAUDS.map((b) => {
      const r = divisorFor(f, b), cls = Math.abs(r.error) < 0.02 ? 'good' : Math.abs(r.error) < 0.035 ? 'warn' : 'bad';
      return h('tr', null, h('td', null, String(b)), h('td', { class: 'num' }, r.div < 2 && f / 16 < b * 0.9 ? 'too fast' : String(r.div)), h('td', { class: 'num' }, r.div < 2 && f / 16 < b * 0.9 ? '—' : `${r.actual.toFixed(0)}`),
        h('td', { class: `num uart-${cls}` }, f / 16 < b * 0.9 ? '—' : pct(r.error)), h('td', { class: 'num' }, `${(1e6 / bytesPerSecond(r.actual)).toFixed(1)} µs`));
    });
    tbl.replaceChildren(h('table', { class: 'uart-tbl' }, h('thead', null, th), h('tbody', null, ...rows)));
    note.textContent = `${CLOCKS[ci][1]} / 16 = ${(f / 16 / 1e6).toFixed(4)} Mbaud is the fastest rate this clock can make (divisor 1). Two ends can each be off by about ${pct(UART_TOLERANCE.predicted.senderFast / 2, 1)} before their sum reaches the receiver's ±${pct(UART_TOLERANCE.predicted.senderFast, 1)}. Green: under 2 %, amber: under 3.5 %.`;
  };
  const sel = select('System clock', CLOCKS.map(([, n], i) => [String(i), n]), String(ci), (v) => { ci = Number(v); paint(); });
  paint();
  return { el: h('div', { class: 'widget mos clk-w' }, h('div', { class: 'panel' }, h('h3', null, 'A divisor for a bit rate'), h('div', { class: 'mc-row' }, h('label', { class: 'mos-sl' }, h('span', null, 'Clock'), sel)), tbl, note)) };
}

// ---- the FIFO budget ---------------------------------------------------------------------------------------------------

export function fifoWidget(): Widget {
  let baud = 115200, depth = 16, level = 8, mhz = 100;
  const out = h('div', { class: 'mc-status' }), tbl = h('div', { class: 'scroll' }), note = h('p', { class: 'sub' });
  const service = UART_COSTS.handlerPerByte + 10; // handler plus entry and exit
  const paint = () => {
    const f = fifoBudget(baud, depth, level), cyc = (us: number) => Math.round(us * mhz);
    out.replaceChildren(h('span', null, 'byte ', h('b', null, `${(10e6 / baud).toFixed(1)} µs`)), h('span', null, 'time to fill ', h('b', null, `${f.fillUs.toFixed(0)} µs`)), h('span', null, 'slack after the interrupt ', h('b', null, `${f.slackUs.toFixed(0)} µs = ${cyc(f.slackUs).toLocaleString('en')} cycles`)),
      h('span', null, 'interrupts ', h('b', null, `${f.irqPerSecond.toFixed(0)} / s`)), h('span', null, 'CPU in the handler ', h('b', null, pct((f.irqPerSecond * level * service) / (mhz * 1e6), 2))));
    const rows = [9600, 115200, 921600, 3e6].map((b) => {
      const g = fifoBudget(b, 16, 1), g8 = fifoBudget(b, 16, 8);
      return h('tr', null, h('td', null, String(b)), h('td', { class: 'num' }, `${g.irqPerSecond.toFixed(0)}`), h('td', { class: 'num' }, `${g8.irqPerSecond.toFixed(0)}`), h('td', { class: 'num' }, `${g8.slackUs.toFixed(0)} µs`));
    });
    tbl.replaceChildren(h('table', { class: 'uart-tbl' }, h('thead', null, h('tr', null, h('th', null, 'baud'), h('th', null, 'IRQ/s, level 1'), h('th', null, 'IRQ/s, level 8'), h('th', null, 'slack, level 8'))), h('tbody', null, ...rows)));
    note.textContent = `Handler cost per byte: ${service} cycles (${UART_COSTS.handlerPerByte} measured on the gates plus an assumed 10 for entry and exit). The receive interrupt fires when the FIFO holds ${level} of ${depth} bytes; the CPU then has ${depth - level} more byte times before the next byte is lost.`;
  };
  const bSel = select('Bit rate', [9600, 115200, 921600, 3e6].map((b) => [String(b), `${b} baud`]), String(baud), (v) => { baud = Number(v); paint(); });
  const dSl = slider('FIFO depth', 2, FIFO_DEPTH, 1, depth, (v) => `${v}`, (v) => { depth = v; level = Math.min(level, v); lSl.set(level); paint(); });
  const lSl = slider('Interrupt at', 1, FIFO_DEPTH, 1, level, (v) => `${v} bytes`, (v) => { level = Math.min(v, depth); paint(); });
  const cSl = slider('CPU clock', 1, 200, 1, mhz, (v) => `${v} MHz`, (v) => { mhz = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos clk-w' }, h('div', { class: 'panel' }, h('h3', null, 'How deep, at what rate'), h('div', { class: 'mc-row' }, h('label', { class: 'mos-sl' }, h('span', null, 'Rate'), bSel), dSl.el, lSl.el, cSl.el), out, note, tbl)) };
}

// ---- a UART on the bus -------------------------------------------------------------------------------------------------

const UART_DIV_IN_PROGRAM = 2;
const ROM_K = 8;

interface BusUartApi { send(text: string): void; console(): string; cycles(): number }
const busApis = new WeakMap<Stage, BusUartApi>();
export const busUartApi = (st: Stage) => busApis.get(st);

/** Shared by the bus scene and the two-computer scene: the register table of a UART node. */
function regsRow(stage: Stage, path: string[]): HTMLElement {
  const c = [...path, 'core'], v = outAt(stage, c, 'status'), div = outAt(stage, c, 'div'), ie = outAt(stage, c, 'ie');
  return h('div', { class: 'mc-status' }, h('span', null, 'status ', h('b', null, `0x${hex2(Math.max(0, v))}`), ` rxne ${v & 1} full ${(v >> 1) & 1} idle ${(v >> 2) & 1} fe ${(v >> 3) & 1} ovr ${(v >> 4) & 1}`),
    h('span', null, 'divisor ', h('b', null, String(div))), h('span', null, 'irq enable ', h('b', null, String(ie))), h('span', null, 'irq ', h('b', null, String(outAt(stage, path, 'irq')))));
}

export function uartBusScene(): Scene {
  return {
    root: busComputer(words(uartIrqSource(UART_DIV_IN_PROGRAM)), [0], { imemK: ROM_K, ramK: 8, uart: true }),
    inputs: { clk: 0, switches: 0, uartRx: 1 }, hiddenInputs: ['switches', 'uartRx'], autoClock: false, engine: 'cycle',
    panels: [(stage: Stage): Widget => {
      let q: number[] = [], k = 0, consoleText = '', cycles = 0, txHist: number[] = [], rxHist: number[] = [];
      const consoleEl = h('pre', { class: 'uart-console', 'aria-label': 'Console' }), regs = h('div'), strip = h('div', { class: 'uart-svg' });
      const input = h('input', { type: 'text', value: 'Hello', maxlength: 24, 'aria-label': 'Text to send into the rx pin', class: 'uart-text' }) as HTMLInputElement;
      const div = () => Math.max(1, outAt(stage, ['uart', 'core'], 'div'));
      const before = () => { stage.sim!.setInput('uartRx', k < q.length ? q[k] : 1); k++; if (outp(stage, 'consoleValid') === 1) consoleText += String.fromCharCode(outp(stage, 'consoleData')); };
      const after = () => { cycles++; txHist.push(outp(stage, 'uartTx')); rxHist.push(k <= q.length ? q[k - 1] : 1); if (txHist.length > 600) { txHist = txHist.slice(-600); rxHist = rxHist.slice(-600); } };
      const hook = { before, after: () => { after(); paint(); } };
      stage.edgeHooks.add(hook);
      const loop = new Loop(stage, () => { before(); pulse(stage, 'clk'); after(); return true; }, () => paint(), 60, 30);
      const send = (text: string) => {
        const d = div(), bytes = [...text].map((c) => c.charCodeAt(0) & 127);
        const f = lineStream(bytes, 16 * d, 0, 1);
        q = q.slice(k).concat(Array.from({ length: bytes.length * 11 * 16 * d + 2 }, (_, i) => f(i))); k = 0;
        if (!loop.running) loop.start();
      };
      busApis.set(stage, { send, console: () => consoleText, cycles: () => cycles });
      const paint = () => {
        consoleEl.textContent = consoleText || ' ';
        regs.replaceChildren(regsRow(stage, ['uart']), h('div', { class: 'mc-status' }, h('span', null, 'cycles ', h('b', null, String(cycles))), h('span', null, 'a bit is ', h('b', null, `${16 * div()} cycles`)), h('span', null, 'retired ', h('b', null, String(outp(stage, 'retire'))))));
        strip.replaceChildren(waveSvg(rxHist, 600, -1, 1, [], 'rx pin over the last 600 cycles'), waveSvg(txHist, 600, -1, 1, [], 'tx pin over the last 600 cycles'));
      };
      stage.resetHooks.add(() => { q = []; k = 0; consoleText = ''; cycles = 0; txHist = []; rxHist = []; paint(); });
      stage.historyHooks.add({ save: () => ({ q, k, consoleText, cycles, txHist: [...txHist], rxHist: [...rxHist] }), restore: (v) => { const x = v as { q: number[]; k: number; consoleText: string; cycles: number; txHist: number[]; rxHist: number[] }; q = x.q; k = x.k; consoleText = x.consoleText; cycles = x.cycles; txHist = x.txHist; rxHist = x.rxHist; paint(); } });
      paint();
      const run = btn('Run', 'Clock the computer continuously', () => { if (loop.running) { loop.stop(); run.textContent = 'Run'; } else { loop.start(); run.textContent = 'Pause'; } }, 'btn sm primary');
      const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel', 'data-dock': 'right' }, h('h4', null, 'A computer with a UART', h('span', { class: 'fold-hint' })),
        h('div', { class: 'mc-row' }, run, input, btn('Send to rx', 'Feed these bytes to the rx pin at the divisor\'s rate', () => send(input.value))),
        regs, h('div', { class: 'cpu-sec' }, 'Console'), consoleEl, h('div', { class: 'cpu-sec' }, 'rx pin, then tx pin'), strip,
        h('p', { class: 'sub' }, 'The program sets the divisor, sends "Hi", enables the receive interrupt and counts in a loop; the handler echoes each byte to the console.'));
      return { el, update: paint, destroy: () => { loop.stop(); stage.edgeHooks.delete(hook); } };
    }],
  };
}

// ---- two computers on a wire -------------------------------------------------------------------------------------------

export interface TwoApi { run(): void; type(side: 'A' | 'B', text: string): void; consoleOf(side: 'A' | 'B'): string; setRatio(r: number): void; edges(): [number, number]; glitch(): void }
const twoApis = new WeakMap<Stage, TwoApi>();
export const twoApi = (st: Stage) => twoApis.get(st);

/** Chat program divisor for the two-computer scene: a bit is 16 · TWO_DIV cycles. */
export const TWO_DIV = 2;

export function twoScene(): Scene {
  const A = words(uartChatSource(TWO_DIV, false)), B = words(uartChatSource(TWO_DIV, true));
  return {
    root: twoComputers(A, B), inputs: { clkA: 0, clkB: 0, noiseAB: 0, noiseBA: 0 }, hiddenInputs: ['noiseAB', 'noiseBA', 'clkB'], clock: 'clkA', autoClock: false, engine: 'cycle',
    panels: [(stage: Stage): Widget => {
      let ratio = 1, tA = 1, tB = 1, eA = 0, eB = 0;
      const text = { A: '', B: '' };
      let lineAB: number[] = [], lineBA: number[] = [];
      const cons = { A: h('pre', { class: 'uart-console', 'aria-label': 'Console A' }), B: h('pre', { class: 'uart-console', 'aria-label': 'Console B' }) };
      const strip = h('div', { class: 'uart-svg' }), read = h('div', { class: 'mc-status' });
      const kbd = (side: 'A' | 'B') => findNode(stage.sim!.design.root, [side === 'A' ? 'a' : 'b', 'kbd']);
      const type = (side: 'A' | 'B', t: string) => {
        const n = kbd(side); if (!n) return;
        const cur = stage.sim!.leafState(n.leafIndex!) as { q: number[]; clk: number; ack: number };
        stage.sim!.poke(n.leafIndex!, { ...cur, q: [...cur.q, ...[...t].map((c) => c.charCodeAt(0) & 127)].slice(0, 16) });
        stage.sim!.settle();
      };
      let glitchLeft = 0;
      const edge = () => {
        const sim = stage.sim!, a = tA <= tB, S = a ? 'A' : 'B', clk = a ? 'clkA' : 'clkB';
        if (outp(stage, `consoleValid${S}`) === 1) text[S] += String.fromCharCode(outp(stage, `consoleData${S}`));
        sim.setInput(a ? 'noiseAB' : 'noiseBA', glitchLeft > 0 ? 1 : 0);
        if (glitchLeft > 0 && a) glitchLeft--;
        pulse(stage, clk);
        if (a) { tA += 1; eA++; } else { tB += 1 / ratio; eB++; }
        lineAB.push(outp(stage, 'lineAB')); lineBA.push(outp(stage, 'lineBA'));
        if (lineAB.length > 480) { lineAB = lineAB.slice(-480); lineBA = lineBA.slice(-480); }
      };
      const loop = new Loop(stage, () => { edge(); return true; }, () => paint(), 24, 30);
      const api: TwoApi = { run: () => { if (!loop.running) { loop.start(); run.textContent = 'Pause'; } }, type, consoleOf: (side) => text[side], setRatio: (r) => { ratio = r; }, edges: () => [eA, eB], glitch: () => { glitchLeft = 6; } };
      twoApis.set(stage, api);
      const paint = () => {
        cons.A.textContent = text.A || ' '; cons.B.textContent = text.B || ' ';
        read.replaceChildren(h('span', null, 'A edges ', h('b', null, String(eA))), h('span', null, 'B edges ', h('b', null, String(eB))), h('span', null, 'B clock / A clock ', h('b', null, ratio.toFixed(3))), h('span', null, 'bit ', h('b', null, `${16 * TWO_DIV} A-cycles`)));
        strip.replaceChildren(waveSvg(lineAB, 480, -1, 1, [], 'The wire from A to B'), waveSvg(lineBA, 480, -1, 1, [], 'The wire from B to A'));
      };
      stage.resetHooks.add(() => { tA = tB = 1; eA = eB = 0; text.A = text.B = ''; lineAB = []; lineBA = []; paint(); });
      stage.historyHooks.add({ save: () => ({ tA, tB, eA, eB, ta: text.A, tb: text.B, lineAB: [...lineAB], lineBA: [...lineBA], ratio }), restore: (v) => { const x = v as { tA: number; tB: number; eA: number; eB: number; ta: string; tb: string; lineAB: number[]; lineBA: number[]; ratio: number }; tA = x.tA; tB = x.tB; eA = x.eA; eB = x.eB; text.A = x.ta; text.B = x.tb; lineAB = x.lineAB; lineBA = x.lineBA; ratio = x.ratio; paint(); } });
      const field = (side: 'A' | 'B') => {
        const inp = h('input', { type: 'text', maxlength: 16, placeholder: `type on ${side}`, 'aria-label': `Type on computer ${side}`, class: 'uart-text' }) as HTMLInputElement;
        const go = () => { if (inp.value) { type(side, inp.value); inp.value = ''; if (!loop.running) { loop.start(); run.textContent = 'Pause'; } } };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        return h('div', { class: 'mc-row' }, inp, btn(`Send from ${side}`, `Put the text in computer ${side}'s keyboard queue`, go));
      };
      const rSl = slider('Clock B vs A', -10, 10, 0.5, 0, (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} %`, (v) => { ratio = 1 + v / 100; paint(); });
      const run = btn('Run', 'Clock both computers, each at its own rate', () => { if (loop.running) { loop.stop(); run.textContent = 'Run'; } else { loop.start(); run.textContent = 'Pause'; } }, 'btn sm primary');
      const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel uart-two', 'data-dock': 'right' }, h('h4', null, 'Two computers chatting', h('span', { class: 'fold-hint' })),
        h('div', { class: 'mc-row' }, run, btn('Glitch A→B', 'Flip the wire from A to B for six A cycles', () => api.glitch())), rSl.el,
        field('A'), field('B'), h('div', { class: 'uart-cons2' }, h('div', null, h('div', { class: 'cpu-sec' }, 'Console A (what B sent)'), cons.A), h('div', null, h('div', { class: 'cpu-sec' }, 'Console B (what A sent)'), cons.B)),
        h('div', { class: 'cpu-sec' }, 'The wires, last 480 edges: A → B, B → A'), strip, read);
      paint();
      return { el, update: paint, destroy: () => loop.stop() };
    }],
  };
}

// ---- the frame --------------------------------------------------------------------------------------------------------

export function frameWidget(): Widget {
  let code = 0x52;
  const box = h('div', { class: 'uart-svg' }), read = h('div', { class: 'mc-status' });
  const paint = () => {
    const unit = 20, levels: number[] = [];
    for (let i = 0; i < 12 * unit; i++) levels.push(i < unit || i >= 11 * unit ? 1 : levelAt(UART_8N1, code, (i - unit) / unit).level);
    const svg = waveSvg(levels, 12 * unit, unit, unit, ['start', ...Array.from({ length: 8 }, (_, i) => `d${i}`), 'stop'], 'A UART frame: idle, start, eight data bits least significant first, stop, idle');
    box.replaceChildren(svg);
    const bits = segments(UART_8N1, code).map((g) => g.level);
    read.replaceChildren(h('span', null, 'byte ', h('b', null, `0x${hex2(code)} ${chr(code)}`)), h('span', null, 'on the line ', h('b', null, bits.join(' '))), h('span', null, 'bits per byte ', h('b', null, '10')), h('span', null, 'payload ', h('b', null, '80 %')));
  };
  const sel = select('Byte', [['82', "0x52  'R'"], ['85', "0x55  'U'"], ['0', '0x00'], ['255', '0xFF'], ['10', '0x0A  newline']], '82', (v) => { code = Number(v); paint(); });
  paint();
  return { el: h('div', { class: 'widget mos clk-w' }, h('div', { class: 'panel' }, h('h3', null, 'One byte on one wire'), h('div', { class: 'mc-row' }, h('label', { class: 'mos-sl' }, h('span', null, 'Byte'), sel)), box, read,
    h('p', { class: 'sub' }, 'Idle is 1. The falling edge of the start bit is the only synchronization: from it, the receiver looks at the line once per bit.'))) };
}

/** NAND count of the two-computer scene's circuit (its line parts cost nothing). */
export function twoComputersNands(): number {
  const sc = twoScene();
  return stats(sc.root).nands;
}
