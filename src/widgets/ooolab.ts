// The out-of-order lab (chapter 26's "Your own core", the workbench's Lab tab): the model of the core (riscv/ooomodel.ts)
// in any shape, on the chapter's programs, the learner's assembly or chapter 15's Python. CPI against our core, where
// the commit slots went (stats.slots), a timeline of the run, and a price from the gates where the gate-level core can
// be built that way (bench/ooprice.ts: its window sizes; any other shape is timed, not priced).

import { assemble } from '../riscv/asm';
import { compilePy } from '../lang/compile';
import { PY_PROGRAMS } from '../lang/pyprograms';
import { OOO_PROGRAMS } from '../riscv/oooprograms';
import {
  configProblems, OooModel, OOO_CORE, shapeOf, SLOT_CAUSES, UNITS,
  type OooConfig, type OooStats, type SlotCause, type Unit, type Uop,
} from '../riscv/ooomodel';
import { geoMean } from '../bench/summary';
import { priceOf, type Price } from '../bench/ooprice';
import { commitWindow, GRID_PROGRAMS, legend, oooProgram, timeline } from './ooo';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import '../styles/ooo.css';

/** A shape with every default written out: what the knobs edit. */
type Shape = OooConfig & { fetch: number; commit: number; ports: Unit[][]; divider: 'iterative' | 'pipelined' };

export function fullShape(cfg: Partial<OooConfig>): Shape {
  const c: OooConfig = { ...OOO_CORE, ...cfg, lat: { ...OOO_CORE.lat, ...cfg.lat } }, sh = shapeOf(c);
  return { ...c, ...sh, ports: sh.ports.map((p) => p.slice()), width: sh.ports.length, divider: c.divider ?? 'iterative' };
}

export const LAB_PRESETS: [string, Partial<OooConfig>][] = [
  ['Our core', {}],
  ['1 wide', { width: 1 }],
  ['In order', { inorder: true }],
  ['4 wide', { width: 4, rob: 32, iq: 16, sq: 8 }],
  ['Perfect prediction', { predict: 'perfect' }],
  ['Recover at resolve', { recover: 'resolve' }],
  ['No return stack', { predict: 'btb' }],
];

export const SLOT_LABEL: Record<SlotCause, string> = {
  retired: 'committed', mispredict: 'misprediction', frontend: 'front end (window empty)', dependency: 'waiting on an ALU result',
  memory: 'loads and stores', muldiv: 'multiply and divide', port: 'port or bus taken', store: 'one store a cycle',
};
const UNIT_SHORT: Record<Unit, string> = { alu: 'ALU', branch: 'BR', mem: 'LD/ST', mul: 'MUL', div: 'DIV' };
const MAX_PORTS = 8;
const RUN_MAX = 200_000;
const OPTS = { dmemWords: 64, imemWords: 128 };

/** A program to run: words and the memory sizes it needs. */
interface LabProg { id: string; name: string; words: number[]; opts: { dmemWords: number; imemWords: number } }
interface RunOut { prog: LabProg; stats: OooStats; halted: boolean; model?: OooModel; lost?: (SlotCause | null)[] }

const pow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));
const fix = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const nands = (n: number) => n.toLocaleString('en').replace(/,/g, ' ');

/** One run of the model to its halt (a jump to itself) or RUN_MAX cycles; `keep`: the history and every cycle's cause. */
export function labRun(prog: LabProg, cfg: Partial<OooConfig>, keep = false): RunOut {
  const m = new OooModel(prog.words, cfg, prog.opts);
  if (!keep) { m.run(RUN_MAX); return { prog, stats: m.stats, halted: m.halted }; }
  m.historyMax = 1e9;
  const lost: (SlotCause | null)[] = [];
  while (!m.halted && m.cycle < RUN_MAX) lost.push(m.step().lost);
  return { prog, stats: m.stats, halted: m.halted, model: m, lost };
}

const key = (c: Partial<OooConfig>) => JSON.stringify(fullShape(c));
const STORE = 'ooolab:v1';
interface Saved { cfg?: Partial<OooConfig>; prog?: string; asm?: string; py?: string }
function load(): Saved { try { return JSON.parse(localStorage.getItem(STORE) ?? '{}') as Saved; } catch { return {}; } }
function save(s: Saved): void { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* private window */ } }

const DEFAULT_ASM = OOO_PROGRAMS.find((p) => p.id === 'chains')!.source;
const DEFAULT_PY = PY_PROGRAMS.find((p) => p.id === 'primes')!.source;

export function oooLabWidget(): Widget {
  const saved = load();
  let cfg = fullShape(saved.cfg ?? {});
  let progId = saved.prog ?? 'set';
  let asmSrc = saved.asm ?? DEFAULT_ASM, pySrc = saved.py ?? DEFAULT_PY;
  let focus = 0, from = 0, token = 0, timer = 0;
  const kept: { name: string; cfg: Shape; cpi: number; price: Price | null }[] = [];
  const baseCache = new Map<string, OooStats>();
  let last: { runs: RunOut[]; cpi: number; base: number } | null = null;

  // ----- the knobs
  const presetRow = h('div', { class: 'lab-chips', role: 'group', 'aria-label': 'Start from' });
  for (const [name, c] of LAB_PRESETS) presetRow.append(h('button', { type: 'button', class: 'lab-chip', onclick: () => { cfg = fullShape(c); changed(); } }, name));

  const num = (label: string, get: () => number, set: (v: number) => void, min: number, max: number, title = '') => {
    const id = `lab-${label.replace(/\W+/g, '-').toLowerCase()}`;
    const inp = h('input', { type: 'number', id, min: String(min), max: String(max), step: '1', title }) as HTMLInputElement;
    inp.addEventListener('change', () => {
      const v = Math.round(Number(inp.value));
      if (Number.isFinite(v)) set(Math.min(max, Math.max(min, v)));
      changed();
    });
    return { el: h('label', { class: 'lab-num', for: id }, h('span', null, label), inp), sync: () => { inp.value = String(get()); } };
  };
  const sel = <T extends string>(label: string, opts: [T, string][], get: () => T, set: (v: T) => void) => {
    const id = `lab-${label.replace(/\W+/g, '-').toLowerCase()}`;
    const s = h('select', { id, class: 'ooo-sel' }, ...opts.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    s.addEventListener('change', () => { set(s.value as T); changed(); });
    return { el: h('label', { class: 'lab-num', for: id }, h('span', null, label), s), sync: () => { s.value = get(); } };
  };
  const knobs = [
    num('Fetch / dispatch', () => cfg.fetch, (v) => { cfg.fetch = v; }, 1, 8, 'Instructions fetched and dispatched per cycle'),
    num('Commit', () => cfg.commit, (v) => { cfg.commit = v; }, 1, 8, 'Instructions committed per cycle (one store among them)'),
    num('Reorder buffer', () => cfg.rob, (v) => { cfg.rob = v; }, 2, 256),
    num('Issue queue', () => cfg.iq, (v) => { cfg.iq = v; }, 1, 128),
    num('Store queue', () => cfg.sq, (v) => { cfg.sq = v; }, 1, 64),
    sel('Issue', [['ooo', 'out of order, oldest first'], ['in', 'in order']], () => (cfg.inorder ? 'in' : 'ooo'), (v) => { cfg.inorder = v === 'in'; }),
    sel('Binding', [['balance', 'to the port with fewer waiting'], ['alternate', 'alternating']], () => cfg.bind, (v) => { cfg.bind = v; }),
    sel('Predictor', [['ras', 'BTB + return stack'], ['btb', 'BTB only'], ['perfect', 'perfect']], () => cfg.predict, (v) => { cfg.predict = v; }),
    num('BTB entries', () => cfg.btb, (v) => { cfg.btb = v; }, 1, 1024),
    num('Return stack', () => cfg.ras, (v) => { cfg.ras = v; }, 1, 64),
    sel('Recover at', [['commit', 'commit (as the gates)'], ['resolve', 'resolve (needs checkpoints)']], () => cfg.recover, (v) => { cfg.recover = v; }),
    num('Load latency', () => cfg.lat.load, (v) => { cfg.lat = { ...cfg.lat, load: v }; }, 1, 400),
    num('Multiply latency', () => cfg.lat.mul, (v) => { cfg.lat = { ...cfg.lat, mul: v }; }, 1, 40),
    num('Divide latency', () => cfg.lat.div, (v) => { cfg.lat = { ...cfg.lat, div: v }; }, 1, 80),
    sel('Divider', [['iterative', 'one division at a time'], ['pipelined', 'pipelined']], () => cfg.divider, (v) => { cfg.divider = v; }),
  ];
  const [fw, cw, rob, iq, sq, issueSel, bindSel, predSel, btb, ras, recSel, ldl, mull, divl, divSel] = knobs;

  const portsBox = h('div', { class: 'lab-ports' });
  const renderPorts = () => {
    portsBox.replaceChildren(...cfg.ports.map((p, i) => h('div', { class: 'lab-port' },
      h('b', null, `P${i}`),
      h('span', { class: 'lab-units', role: 'group', 'aria-label': `Units on port ${i}` }, ...UNITS.map((u) => h('button', {
        type: 'button', class: `lab-unit${p.includes(u) ? ' on' : ''}`, 'aria-pressed': String(p.includes(u)), title: `${p.includes(u) ? 'Remove' : 'Add'} ${UNIT_SHORT[u]} on port ${i}`,
        onclick: () => { cfg.ports[i] = p.includes(u) ? p.filter((x) => x !== u) : UNITS.filter((x) => x === u || p.includes(x)); changed(); },
      }, UNIT_SHORT[u]))),
      cfg.ports.length > 1 ? h('button', { type: 'button', class: 'lab-x', 'aria-label': `Remove port ${i}`, title: 'Remove this port', onclick: () => { cfg.ports.splice(i, 1); changed(); } }, '×') : '')),
    cfg.ports.length < MAX_PORTS ? h('button', { type: 'button', class: 'lab-add', onclick: () => { cfg.ports.push(['alu']); changed(); } }, '+ add a port') : '');
  };

  // ----- the program
  const progSel = h('select', { class: 'ooo-sel', id: 'lab-prog', 'aria-label': 'Program' },
    h('option', { value: 'set' }, `The benchmark set (${GRID_PROGRAMS.length} programs, geometric mean)`),
    h('optgroup', { label: 'One program' }, ...[...GRID_PROGRAMS, ...OOO_PROGRAMS.map((p) => p.id)].map((id) => h('option', { value: id }, oooProgram(id).name))),
    h('optgroup', { label: 'Your own' }, h('option', { value: 'asm' }, 'Your assembly…'), h('option', { value: 'py' }, 'Your Python (chapter 15)…'))) as HTMLSelectElement;
  const srcBox = h('textarea', { class: 'lab-src', spellcheck: 'false', 'aria-label': 'Program source', rows: '10' }) as HTMLTextAreaElement;
  const srcMsg = h('p', { class: 'lab-msg', role: 'status' });
  const srcWrap = h('div', { class: 'lab-srcwrap' }, srcBox, srcMsg);
  progSel.addEventListener('change', () => { progId = progSel.value; focus = 0; from = 0; changed(); });
  srcBox.addEventListener('input', () => {
    if (progId === 'asm') asmSrc = srcBox.value; else pySrc = srcBox.value;
    from = 0;
    changed(400);
  });

  /** The programs to run now, or why there is none. */
  const programs = (): LabProg[] | string => {
    if (progId === 'set') return GRID_PROGRAMS.map((id) => ({ id, name: oooProgram(id).name, words: oooProgram(id).words, opts: OPTS }));
    if (progId === 'asm') {
      const a = assemble(asmSrc);
      if (a.errors.length) return a.errors.slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join('; ');
      if (!a.words.length) return 'No instructions.';
      return [{ id: 'asm', name: 'Your assembly', words: a.words, opts: { dmemWords: 1024, imemWords: pow2(a.words.length) } }];
    }
    if (progId === 'py') {
      const c = compilePy(pySrc, { dmemWords: 1024 });
      if (c.error) return `line ${c.error.line}: ${c.error.message}`;
      return [{ id: 'py', name: 'Your Python', words: c.words, opts: { dmemWords: 1024, imemWords: pow2(c.words.length) } }];
    }
    const p = oooProgram(progId);
    return [{ id: progId, name: p.name, words: p.words, opts: OPTS }];
  };

  // ----- the results
  const cpiEl = h('b', { class: 'lab-big' }, '–');
  const vsEl = h('b', null, '–'), mpkiEl = h('b', null, '–'), ipcEl = h('b', null, '–'), nandEl = h('b', null, '–'), perEl = h('b', null, '–');
  const kv = (label: string | Node, v: HTMLElement, cls = '') => h('div', { class: `lab-kv ${cls}` }, h('span', null, label), v);
  const headline = h('div', { class: 'lab-head' }, kv('CPI', cpiEl, 'main'), kv('against our core', vsEl), kv('IPC', ipcEl),
    kv('mispredictions / 1000 instr', mpkiEl), kv('NANDs', nandEl), kv('period · delays / instr', perEl));
  const problemsEl = h('div', { class: 'lab-problems', role: 'alert', hidden: true });
  const status = h('span', { class: 'lab-status', 'aria-live': 'polite' });
  const bar = h('div', { class: 'lab-bar', role: 'img' });
  const barLegend = h('div', { class: 'lab-legend' });
  const progTable = h('div', { class: 'lab-scroll' });
  const keptTable = h('div', { class: 'lab-scroll' });
  const keepBtn = h('button', { type: 'button', class: 'btn sm', onclick: () => keep() }, 'Keep for comparison');
  const tlPick = h('select', { class: 'ooo-sel', 'aria-label': 'Program on the timeline' }) as HTMLSelectElement;
  tlPick.addEventListener('change', () => { focus = Number(tlPick.value); from = 0; changed(); });
  const tlSlider = h('input', { type: 'range', min: '0', value: '0', 'aria-label': 'Where in the run' }) as HTMLInputElement;
  const tlPos = h('span', { class: 'mono' });
  tlSlider.addEventListener('input', () => { from = Number(tlSlider.value); drawTimeline(); });
  const tlBox = h('div', null);

  const sync = () => {
    for (const k of knobs) k.sync();
    renderPorts();
    const now = key(cfg);
    presetRow.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(key(LAB_PRESETS[i][1]) === now)));
    progSel.value = progId;
    const own = progId === 'asm' || progId === 'py';
    srcWrap.hidden = !own;
    if (own) { const v = progId === 'asm' ? asmSrc : pySrc; if (srcBox.value !== v) srcBox.value = v; }
  };

  function changed(delay = 120): void {
    save({ cfg, prog: progId, asm: asmSrc, py: pySrc });
    sync();
    clearTimeout(timer);
    timer = window.setTimeout(run, delay);
  }

  function run(): void {
    const my = ++token;
    const bad = configProblems(cfg);
    problemsEl.hidden = !bad.length;
    problemsEl.textContent = bad.join(' ');
    const progs = programs();
    srcMsg.textContent = typeof progs === 'string' ? progs : '';
    srcMsg.classList.toggle('bad', typeof progs === 'string');
    // the last results stay, dimmed, until a shape and a program run again
    const stale = bad.length > 0 || typeof progs === 'string';
    el.classList.toggle('lab-stale', stale);
    if (stale) { status.textContent = ''; return; }
    if (focus >= progs.length) focus = 0;
    status.textContent = 'Running…';
    const runs: RunOut[] = [], base: OooStats[] = [];
    let k = 0;
    const next = () => {
      if (my !== token) return;
      if (k === progs.length) { finish(runs, base); return; }
      const p = progs[k];
      runs.push(labRun(p, cfg, k === focus));
      const bk = `${p.id}:${p.words.join(',')}`;
      let b = baseCache.get(bk);
      if (!b) { b = labRun(p, {}).stats; baseCache.set(bk, b); }
      base.push(b);
      k++;
      window.setTimeout(next, 0);
    };
    window.setTimeout(next, 0);
  }

  function finish(runs: RunOut[], base: OooStats[]): void {
    const cpis = runs.map((r) => r.stats.cycles / Math.max(1, r.stats.instructions));
    const cpi = geoMean(cpis), b = geoMean(base.map((s) => s.cycles / Math.max(1, s.instructions)));
    last = { runs, cpi, base: b };
    const unhalted = runs.filter((r) => !r.halted);
    status.textContent = unhalted.length ? `${unhalted.map((r) => r.prog.name).join(', ')}: no halt in ${nands(RUN_MAX)} cycles (end it with a jump to itself).` : '';
    cpiEl.textContent = fix(cpi);
    ipcEl.textContent = fix(1 / cpi);
    const d = (cpi / b - 1) * 100;
    vsEl.textContent = Math.abs(d) < 0.05 ? 'equal' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} % CPI`;
    vsEl.className = d < -0.05 ? 'good' : d > 0.05 ? 'bad' : '';
    const ins = runs.reduce((a, r) => a + r.stats.instructions, 0), mp = runs.reduce((a, r) => a + r.stats.mispredicts, 0);
    mpkiEl.textContent = fix((1000 * mp) / Math.max(1, ins), 1);
    const price = priceOf(cfg);
    nandEl.textContent = price ? nands(price.nands) : 'not built in gates';
    nandEl.title = price ? '' : 'The gate-level core is 2-wide with its own ports, predictor and latencies; only its window sizes vary.';
    perEl.textContent = price ? `${price.period} · ${fix(price.period * cpi, 1)}` : '–';
    // commit slots, summed over the programs
    const slots = Object.fromEntries(SLOT_CAUSES.map((c) => [c, runs.reduce((a, r) => a + r.stats.slots[c], 0)])) as Record<SlotCause, number>;
    const total = SLOT_CAUSES.reduce((a, c) => a + slots[c], 0) || 1;
    const shown = SLOT_CAUSES.filter((c) => slots[c] > 0);
    const pct = (c: SlotCause) => { const p = (100 * slots[c]) / total; return `${p < 1 ? p.toFixed(1) : p.toFixed(0)} %`; };
    bar.setAttribute('aria-label', shown.map((c) => `${SLOT_LABEL[c]} ${pct(c)}`).join(', '));
    bar.replaceChildren(...shown.map((c) => h('div', { class: `s-${c}`, style: `width:${(100 * slots[c]) / total}%`, title: `${SLOT_LABEL[c]}: ${((100 * slots[c]) / total).toFixed(1)} %` })));
    barLegend.replaceChildren(...shown.map((c) => h('span', null, h('i', { class: `s-${c}` }), `${SLOT_LABEL[c]} ${pct(c)}`)));
    // per program
    progTable.replaceChildren(h('table', { class: 'data ooo-tab num' },
      h('tr', null, ...['program', 'instructions', 'cycles', 'CPI', 'our core', 'mispredictions'].map((t) => h('th', null, t))),
      ...runs.map((r, i) => h('tr', null, h('td', null, r.prog.name), ...[nands(r.stats.instructions), nands(r.stats.cycles), fix(cpis[i]),
        fix(base[i].cycles / Math.max(1, base[i].instructions)), String(r.stats.mispredicts)].map((v) => h('td', null, v))))));
    tlPick.replaceChildren(...runs.map((r, i) => h('option', { value: String(i) }, r.prog.name)));
    tlPick.value = String(focus);
    tlPick.hidden = runs.length < 2;
    renderKept();
    drawTimeline();
  }

  const WIN = 14;
  function drawTimeline(): void {
    const r = last?.runs[focus];
    if (!r?.model) { tlBox.replaceChildren(); return; }
    const done = r.model.history.filter((u) => u.state === 'committed').length;
    tlSlider.max = String(Math.max(0, done - WIN));
    from = Math.min(from, Number(tlSlider.max));
    tlSlider.value = String(from);
    const w = commitWindow(r.model, from, WIN);
    // the flushed instructions fetched inside the window, in fetch order with the rest
    const gone = r.model.history.filter((u) => u.state === 'flushed' && u.f >= w.c0 && u.f <= w.c1);
    const uops: Uop[] = [...w.uops, ...gone].sort((a, b) => a.seq - b.seq);
    tlPos.textContent = `instructions ${from + 1}–${Math.min(done, from + WIN)} of ${nands(done)}, cycles ${w.c0}–${w.c1}`;
    const tl = timeline(uops, w.c0, w.c1);
    const rows = tl.querySelectorAll('tbody tr');
    uops.forEach((u, i) => { (rows[i] as HTMLElement).title = whyOf(u); });
    // a row of where each cycle's empty commit slots went
    const lost = r.lost ?? [];
    const strip = h('tr', { class: 'lab-lost' }, h('td', { class: 'ins' }, 'empty slots'),
      ...Array.from({ length: w.c1 - w.c0 + 1 }, (_, i) => {
        const c = lost[w.c0 + i];
        return h('td', { class: 'c' }, c ? h('span', { class: `s-${c}`, title: `cycle ${w.c0 + i}: ${SLOT_LABEL[c]}` }) : '');
      }));
    tl.querySelector('tbody')!.append(strip);
    tlBox.replaceChildren(tl);
  }

  function keep(): void {
    if (!last) return;
    const name = LAB_PRESETS.find(([, c]) => key(c) === key(cfg))?.[0] ?? `Shape ${kept.length + 1}`;
    const i = kept.findIndex((k) => key(k.cfg) === key(cfg));
    const row = { name, cfg: fullShape(cfg), cpi: last.cpi, price: priceOf(cfg) };
    if (i >= 0) kept[i] = row; else kept.push(row);
    if (kept.length > 8) kept.shift();
    renderKept();
  }

  function renderKept(): void {
    if (!kept.length) { keptTable.replaceChildren(h('p', { class: 'sub' }, 'Keep a shape to compare it with the next.')); return; }
    keptTable.replaceChildren(h('table', { class: 'data ooo-tab num lab-kept' },
      h('tr', null, ...['shape', 'CPI', 'NANDs', 'delays / instr', ''].map((t) => h('th', null, t))),
      ...kept.map((k, i) => h('tr', { class: key(k.cfg) === key(cfg) ? 'ours' : '' },
        h('td', null, h('button', { type: 'button', class: 'lab-link', title: 'Load this shape', onclick: () => { cfg = fullShape(k.cfg); changed(); } }, k.name)),
        h('td', null, fix(k.cpi)), h('td', null, k.price ? nands(k.price.nands) : '–'), h('td', null, k.price ? fix(k.price.period * k.cpi, 1) : '–'),
        h('td', null, h('button', { type: 'button', class: 'lab-x', 'aria-label': `Forget ${k.name}`, onclick: () => { kept.splice(i, 1); renderKept(); } }, '×'))))));
  }

  const sec = (title: string, hint = '') => h('div', { class: 'cpu-sec' }, title, hint ? h('span', { class: 'cpu-sec-hint' }, hint) : '');
  const el = h('div', { class: 'widget ooo-widget lab' },
    h('div', { class: 'lab-grid' },
      h('div', { class: 'lab-knobs' },
        sec('Start from'), presetRow,
        sec('Front and back', 'per cycle'), h('div', { class: 'lab-nums' }, fw.el, cw.el),
        sec('Issue ports', 'the units on each'), portsBox, h('div', { class: 'lab-nums' }, issueSel.el, bindSel.el),
        sec('Window', 'entries'), h('div', { class: 'lab-nums' }, rob.el, iq.el, sq.el),
        sec('Speculation'), h('div', { class: 'lab-nums' }, predSel.el, btb.el, ras.el, recSel.el),
        sec('Units', 'cycles'), h('div', { class: 'lab-nums' }, ldl.el, mull.el, divl.el, divSel.el)),
      h('div', { class: 'lab-out' },
        sec('Program'), progSel, srcWrap, problemsEl,
        headline, status,
        sec('Where the commit slots went', 'commit width × cycles; an empty slot goes to what the oldest instruction waits for'), bar, barLegend,
        h('div', { class: 'lab-two' },
          h('div', null, sec('Per program'), progTable),
          h('div', null, sec('Kept'), keptTable, keepBtn)))),
    sec('Timeline', 'hover a row for why it waited'),
    h('div', { class: 'ooo-slide' }, tlPick, tlSlider, tlPos), tlBox, legend(),
    h('p', { class: 'sub' }, 'The model of the core: the gate-level core matches it cycle for cycle in its own shape. NANDs and the clock period come from the gates ',
      'and exist only where the gate-level core can be built in that shape (its window sizes); the period is in NAND delays, so CPI × period is the time of an instruction.'));
  renderKept();
  changed(0);
  return { el, destroy: () => { token++; clearTimeout(timer); } };
}

/** Why an instruction took the cycles it took, for the timeline's hover. */
function whyOf(u: Uop): string {
  const parts = [`${u.text}${u.port >= 0 ? `, port ${u.port}` : ''}`];
  if (u.wrong) parts.push('on the wrong path: fetched after a misprediction, flushed');
  const waits = u.deps.filter((p) => u.s >= 0 && p.x >= u.d).map((p) => `${p.text} (result in cycle ${p.x})`);
  if (waits.length) parts.push(`waited for ${waits.join(', ')}`);
  if (u.mispredict) parts.push('mispredicted: everything younger is flushed when it commits');
  return parts.join('; ');
}
