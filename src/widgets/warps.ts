// Chapters 30–31 widgets: the warp core scene with its Warp panel (issue timeline, each warp's PC,
// mask and scoreboard, the issuing warp's registers, golden-model lock-step; on chapter 31's core the
// accesses each memory instruction takes, the barrier and the shared memory), and the occupancy
// widget (cycles against warps and load latency from the timing model, NANDs from the circuits).

import { regfile, warpCore } from '../lib';
import { assemble } from '../riscv/asm';
import { ABI, decode, disasm, OPCODES } from '../riscv/isa';
import { WARP_DMEM_K, WARP_PROGRAMS, WARP_SMEM_K, type WarpProgram } from '../riscv/warpprograms';
import { WarpISS } from '../riscv/warps';
import { warpTiming } from '../riscv/warptiming';
import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { stats } from '../sim/stats';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { laneUse } from './insthw';
import { lanesIn, regsReader, scrollTo, wordReader } from './lanes';
import { frameRun, markInstr, showInstrUse, slowControls } from './slowctl';

const LANES = 4;
const hex = (v: number, d = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');
const kid = (n: HierNode, ...p: string[]) => p.reduce((x, k) => x.children!.get(k)!, n);
/** Registers the kernels use, shown per lane. */
const SHOWN = [5, 7, 28, 30, 10, 11];
const programOf = (id: string) => WARP_PROGRAMS.find((p) => p.id === id)!;

export interface WarpSceneOptions {
  warps?: number;
  latency?: number;
  highlight?: string[];
  /** Chapter 31's core (default: when the program needs it). */
  lsu?: boolean;
  sharedLatency?: number;
  globalEvery?: number;
  /** Kernels the panel switches between (program ids; this one among them). */
  programs?: string[];
  /** 'gate': GateSim only (probes, the timing diagram and the power estimate; about a hundred cycles a second). Default: the cycle engine. */
  engine?: 'gate' | 'cycle';
}

const lsuOf = (p: WarpProgram, opts: WarpSceneOptions) => opts.lsu ?? !!p.lsu;

/** The warp core running a kernel whose data is in memory from power-on. */
export function warpCoreScene(id: string, opts: WarpSceneOptions = {}): Scene {
  const p = programOf(id);
  const words = assemble(p.source(LANES)).words;
  const W = opts.warps ?? 4, L = opts.latency ?? 8, lsu = lsuOf(p, opts);
  return {
    root: warpCore(words, { warps: W, lanes: LANES, latency: L, dmemK: WARP_DMEM_K, data: p.data(), lsu, mul: p.mul, smemK: WARP_SMEM_K, sharedLatency: opts.sharedLatency, globalEvery: opts.globalEvery }),
    inputs: { clk: 0 }, highlight: opts.highlight ?? ['sched'], panels: [warpsPanel(p, words, W, L, opts)],
    ...(opts.engine === 'gate' ? {} : { engine: 'cycle' as const }),
  };
}

/** One cycle of the issue timeline: the warp that issued (-1: none), its op, whose loads are in flight; lsu: the access. */
interface Cycle { warp: number; op: string; waiting: number; done: boolean; served: number; shared: boolean; atBar: number; access: number }

/** What the core issues now (settled, before the next edge): the warp (-1: none), its PC and mask, the lanes the memory serves. */
interface Issue { warp: number; pc: number; mask: number; served: number }

function warpsPanel(p: WarpProgram, words: number[], W: number, L: number, opts: WarpSceneOptions): ScenePanel {
  const lsu = lsuOf(p, opts), Ls = opts.sharedLatency ?? 2;
  const shape = { n: LANES, W, lsu, mul: !!p.mul };
  return (stage: Stage): Widget => {
    const fresh = () => new WarpISS(words, { warps: W, lanes: LANES, dmemWords: 2 ** WARP_DMEM_K, data: p.data(), smemWords: lsu ? 2 ** WARP_SMEM_K : 0, mul: p.mul });
    let m = fresh();
    let mismatch: string | null = null;
    let trace: Cycle[] = [];
    let last = 0;
    /** lsu: accesses so far (global, shared), cycles a memory instruction held the port past its first, the access number within the instruction. */
    let acc = { global: 0, shared: 0, held: 0, k: 0 };
    let stopRun: (() => void) | null = null;
    /** The listing line the learner clicked: its hardware stays lit. */
    let selPc: number | null = null;
    /** The issue of the edge in progress (Slow mode at gate level: the view moves under it). */
    let edgeIssue: Issue | null = null;
    const status = h('div', { class: 'cpu-status' });
    const listing = h('div', { class: 'cpu-listing' });
    const usePath = h('div', { class: 'cpu-use' });
    const timeline = h('div', { class: 'warp-grid warp-issue' });
    const slots = h('div', { class: 'warp-slots' });
    const regs = h('div', { class: 'warp-regs' });
    const memory = h('div', { class: 'warp-smem' });
    const sel = h('select', { 'aria-label': 'warps' }) as HTMLSelectElement;
    for (const k of p.threads ? [p.threads / LANES] : [1, 2, 4]) sel.append(h('option', { value: String(k) }, `${k} warp${k > 1 ? 's' : ''}`));
    sel.value = String(W);
    sel.disabled = !!p.threads;
    sel.title = p.threads ? `This kernel is written for ${p.threads} threads` : '';
    sel.addEventListener('change', () => stage.load(warpCoreScene(p.id, { ...opts, warps: Number(sel.value) })));
    const progSel = h('select', { 'aria-label': 'kernel', style: 'min-width:0;max-width:100%' }) as HTMLSelectElement;
    for (const id of opts.programs ?? []) progSel.append(h('option', { value: id }, programOf(id).title));
    progSel.value = p.id;
    progSel.addEventListener('change', () => {
      const q = programOf(progSel.value);
      stage.load(warpCoreScene(q.id, { ...opts, warps: q.threads ? q.threads / LANES : W }));
    });
    const finished = () => m.halted || !!mismatch || stage.cycles > 5000;
    const runBtn = h('button', { class: 'btn sm primary', title: 'Run until every warp is done' }, 'Run to halt');
    const stop = () => stopRun?.();
    runBtn.addEventListener('click', () => {
      if (stopRun) return stop();
      slow.stop();
      slow.tracing = false;
      stage.checkpoint();
      runBtn.textContent = 'Stop';
      stopRun = frameRun(stage, finished, () => { stopRun = null; runBtn.textContent = 'Run to halt'; });
    });
    const slow = slowControls(stage, { multiCycle: true, finished, onStart: stop, instr: { unit: 'issue', label: 'issue', title: 'Issues per second (cycles in which no warp can issue are skipped)' } });
    const lines = words.map((w, i) => {
      const el = h('div', { class: 'ln', title: 'Show the hardware this instruction uses' }, h('span', { class: 'a' }, hex(i * 4, 2)), h('span', null, disasm(w, i * 4)), h('span', { class: 'warp-at' }));
      el.addEventListener('click', () => { selPc = selPc === i * 4 ? null : i * 4; update(); });
      listing.append(el);
      return el;
    });
    const title = h('h4', null, lsu ? `Warps: ${W} × ${LANES} lanes, global ${L} cycles, shared ${Ls}` : `Warps: ${W} × ${LANES} lanes, loads take ${L} cycles`,
      h('span', { class: 'fold-hint' }));
    const hint = lsu ? 'a letter: the warp issued (L load, S store, A amoadd.w, B bar) · faded: a further access · striped: a load in flight · barred: at the barrier'
      : 'a letter: the warp issued · striped: a load of it in flight';
    const el = h('div', { class: 'mem-panel cpu-panel warp-panel', 'data-dock': 'right', 'data-fold': 'narrow' }, title,
      h('div', { class: 'cpu-body' }, h('div', { class: 'param-row', style: 'margin-bottom:6px' }, ...(opts.programs ? [progSel] : []), sel, runBtn), slow.el, status,
        h('div', { class: 'cpu-sec' }, 'Issue timeline', h('span', { class: 'cpu-sec-hint' }, hint)), timeline,
        h('div', { class: 'cpu-sec' }, 'Warps', h('span', { class: 'cpu-sec-hint' }, 'scoreboard: registers waiting for a load')), slots,
        ...(lsu && p.shared ? [h('div', { class: 'cpu-sec' }, 'Shared memory', h('span', { class: 'cpu-sec-hint' }, 'word w in bank w mod 4; the last shared access in colour')), memory] : []),
        h('div', { class: 'cpu-sec' }, 'Program', h('span', { class: 'cpu-sec-hint' }, 'each warp at its PC · click a line: its hardware')), listing, usePath,
        h('div', { class: 'cpu-sec' }, 'Registers of the last warp to issue, per lane'), regs));
    // readers over the current simulation, made once (the hooks read them at every edge)
    type Readers = {
      sim: Sim; issued: () => number; retire: () => number; warp: () => number; pc: () => number; mask: () => number; halted: () => number;
      served: () => number; shared: () => number; atBar: () => number;
      slotPc: (() => number)[]; slotMask: (() => number)[]; pending: (() => number)[]; banks: (() => number[])[][]; smem: (() => number)[];
    };
    let readers: Readers | null = null;
    const rd = (): Readers => {
      const sim = stage.sim!;
      if (readers?.sim !== sim) {
        const root = sim.design.root, port = (k: string) => wordReader(sim, root.ports[k]);
        const none = () => 0;
        readers = {
          sim, issued: port(lsu ? 'issued' : 'retire'), retire: port('retire'), warp: port('warpOut'), pc: port('pcOut'), mask: port('maskOut'), halted: port('halted'),
          served: lsu ? port('served') : none, shared: lsu ? port('sharedOut') : none, atBar: lsu ? port('atBar') : none,
          slotPc: Array.from({ length: W }, (_, w) => wordReader(sim, kid(root, `warp${w}`).ports.pc)),
          slotMask: Array.from({ length: W }, (_, w) => wordReader(sim, kid(root, `warp${w}`).ports.mask)),
          pending: Array.from({ length: W }, (_, w) => wordReader(sim, kid(root, `warp${w}`).ports.pending)),
          banks: Array.from({ length: W }, (_, w) => Array.from({ length: LANES }, (_, i) => regsReader(sim, kid(root, `lane${i}`, `rf${w}`)))),
          smem: lsu && p.shared ? Array.from({ length: 2 ** WARP_SMEM_K }, (_, i) => wordReader(sim, kid(root, 'mem', 'smem', `w${i}`).ports.q)) : [],
        };
      }
      return readers;
    };
    const issueNow = (r: Readers): Issue => (r.issued() === 1 ? { warp: r.warp(), pc: r.pc(), mask: r.mask(), served: r.served() } : { warp: -1, pc: 0, mask: 0, served: 0 });
    /** The words the last shared access touched, by lane. */
    let lastShared: { words: number[]; lanes: number[] } = { words: [], lanes: [] };
    stage.edgeHooks.add({
      before: () => {
        if (!stage.sim) return;
        const r = rd();
        edgeIssue = issueNow(r);
        const issued = edgeIssue.warp >= 0, w = edgeIssue.warp;
        const done = r.retire() === 1;
        let waiting = 0;
        for (let k = 0; k < W; k++) if (r.pending[k]()) waiting |= 1 << k;
        let op = '', served = 0, shared = false, access = 0;
        if (issued && m.runnable(w)) {
          const word = m.warps[w].lanes[0].fetch(m.warps[w].pc);
          op = decode(word).spec?.name ?? '?';
          if (lsu) {
            served = edgeIssue.served;
            shared = r.shared() === 1;
            const d = decode(word);
            if (d.opcode === OPCODES.LOAD || d.opcode === OPCODES.STORE || d.opcode === OPCODES.AMO) {
              if (acc.k > 0) acc.held++;
              access = ++acc.k;
              if (served) {
                if (shared) acc.shared++; else acc.global++;
                if (shared) {
                  const s = m.warps[w];
                  const off = d.opcode === OPCODES.AMO ? 0 : d.imm;
                  lastShared = { lanes: lanesIn(served, LANES), words: lanesIn(served, LANES).map((i) => ((s.lanes[i].x[d.rs1] + off) >>> 2) & (2 ** WARP_SMEM_K - 1)) };
                }
              }
              if (done) acc.k = 0;
            }
          }
          if (done) {
            m.step(w);
            last = w;
          }
        }
        trace.push({ warp: w, op, waiting, done, served, shared, atBar: r.atBar(), access });
        if (trace.length > 400) trace = trace.slice(-200);
      },
      after: () => {
        edgeIssue = null;
        if (!stage.sim || trace.length === 0) return;
        const t = trace[trace.length - 1], w = t.warp;
        if (w >= 0) slow.retired();
        if (mismatch || w < 0 || !t.done) return;
        const r = rd();
        if (r.slotPc[w]() !== m.warps[w].pc) mismatch = `warp ${w}: PC differs from the model`;
        else if (r.slotMask[w]() !== m.warps[w].mask) mismatch = `warp ${w}: mask differs from the model`;
        else {
          // registers a load will still write are compared once it has
          const pend = r.pending[w]();
          for (let i = 0; i < LANES && !mismatch; i++) {
            const x = r.banks[w][i](), d = x.findIndex((v, k) => !((pend >>> k) & 1) && v !== m.warps[w].lanes[i].x[k]);
            if (d >= 0) mismatch = `warp ${w}, lane ${i}: ${ABI[d]} differs from the model`;
          }
        }
      },
    });
    type Saved = { m: ReturnType<WarpISS['warps'][number]['save']>[]; active: boolean[]; waitingBar: boolean[]; barId: number; retired: number; steps: number; dmem: Uint32Array; smem: Uint32Array;
      mismatch: string | null; trace: Cycle[]; last: number; acc: typeof acc; lastShared: typeof lastShared };
    stage.historyHooks.add({
      save: (): Saved => ({ m: m.warps.map((x) => x.save()), active: m.active.slice(), waitingBar: m.waiting.slice(), barId: m.barId, retired: m.retired, steps: m.activeLaneSteps,
        dmem: m.dmem.slice(), smem: m.smem.slice(), mismatch, trace: trace.slice(), last, acc: { ...acc }, lastShared }),
      restore: (v) => {
        const st = v as Saved;
        stop();
        slow.stop();
        m.dmem.set(st.dmem);
        m.smem.set(st.smem);
        m.warps.forEach((x, i) => x.restore(st.m[i]));
        m.active = st.active.slice();
        m.waiting = st.waitingBar.slice();
        m.barId = st.barId;
        m.retired = st.retired;
        m.activeLaneSteps = st.steps;
        mismatch = st.mismatch;
        trace = st.trace.slice();
        last = st.last;
        acc = { ...st.acc };
        lastShared = st.lastShared;
        edgeIssue = null;
      },
    });
    /** Light the selected instruction, or in Slow mode the one the scheduler issues now, on its warp and lanes. */
    const showUse = (now: Issue) => {
      if (selPc === null && !slow.tracing) return showInstrUse(stage, usePath, null);
      if (selPc === null && now.warp < 0) {
        // nobody issues: the warps wait (a load in flight, the barrier) or are done
        markInstr(stage, null, ['sched', 'mem', ...Array.from({ length: W }, (_, w) => `hz${w}`)]);
        usePath.replaceChildren(h('div', null, m.halted ? 'every warp is done' : 'no warp can issue this cycle: each waits for a load, the barrier or the memory port'));
        return;
      }
      const pc = selPc ?? now.pc, word = words[pc >>> 2] ?? 0x13, issuing = now.warp >= 0 && now.pc === pc;
      const memNow = issuing && lsu && now.served !== 0;
      const lanes = issuing ? lanesIn(memNow ? now.served : now.mask, LANES) : undefined;
      showInstrUse(stage, usePath, { pc, word, use: laneUse(word, shape, issuing ? { warp: now.warp, lanes } : {}),
        where: issuing ? `warp ${now.warp} issues it, ${memNow ? `the memory serves lane${lanes!.length > 1 ? 's' : ''} ${lanes!.join(', ')}` : `lanes ${lanes!.join(', ') || 'none'} active`}`
          : 'not issuing this cycle; lit: everything it uses' });
    };
    const letter = (op: string) => (op === 'lw' ? 'L' : op === 'sw' ? 'S' : op === 'amoadd.w' ? 'A' : op === 'bar' ? 'B' : '');
    const cellTitle = (t: Cycle, c: number) => {
      let s = `cycle ${c}: warp ${t.warp} issues ${t.op}`;
      if (t.access) s += t.served ? `, access ${t.access}: lane${lanesIn(t.served, LANES).length > 1 ? 's' : ''} ${lanesIn(t.served, LANES).join(', ')}, ${t.shared ? 'shared memory' : 'a global line'}` : `, access ${t.access} waits (its memory is busy)`;
      return s + (t.access && !t.done ? '; more lanes left' : '');
    };
    const update = () => {
      const sim = stage.sim;
      if (!sim) return;
      slow.update();
      if (stage.cycles === 0 && m.retired > 0) { m = fresh(); mismatch = null; trace = []; last = 0; acc = { global: 0, shared: 0, held: 0, k: 0 }; lastShared = { words: [], lanes: [] }; slow.tracing = false; }
      const r = rd();
      // a further access of a memory instruction uses the slot but starts nothing
      const issued = trace.filter((t) => t.warp >= 0 && t.access <= 1).length;
      status.replaceChildren(
        h('span', null, `cycle ${stage.cycles}`),
        h('span', null, `${m.retired} instructions`),
        h('span', { title: lsu ? 'cycles in which an instruction started (the further accesses of a memory instruction do not count)' : '' }, `issue slots used ${trace.length ? Math.round((100 * issued) / trace.length) : 0} %`),
        ...(lsu ? [h('span', null, `${acc.global} global / ${acc.shared} shared accesses`), h('span', { title: 'cycles a memory instruction kept the issue port past its first access' }, `${acc.held} cycles holding the port`)] : []),
        mismatch ? h('span', { class: 'bad' }, `✗ ${mismatch}`) : h('span', { class: 'good' }, '✓ matches the warp golden model'),
        ...(r.halted() ? [h('span', { class: 'warn' }, 'every warp done')] : []));
      const shown = trace.slice(-36), base = trace.length - shown.length;
      timeline.replaceChildren(h('table', null,
        h('tr', null, h('th'), ...shown.map((_, i) => h('th', null, (base + i) % 5 ? '' : String(base + i)))),
        ...Array.from({ length: W }, (_, w) => h('tr', null, h('td', { class: 'lbl' }, `w${w}`),
          ...shown.map((t, i) => t.warp === w
            ? h('td', { class: `w${w % 4}${t.access > 1 ? ' more' : ''}${t.access && !t.served ? ' blocked' : ''}`, title: cellTitle(t, base + i) }, t.access > 1 || (t.access && !t.served) ? '·' : letter(t.op))
            : (t.atBar >> w) & 1 ? h('td', { class: 'bar', title: `cycle ${base + i}: warp ${w} waits at the barrier` })
              : h('td', { class: (t.waiting >> w) & 1 ? 'wait' : '', title: `cycle ${base + i}${(t.waiting >> w) & 1 ? `: warp ${w} waits for a load` : ''}` })))),
        h('tr', null, h('td', { class: 'lbl' }, 'idle'), ...shown.map((t) => h('td', { class: t.warp < 0 ? 'idle' : 'none' })))));
      const pcs = r.slotPc.map((f) => f());
      const now = edgeIssue ?? issueNow(r);
      lines.forEach((l, i) => {
        const here = pcs.map((pc, w) => (pc === i * 4 && m.alive(w) ? w : -1)).filter((w) => w >= 0);
        l.classList.toggle('cur', here.length > 0);
        l.classList.toggle('sel', i * 4 === selPc);
        l.classList.toggle('issue', now.warp >= 0 && now.pc === i * 4);
        (l.lastChild as HTMLElement).replaceChildren(...here.map((w) => h('i', { class: `w${w % 4}${w === now.warp ? ' now' : ''}`, title: w === now.warp ? `warp ${w} issues this cycle` : `warp ${w}` }, String(w))));
      });
      if (selPc === null) scrollTo(listing, lines[(now.warp >= 0 ? now.pc : pcs[last]) >>> 2]);
      showUse(now);
      slots.replaceChildren(h('table', null, h('tr', null, h('th'), h('th', null, 'PC'), h('th', null, 'mask'), h('th', null, 'waiting for')),
        ...Array.from({ length: W }, (_, w) => {
          const pend = r.pending[w](), names = ABI.filter((_, k) => (pend >>> k) & 1);
          const state = !m.active[w] ? 'not started' : !m.alive(w) ? 'done' : m.waiting[w] ? ['the barrier', ...names].join(' ') : names.join(' ') || '—';
          return h('tr', null, h('td', { class: 'lbl' }, h('i', { class: `dot w${w % 4}` }), `warp ${w}`), h('td', null, m.active[w] ? hex(pcs[w], 2) : ''),
            h('td', null, m.active[w] ? r.slotMask[w]().toString(2).padStart(LANES, '0').split('').reverse().join('') : ''),
            h('td', { class: names.length || m.waiting[w] ? 'pend' : 'z' }, state));
        })));
      if (lsu && p.shared) {
        const N = 2 ** WARP_SMEM_K;
        memory.replaceChildren(h('table', null, h('tr', null, h('th'), ...[0, 1, 2, 3].map((b) => h('th', null, `bank ${b}`))),
          ...Array.from({ length: N / 4 }, (_, row) => h('tr', null, h('td', { class: 'lbl' }, String(4 * row)),
            ...[0, 1, 2, 3].map((b) => {
              const wd = 4 * row + b, v = r.smem[wd](), k = lastShared.words.indexOf(wd);
              return h('td', { class: `${v ? '' : 'z'}${k >= 0 ? ` hit w${lastShared.lanes[k] % 4}` : ''}`, title: `word ${wd} (0x${(0x1000 + 4 * wd).toString(16)}), bank ${b}, row ${row}` }, String(v | 0));
            })))));
      }
      const xs = r.banks[last].map((f) => f()), pend = r.pending[last]();
      regs.replaceChildren(h('table', null,
        h('tr', null, h('th', null, `warp ${last}`), ...Array.from({ length: LANES }, (_, i) => h('th', null, `lane ${i}`))),
        ...SHOWN.map((k) => h('tr', null, h('td', { class: 'lbl' }, ABI[k]), ...xs.map((x) => h('td', { class: (pend >>> k) & 1 ? 'pend' : x[k] ? '' : 'z', title: (pend >>> k) & 1 ? 'a load will write it' : '' }, String(x[k] | 0)))))));
    };
    // opening the immediate generator or the control unit keeps the instruction's colours
    const unNav = stage.onNavigate(() => update());
    update();
    return {
      el, update, destroy: () => {
        stop();
        slow.stop();
        unNav();
        stage.markNets(new Map());
        if (stage.path.length === 0) stage.highlight(stage.scene?.highlight ?? []);
      },
    };
  };
}

// ---- occupancy ---------------------------------------------------------------------------------

/** Cycles for saxpy against warps, for a chosen load latency (the timing model), and what each warp costs (the circuits). */
export function occupancyWidget(): Widget {
  const el = h('div', { class: 'widget warp-occ' });
  const p = programOf('saxpy64');
  const words = assemble(p.source(LANES)).words;
  const WS = [1, 2, 4, 8], LS = [2, 4, 8, 16];
  const lat = h('select', { 'aria-label': 'load latency' }) as HTMLSelectElement;
  for (const L of LS) lat.append(h('option', { value: String(L) }, `${L}-cycle loads`));
  lat.value = '8';
  const chart = h('div', { class: 'warp-occ-chart' });
  const table = h('div');
  const costs = WS.map((W) => stats(warpCore(words, { warps: W, lanes: LANES, latency: 8, dmemK: WARP_DMEM_K, data: p.data() })).nands);
  const draw = () => {
    const L = Number(lat.value);
    const runs = WS.map((W) => warpTiming(words, { warps: W, lanes: LANES, latency: L, dmemWords: 2 ** WARP_DMEM_K, data: p.data() }));
    const max = Math.max(...runs.map((r) => r.cycles)) * 1.12;
    const S = 'http://www.w3.org/2000/svg', w = 520, ht = 210, x0 = 54, y0 = 180;
    const svg = document.createElementNS(S, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${ht + 10}`);
    svg.setAttribute('class', 'lvc-bars');
    const add = (tag: string, a: Record<string, string | number>, text?: string) => {
      const e = document.createElementNS(S, tag);
      for (const k in a) e.setAttribute(k, String(a[k]));
      if (text !== undefined) e.textContent = text;
      svg.appendChild(e);
      return e;
    };
    const step = (w - x0 - 20) / WS.length;
    for (let g = 0; g <= max; g += 100) {
      const y = y0 - (g / max) * (y0 - 14);
      add('line', { x1: x0, y1: y, x2: w - 10, y2: y, class: 'grid' });
      add('text', { x: x0 - 6, y: y + 4, 'text-anchor': 'end', class: 'ax' }, String(g));
    }
    runs.forEach((r, i) => {
      const x = x0 + step * i + 8, bw = step - 16, bh = (r.cycles / max) * (y0 - 14);
      add('rect', { x, y: y0 - bh, width: bw, height: bh, rx: 3, fill: `var(--series-${(i % 4) + 1})` });
      add('text', { x: x + bw / 2, y: y0 - bh - 5, 'text-anchor': 'middle', class: 'tot' }, String(r.cycles));
      add('text', { x: x + bw / 2, y: y0 + 16, 'text-anchor': 'middle', class: 'nm' }, `${WS[i]} warp${WS[i] > 1 ? 's' : ''}`);
      add('text', { x: x + bw / 2, y: y0 + 30, 'text-anchor': 'middle', class: 'ax' }, `${Math.round((100 * r.issued) / r.cycles)} % busy`);
    });
    chart.replaceChildren(svg);
    table.replaceChildren(h('table', { class: 'lvc-table' },
      h('tr', null, h('th', null, 'Warps'), h('th', null, 'NANDs'), h('th', null, 'of which registers'), h('th', null, 'cycles'), h('th', null, 'instructions'), h('th', null, 'NAND · cycles (M)')),
      ...WS.map((W, i) => {
        const rf = W * LANES * stats(regfile(5, 32)).nands;
        return h('tr', null, h('td', null, String(W)), h('td', null, costs[i].toLocaleString('en')), h('td', null, rf.toLocaleString('en')),
          h('td', null, String(runs[i].cycles)), h('td', null, String(runs[i].issued)), h('td', null, ((costs[i] * runs[i].cycles) / 1e6).toFixed(1)));
      })));
  };
  lat.addEventListener('change', draw);
  draw();
  el.append(h('div', { class: 'lvc-title' }, 'saxpy on 64 elements: cycles against warps'), h('div', { class: 'param-row' }, lat), chart, table,
    h('p', { class: 'sub' }, 'Cycles from the timing model, which the tests check against the gate-level core cycle for cycle; NANDs counted in the circuits (8-cycle loads). '
      + `Registers are ${LANES} lanes × 31 × 32 bits per warp, ${stats(regfile(5, 32)).nands.toLocaleString('en')} NANDs per lane. More warps pay only while some issue slot is still empty.`));
  return { el };
}
