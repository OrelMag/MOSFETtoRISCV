// Chapter 24's explorers, all computed: the dataflow limit of a trace (riscv/ilp.ts), in-order against out-of-order
// timelines, the reorder-buffer explorer and the speculation table (riscv/ooomodel.ts, the gate-level core's
// reference), and the CDC 6600 scoreboard (riscv/scoreboard.ts).

import { assemble } from '../riscv/asm';
import { BENCHMARKS } from '../riscv/benchprograms';
import { criticalPath, dataflow, LAT, latencyOf, traceOf, type Latencies, type TraceEntry } from '../riscv/ilp';
import { ABI } from '../riscv/isa';
import { OooModel, OOO_CORE, type OooConfig, type Uop } from '../riscv/ooomodel';
import { OOO_PROGRAMS, SCOREBOARD_SOURCE } from '../riscv/oooprograms';
import { Scoreboard } from '../riscv/scoreboard';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import '../styles/ooo.css';

const OPTS = { dmemWords: 64, imemWords: 128 };

interface Prog { id: string; name: string; blurb: string; words: number[] }
const progCache = new Map<string, Prog>();
/** The chapter's loops first, then the benchmark set (RV32IM). */
export function oooProgram(id: string): Prog {
  let p = progCache.get(id);
  if (!p) {
    const o = OOO_PROGRAMS.find((x) => x.id === id), b = BENCHMARKS.find((x) => x.id === id)!;
    const src = o ? o.source : b.source;
    p = { id, name: o?.name ?? b.name, blurb: o?.blurb ?? b.blurb, words: assemble(src).words };
    progCache.set(id, p);
  }
  return p;
}
const PROG_IDS = [...OOO_PROGRAMS.map((p) => p.id), ...BENCHMARKS.filter((b) => !b.needs?.f).map((b) => b.id)];

function seg<T extends string | number>(opts: [T, string][], get: () => T, set: (v: T) => void, label: string) {
  const g = h('span', { class: 'seg', role: 'group', 'aria-label': label });
  const btns = opts.map(([v, l]) => {
    const b = h('button', { type: 'button' }, l);
    b.addEventListener('click', () => set(v));
    g.append(b);
    return [v, b] as const;
  });
  return { el: g, sync: () => btns.forEach(([v, b]) => { b.classList.toggle('on', v === get()); b.setAttribute('aria-pressed', String(v === get())); }) };
}

function picker(ids: string[], get: () => string, set: (id: string) => void): HTMLSelectElement {
  const sel = h('select', { class: 'ooo-sel', 'aria-label': 'Program' }) as HTMLSelectElement;
  for (const id of ids) sel.append(h('option', { value: id }, oooProgram(id).name));
  sel.value = get();
  sel.addEventListener('change', () => set(sel.value));
  return sel;
}

const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls, title, type: 'button' }, label); b.addEventListener('click', f); return b; };
const fix = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const LONG: Latencies = { alu: 1, load: 4, mul: 4, div: 19 };

// ---------------------------------------------------------------------------------------------------------------
// Step: how much parallelism is there? The dataflow schedule of a window of the trace.

export function dataflowWidget(): Widget {
  let id = 'dot', from = 0, lat: Latencies = LAT;
  const WIN = 18;
  let trace: TraceEntry[] = [];
  const sum = h('div', { class: 'ooo-sum' });
  const fig = h('div', { class: 'ooo-df scroll' });
  const slider = h('input', { type: 'range', min: 0, max: 0, value: 0, 'aria-label': 'Window position' }) as HTMLInputElement;
  const pos = h('span', { class: 'ooo-pos' });
  const load = () => { trace = traceOf(oooProgram(id).words, OPTS); slider.max = String(Math.max(0, trace.length - WIN)); from = Math.min(from, Number(slider.max)); slider.value = String(from); update(); };
  slider.addEventListener('input', () => { from = Number(slider.value); update(); });
  const update = () => {
    for (const g of segs) g.sync();
    const df = dataflow(trace, lat);
    const end = Math.min(trace.length, from + WIN);
    const crit = new Set(criticalPath(df, from, end));
    const starts = trace.map((t, i) => df.ready[i] - Math.max(1, latencyOf(t.cls, lat)));
    let lo = Infinity, hi = 0;
    for (let i = from; i < end; i++) { lo = Math.min(lo, starts[i]); hi = Math.max(hi, df.ready[i]); }
    const span = hi - lo, cw = Math.max(10, Math.min(34, 520 / Math.max(1, span))), rh = 20, lw = 170;
    const W = lw + span * cw + 16, H = (end - from) * rh + 26;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ooo-df-svg', role: 'img', 'aria-label': 'Dataflow schedule of the window' });
    for (let c = 0; c <= span; c++) {
      svg.append(s('line', { x1: lw + c * cw, x2: lw + c * cw, y1: 14, y2: H, class: 'g' }));
      if (span <= 40 || c % 5 === 0) svg.append(s('text', { x: lw + c * cw + 2, y: 10, class: 'ax' }, String(c)));
    }
    const y = (i: number) => 18 + (i - from) * rh;
    for (let i = from; i < end; i++) {
      const t = trace[i];
      svg.append(s('text', { x: 0, y: y(i) + 12, class: `ins${crit.has(i) ? ' crit' : ''}` }, t.text.length > 24 ? t.text.slice(0, 23) + '…' : t.text));
      const x0 = lw + (starts[i] - lo) * cw, x1 = lw + (df.ready[i] - lo) * cw;
      svg.append(s('rect', { x: x0 + 1, y: y(i) + 2, width: Math.max(4, x1 - x0 - 2), height: rh - 6, rx: 3, class: `bar ${t.cls}${crit.has(i) ? ' crit' : ''}` },
        s('title', null, `${t.text}: starts at ${starts[i] - lo}, result at ${df.ready[i] - lo}`)));
    }
    // Edges from each producer in the window to its consumers.
    const lastWriter = new Map<number, number>();
    for (let i = from; i < end; i++) {
      const t = trace[i];
      for (const r of t.srcs) {
        const p = lastWriter.get(r);
        if (p === undefined) continue;
        const xa = lw + (df.ready[p] - lo) * cw - 1, ya = y(p) + rh / 2 - 1, xb = lw + (starts[i] - lo) * cw + 1, yb = y(i) + rh / 2 - 1;
        svg.append(s('path', { d: `M${xa} ${ya} C${xa + 10} ${ya} ${xb - 10} ${yb} ${xb} ${yb}`, class: `edge${crit.has(p) && crit.has(i) ? ' crit' : ''}` }));
      }
      if (t.rd) lastWriter.set(t.rd, i);
    }
    fig.replaceChildren(svg);
    pos.textContent = `instructions ${from + 1}–${end} of ${trace.length}`;
    sum.replaceChildren(
      h('span', null, 'Whole program'), h('b', null, `${trace.length} instructions, longest chain ${df.path} cycles`),
      h('span', null, 'Ceiling'), h('b', null, `IPC ${fix(df.ipc)} (CPI ${fix(1 / df.ipc)}), with unlimited width, window and perfect prediction`),
      h('span', null, 'This window'), h('b', null, `${end - from} instructions in ${span} cycles`));
  };
  const segs = [seg<string>([['ours', 'Our latencies (load 2, mul 2)'], ['long', 'Load and mul 4']], () => (lat === LAT ? 'ours' : 'long'), (v) => { lat = v === 'ours' ? LAT : LONG; update(); }, 'Latencies')];
  const el = h('div', { class: 'widget ooo-widget' },
    h('div', { class: 'rb-ctl' }, picker(PROG_IDS, () => id, (v) => { id = v; from = 0; load(); }), ...segs.map((g) => g.el)),
    h('p', { class: 'sub' }, 'Each instruction starts the cycle its last operand is ready and takes its latency. Lines are register dependences; the longest chain in the window is lit. Nothing else holds anything back.'),
    sum, h('div', { class: 'ooo-slide' }, slider, pos), fig);
  load();
  return { el };
}

// ---------------------------------------------------------------------------------------------------------------
// A timeline of instructions: dispatch, waiting, issue, execution, done, commit (and flushed ones).

export function timeline(uops: Uop[], c0: number, c1: number): HTMLElement {
  const n = c1 - c0 + 1;
  const head = h('tr', null, h('th', null, ''), ...Array.from({ length: n }, (_, i) => h('th', { class: 'c' }, String(c0 + i))));
  const rows = uops.map((u) => {
    const cells: HTMLElement[] = [];
    for (let cy = c0; cy <= c1; cy++) {
      let cls = '', txt = '';
      const end = u.c >= 0 ? u.c : Infinity;
      if (cy === u.f) { cls = 'f'; txt = 'F'; }
      else if (cy === u.d) { cls = 'd'; txt = 'D'; }
      else if (u.state === 'flushed' && cy === u.c) { cls = 'k'; txt = '✕'; }
      else if (u.s >= 0 && cy === u.s) { cls = 'i'; txt = 'I'; }
      else if (u.s >= 0 && cy > u.s && (u.x < 0 || cy <= u.x) && cy < end) { cls = 'x'; txt = 'X'; }
      else if (u.d >= 0 && cy > u.d && (u.s < 0 ? u.x < 0 || cy < u.x : cy < u.s) && cy < end && u.cls !== 'jal' && u.cls !== 'lui') cls = 'w';
      else if (u.f >= 0 && cy > u.f && (u.d < 0 || cy < u.d) && cy < end) cls = 'q';
      else if (u.x >= 0 && cy > u.x && cy < end) cls = 'r';
      else if (cy === u.c && u.state === 'committed') { cls = 'c'; txt = 'C'; }
      cells.push(h('td', { class: 'c' }, cls ? h('span', { class: cls }, txt) : ''));
    }
    return h('tr', { class: u.state === 'flushed' ? 'gone' : u.wrong ? 'wrong' : '' }, h('td', { class: 'ins' }, u.text), ...cells);
  });
  return h('div', { class: 'scroll' }, h('table', { class: 'ooo-tl' }, h('thead', null, head), h('tbody', null, ...rows)));
}

export const legend = () => h('div', { class: 'rb-legend ooo-legend' },
  ...([['f', 'F', 'fetched'], ['q', '', 'waiting to dispatch'], ['d', 'D', 'dispatched (renamed)'], ['w', '', 'waiting for an operand or a port'], ['i', 'I', 'picked'], ['x', 'X', 'executing; result at the last'], ['r', '', 'done, waiting to commit'], ['c', 'C', 'committed'], ['k', '✕', 'flushed']] as const)
    .map(([c, t, l]) => h('span', null, h('i', { class: `ooo-k ${c}` }, t), l)));

function runModel(words: number[], cfg: Partial<OooConfig>, maxCycles = 50_000): OooModel {
  const m = new OooModel(words, cfg, OPTS);
  m.historyMax = 1e9;
  m.run(maxCycles);
  return m;
}

/** Committed instructions k … k + n − 1 of a run, and the cycles they span. */
function window(m: OooModel, k: number, n: number): { uops: Uop[]; c0: number; c1: number } {
  const done = m.history.filter((u) => u.state === 'committed');
  const uops = done.slice(k, k + n);
  if (!uops.length) return { uops, c0: 0, c1: 0 };
  return { uops, c0: Math.min(...uops.map((u) => u.f)), c1: Math.max(...uops.map((u) => u.c)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Step: where in-order stops. The same 2-wide machine issuing in order and out of order.

export function orderWidget(): Widget {
  let id = 'dot', lat: Latencies = LAT, start = 12;
  const N = 14;
  const out = h('div', null);
  const update = () => {
    for (const g of segs) g.sync();
    const words = oooProgram(id).words;
    const runs = ([['In order', { inorder: true }], ['Out of order', {}]] as const).map(([name, cfg]) => [name, runModel(words, { ...cfg, lat })] as const);
    out.replaceChildren(...runs.map(([name, m]) => {
      const w = window(m, start, N);
      return h('div', { class: 'ooo-run' },
        h('div', { class: 'cpu-sec' }, `${name}: ${m.stats.cycles} cycles for ${m.stats.instructions} instructions, CPI ${fix(m.stats.cycles / m.stats.instructions)}`),
        timeline(w.uops, w.c0, w.c1));
    }), legend());
  };
  const segs = [
    seg<string>([['dot', 'Dot product'], ['chains', 'Two chains']], () => id, (v) => { id = v; update(); }, 'Program'),
    seg<number>([[2, 'Load 2, mul 2'], [4, 'Load 4, mul 4'], [6, 'Load 6, mul 6']], () => lat.load, (v) => { lat = { alu: 1, load: v, mul: v, div: LAT.div }; update(); }, 'Latencies'),
    seg<number>([[0, 'From the start'], [12, 'Second element'], [28, 'Fourth element']], () => start, (v) => { start = v; update(); }, 'Window'),
  ];
  const el = h('div', { class: 'widget ooo-widget' }, h('div', { class: 'rb-ctl' }, ...segs.map((g) => g.el)),
    h('p', { class: 'sub' }, 'Both machines fetch, dispatch, issue and commit two instructions a cycle and predict branches the same way. The only difference: the first may pick an instruction only when every older one has been picked.'),
    out);
  update();
  return { el };
}

// ---------------------------------------------------------------------------------------------------------------
// Step: the scoreboard.

export function scoreboardWidget(): Widget {
  let which: 'hp' | 'names' = 'hp', lat: 'ours' | 'hp' = 'hp', cycle = 13; // opens where the add has issued and the divide waits
  const HP_LAT: Latencies = { alu: 2, load: 1, mul: 10, div: 40 };
  const words = () => assemble(which === 'hp' ? SCOREBOARD_SOURCE : OOO_PROGRAMS.find((p) => p.id === 'names')!.source.split('\nhalt')[0]).words;
  const make = () => { const sb = new Scoreboard(words(), lat === 'hp' ? HP_LAT : LAT); for (let i = 0; i < cycle; i++) sb.step(); return sb; };
  const out = h('div', null);
  const update = () => {
    for (const g of segs) g.sync();
    const sb = make();
    const cell = (v: number) => h('td', { class: v === sb.cycle && v > 0 ? 'now' : '' }, v >= 0 ? String(v) : '');
    const reg = (r: number) => (r ? ABI[r] : '');
    out.replaceChildren(
      h('div', { class: 'ooo-sum' }, h('span', null, 'Cycle'), h('b', null, `${sb.cycle}${sb.done ? ` (done; ${sb.ins.length} instructions)` : ''}`)),
      h('div', { class: 'cpu-sec' }, 'Instruction status'),
      h('div', { class: 'scroll' }, h('table', { class: 'data ooo-tab' },
        h('tr', null, ...['instruction', 'issue', 'read operands', 'execute done', 'write result', 'waiting now'].map((t) => h('th', null, t))),
        ...sb.ins.map((i, k) => h('tr', null, h('td', { class: 'mono' }, i.text), cell(i.issue), cell(i.read), cell(i.exec), cell(i.write),
          h('td', { class: `why ${sb.stall[k].replace(/ /g, '-')}` }, sb.stall[k]))))),
      h('div', { class: 'cpu-sec' }, 'Functional units'),
      h('div', { class: 'scroll' }, h('table', { class: 'data ooo-tab' },
        h('tr', null, ...['unit', 'busy', 'Fi', 'Fj', 'Fk', 'Qj', 'Qk', 'Rj', 'Rk'].map((t) => h('th', null, t))),
        ...sb.units.map((u) => h('tr', { class: u.busy >= 0 ? '' : 'idle' }, h('td', null, u.name), h('td', { class: 'mono' }, u.busy >= 0 ? sb.ins[u.busy].text : 'no'),
          ...(u.busy >= 0 ? [reg(u.fi), reg(u.fj), reg(u.fk), u.qj ?? '', u.qk ?? '', u.fj ? (u.rj ? 'yes' : 'no') : '', u.fk ? (u.rk ? 'yes' : 'no') : ''] : ['', '', '', '', '', '', '']).map((v) => h('td', { class: 'mono' }, v)))))),
      h('div', { class: 'cpu-sec' }, 'Register result status'),
      h('div', { class: 'ooo-regs' }, ...(sb.regs.size ? [...sb.regs].map(([r, u]) => h('span', null, `${ABI[r]} ← ${u}`)) : [h('span', null, 'no register waiting for a unit')])));
  };
  const step = (n: number) => { const sb = make(); if (!sb.done) cycle += n; update(); };
  const segs = [
    seg<string>([['hp', 'H&P\'s example'], ['names', 'Reused names']], () => which, (v) => { which = v as typeof which; cycle = 0; update(); }, 'Program'),
    seg<string>([['hp', 'CDC-like latencies (mul 10, div 40)'], ['ours', 'Our latencies']], () => lat, (v) => { lat = v as typeof lat; cycle = 0; update(); }, 'Latencies'),
  ];
  const el = h('div', { class: 'widget ooo-widget' },
    h('div', { class: 'rb-ctl' }, ...segs.map((g) => g.el)),
    h('div', { class: 'rb-ctl' }, btn('Step', 'One cycle', () => step(1), 'btn sm primary'), btn('Back', 'One cycle back', () => { cycle = Math.max(0, cycle - 1); update(); }),
      btn('Run', 'To the end', () => { const sb = make(); cycle += sb.run() - sb.cycle; update(); }), btn('Reset', 'Cycle 0', () => { cycle = 0; update(); })),
    h('p', { class: 'sub' }, 'One unit each for loads, the ALU, multiplies and divides. Issue in order; read operands when both are ready; write when no earlier instruction still has to read the old value.'),
    out);
  update();
  return { el };
}

// ---------------------------------------------------------------------------------------------------------------
// Step: the reorder buffer at work, cycle by cycle (the gate-level core's own model).

export function robWidget(initial = 'dot'): Widget {
  let id = initial, cycle = 24; // opens with the window full, the second pass's loads issuing past older adds
  const out = h('div', null);
  const make = () => { const m = new OooModel(oooProgram(id).words, {}, OPTS); m.historyMax = 2000; while (m.cycle < cycle && !m.halted) m.step(); return m; };
  const update = () => {
    const m = make();
    cycle = m.cycle;
    const cfg = m.cfg, rat = m.rat();
    const opnd = (u: Uop) => u.srcs.map((r) => {
      const p = u.deps.find((d) => d.rd === r);
      const ready = !p || (p.x >= 0 && p.x <= m.cycle);
      return h('span', { class: ready ? 'ok' : 'tag' }, ready ? ABI[r] : `#${p!.rob}`);
    });
    const stateName = (u: Uop) => u.state === 'queued' ? (u.deps.every((p) => p.x >= 0 && p.x <= m.cycle) ? 'ready' : 'waiting') : u.state === 'issued' ? 'executing' : u.state;
    // Everything in flight, then as many of the last committed or flushed as fit in 20 rows.
    const inflight = [...m.robList, ...m.fd];
    const recent = m.history.filter((u) => u.c >= m.cycle - 8).slice(-Math.max(0, 20 - inflight.length));
    const shown = [...recent, ...inflight];
    const c0 = shown.length ? Math.min(...shown.map((u) => u.f)) : 0;
    out.replaceChildren(
      h('div', { class: 'ooo-sum' },
        h('span', null, 'Cycle'), h('b', null, `${m.cycle}${m.halted ? ' (halted)' : ''}`),
        h('span', null, 'Committed'), h('b', null, `${m.stats.instructions} instructions, IPC ${fix(m.stats.instructions / Math.max(1, m.cycle))}`),
        h('span', null, 'Mispredicted, flushed'), h('b', null, `${m.stats.mispredicts}, ${m.stats.wrongPath} wrong-path instructions fetched`)),
      h('div', { class: 'ooo-cols' },
        h('div', null, h('div', { class: 'cpu-sec' }, `Reorder buffer (${m.robList.length} of ${cfg.rob}), head first`),
          h('table', { class: 'data ooo-tab' }, h('tr', null, ...['#', 'instruction', 'state', 'port'].map((t) => h('th', null, t))),
            ...m.robList.map((u, k) => h('tr', { class: `${k === 0 ? 'head' : ''}${u.wrong ? ' wrong' : ''}` }, h('td', null, String(u.rob)), h('td', { class: 'mono' }, u.text),
              h('td', null, h('span', { class: `st ${u.state}` }, stateName(u)), u.mispredict && u.x >= 0 && u.x < m.cycle ? h('span', { class: 'st bad' }, 'mispredicted') : ''),
              h('td', null, u.port >= 0 ? String(u.port) : '–'))))),
        h('div', null, h('div', { class: 'cpu-sec' }, `Issue queue (${m.iqList().length} of ${cfg.iq})`),
          h('table', { class: 'data ooo-tab' }, h('tr', null, ...['#', 'instruction', 'operands'].map((t) => h('th', null, t))),
            ...m.iqList().map((u) => h('tr', null, h('td', null, String(u.rob)), h('td', { class: 'mono' }, u.text), h('td', { class: 'ops' }, ...opnd(u))))),
          h('div', { class: 'cpu-sec' }, 'Rename table'),
          h('div', { class: 'ooo-regs' }, ...(rat.size ? [...rat].sort((a, b) => a[0] - b[0]).map(([r, u]) => h('span', null, `${ABI[r]} → #${u.rob}`)) : [h('span', null, 'every register in the register file')])))),
      h('div', { class: 'cpu-sec' }, 'Recent and in flight'), timeline(shown, c0, m.cycle), legend());
  };
  const go = (n: number) => { cycle += n; update(); };
  const el = h('div', { class: 'widget ooo-widget' },
    h('div', { class: 'rb-ctl' }, picker(PROG_IDS, () => id, (v) => { id = v; cycle = 0; update(); }),
      btn('Step', 'One cycle', () => go(1), 'btn sm primary'), btn('Back', 'One cycle back', () => { cycle = Math.max(0, cycle - 1); update(); }),
      btn('+10', 'Ten cycles', () => go(10)), btn('Reset', 'Cycle 0', () => { cycle = 0; update(); })),
    h('p', { class: 'sub' }, `The core as the gates will build it: ${OOO_CORE.width} wide, a ${OOO_CORE.rob}-entry reorder buffer, an ${OOO_CORE.iq}-entry issue queue, two ports with a result bus each, a BTB and a ${OOO_CORE.ras}-entry return-address stack. An operand shown as #n waits for ROB entry n.`),
    out);
  update();
  return { el };
}

// ---------------------------------------------------------------------------------------------------------------
// Step: guessing past branches. Predictors and recovery, priced on a whole program.

const SPEC_ROWS: [string, Partial<OooConfig>][] = [
  ['BTB only, flush at commit', { predict: 'btb' }],
  ['BTB + return stack, flush at commit (our core)', {}],
  ['BTB + return stack, flush when the branch executes', { recover: 'resolve' }],
  ['Perfect prediction', { predict: 'perfect' }],
];

export function speculationWidget(): Widget {
  let id = 'fib', token = 0;
  const out = h('div', null);
  const update = () => {
    const my = ++token;
    const words = oooProgram(id).words;
    const rows: HTMLElement[] = [];
    out.replaceChildren(h('p', { class: 'sub' }, 'Running…'));
    let k = 0;
    const next = () => {
      if (my !== token) return;
      if (k === SPEC_ROWS.length) {
        out.replaceChildren(h('div', { class: 'scroll' }, h('table', { class: 'data ooo-tab num' },
          h('tr', null, ...['', 'cycles', 'CPI', 'mispredicted', 'wrong-path fetched'].map((t) => h('th', null, t))), ...rows)));
        return;
      }
      const [name, cfg] = SPEC_ROWS[k++];
      const st = new OooModel(words, cfg, OPTS).run(200_000);
      rows.push(h('tr', { class: name.includes('our core') ? 'ours' : '' }, h('td', null, name), h('td', null, String(st.cycles)), h('td', null, fix(st.cycles / st.instructions, 3)),
        h('td', null, String(st.mispredicts)), h('td', null, String(st.wrongPath))));
      setTimeout(next, 0);
    };
    setTimeout(next, 0);
  };
  const el = h('div', { class: 'widget ooo-widget' },
    h('div', { class: 'rb-ctl' }, picker(PROG_IDS.filter((p) => p !== 'names'), () => id, (v) => { id = v; update(); })),
    h('p', { class: 'sub' }, 'The same core, four front ends. Each run goes to the program\'s final jump; the golden model says where the program really went.'),
    out);
  update();
  return { el, destroy: () => { token++; } };
}
