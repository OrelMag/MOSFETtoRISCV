// Chapter 25's Out of order panel, over the gate-level core (lib/ooocore.ts): the reorder buffer, the issue queue,
// the rename table and the store queue as its registers hold them (riscv/ooosnap.ts), and the instructions in flight
// as a timeline from riscv/ooomodel.ts, stepped in lock-step with the gates and checked every cycle (the commits and
// the instruction each port picks). A row's instruction lights its hardware through the CPU panel (OooLink). The
// sandbox's CPU drawer shows the same view (editor/cpuui.ts).

import { ABI, disasm } from '../riscv/isa';
import { OooModel, OOO_CORE, type Uop } from '../riscv/ooomodel';
import { oooIssued, oooSnap, type OooSnap } from '../riscv/ooosnap';
import { retireCount } from '../riscv/cosim';
import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { h } from '../ui/dom';
import type { ScenePanel, Stage, Widget } from '../view/stage';
import { legend, timeline } from './ooo';
import '../styles/ooo.css';

/** The CPU panel's selection, shared with this panel. */
export interface OooLink {
  select?: (pc: number | null, port?: number) => void;
  selected?: () => number | null;
}

const hex = (v: number) => '0x' + (v >>> 0).toString(16);

/**
 * The model run beside the gates: one model cycle per clock edge, the commits and picks compared before each edge.
 * Reset, Back or a run the hooks missed: replayed from the start to the stage's cycle (the model is fast).
 */
export class OooFollower {
  model: OooModel;
  mismatch: string | null = null;
  private pre: { n: number; issued: number[] } | null = null;

  constructor(readonly words: number[], readonly mem: { imemWords: number; dmemWords: number }) {
    this.model = this.fresh();
  }

  private fresh(): OooModel {
    const m = new OooModel(this.words, {}, this.mem);
    m.historyMax = 400;
    return m;
  }

  /** Just before a rising edge: what the hardware commits and picks in the cycle ending now. */
  before(sim: Sim, root: HierNode): void {
    this.pre = this.model.halted || this.model.cycle !== this.cycleOf ? null : { n: retireCount(sim, root), issued: oooIssued(sim, root) };
  }

  /** Just after it: the model's cycle, compared. */
  after(): void {
    const pre = this.pre;
    this.pre = null;
    if (!pre) return;
    const info = this.model.step();
    this.cycleOf++;
    if (this.mismatch || this.model.halted) return;
    const want = [0, 1].map((p) => info.issued.find((u) => u.port === p)?.pc ?? -1);
    if (pre.n !== info.committed.length) this.mismatch = `cycle ${info.cycle}: the hardware committed ${pre.n}, the model ${info.committed.length}`;
    else if (pre.issued.some((pc, p) => pc !== want[p])) this.mismatch = `cycle ${info.cycle}: port picks ${pre.issued.map(hex).join(', ')}, the model ${want.map(hex).join(', ')}`;
  }

  /** The stage's cycle the model is at (edges seen). */
  private cycleOf = 0;

  /** Bring the model to the stage's cycle (after a Reset or a Back). */
  sync(cycles: number, mismatch?: string | null): void {
    if (mismatch !== undefined) this.mismatch = mismatch;
    if (cycles === this.cycleOf) return;
    if (cycles < this.cycleOf) { this.model = this.fresh(); this.cycleOf = 0; if (cycles === 0) this.mismatch = null; }
    while (this.cycleOf < cycles && !this.model.halted) { this.model.step(); this.cycleOf++; }
    this.cycleOf = cycles;
  }
}

/** What an instruction in the reorder buffer is doing, from the gates. */
function robState(snap: OooSnap, tag: number, done: boolean, mis: boolean): HTMLElement[] {
  if (done) return [h('span', { class: 'st done' }, 'done'), ...(mis ? [h('span', { class: 'st bad', title: 'Found mispredicted: its commit flushes everything younger' }, 'mispredicted')] : [])];
  const q = snap.iq.find((e) => e.tag === tag);
  if (!q) return [h('span', { class: 'st issued', title: 'Picked: in a port, the multiplier or the divider' }, 'executing')];
  const waits = [q.waitA, q.waitB].filter((w): w is number => w !== null);
  if (waits.length) return [h('span', { class: 'st', title: 'Waiting for its producers\' tags on a result bus' }, 'waits'), ...waits.map((w) => h('span', { class: 'tagref' }, `#${w}`))];
  return [h('span', { class: 'st ready', title: q.ready ? 'Operands ready: a candidate for its port' : 'Operands ready; a load waits for an older store, or its result bus is taken' }, q.ready ? 'ready' : 'held')];
}

/**
 * The view: a summary line, then the reorder buffer and rename table, or the issue and store queues (all read from
 * the gates), or the timeline (the model's).
 * `show` redraws it; a click on an instruction calls onPick.
 */
export function oooView(onPick: (pc: number, port: number) => void): { el: HTMLElement; show(snap: OooSnap, words: number[], f: OooFollower | null, selPc: number | null): void } {
  let tab: 'rob' | 'queues' | 'time' = 'rob';
  const tabs = h('span', { class: 'seg', role: 'group', 'aria-label': 'View' });
  const body = h('div', { class: 'ooo-now' });
  const sum = h('div', { class: 'ooo-psum' });
  let last: Parameters<ReturnType<typeof oooView>['show']> | null = null;
  const mk = (v: typeof tab, label: string, title: string) => {
    const b = h('button', { type: 'button', title }, label);
    b.addEventListener('click', () => { tab = v; if (last) show(...last); });
    tabs.append(b);
    return [v, b] as const;
  };
  const btns = [mk('rob', 'Reorder buffer', 'The reorder buffer and the rename table, read from the gates'),
    mk('queues', 'Queues', 'The issue queue and the store queue, read from the gates'),
    mk('time', 'Timeline', 'Every instruction in flight and the last ones to leave, cycle by cycle (the model, in step with the gates)')];
  const text = (words: number[], pc: number) => disasm(words[(pc >>> 2)] ?? 0x13, pc);
  const row = (pc: number, port: number, cls: string, selPc: number | null, ...cells: (HTMLElement | string)[]) => {
    const tr = h('tr', { class: `${cls}${pc === selPc ? ' sel' : ''}`, title: 'Light the hardware this instruction uses' }, ...cells.map((c) => (typeof c === 'string' ? h('td', null, c) : c)));
    tr.addEventListener('click', () => onPick(pc, port));
    return tr;
  };
  function show(snap: OooSnap, words: number[], f: OooFollower | null, selPc: number | null): void {
    last = [snap, words, f, selPc];
    for (const [v, b] of btns) { b.classList.toggle('on', v === tab); b.setAttribute('aria-pressed', String(v === tab)); }
    const m = f && !f.mismatch ? f.model : null;
    const uopOf = (tag: number) => m?.robList.find((u) => u.rob === tag);
    sum.replaceChildren(
      h('span', null, `ROB ${snap.rob.length} / ${OOO_CORE.rob}`), h('span', null, `issue queue ${snap.iq.length} / ${OOO_CORE.iq}`),
      h('span', null, `stores ${snap.sq.length} / ${OOO_CORE.sq}`), h('span', null, `fetched ${snap.fetched.length}`),
      ...(m ? [h('span', null, `mispredicted ${m.stats.mispredicts}`)] : []));
    if (tab === 'time') {
      if (!m) {
        body.replaceChildren(h('p', { class: 'sub' }, f?.mismatch ? `The model left step with the gates (${f.mismatch}); the timeline is the model's.` : 'No timeline.'));
        return;
      }
      const inflight = [...m.robList, ...m.fd];
      const recent = m.history.filter((u) => u.c >= m.cycle - 8).slice(-Math.max(0, 18 - inflight.length));
      const shown: Uop[] = [...recent, ...inflight];
      const c0 = shown.length ? Math.min(...shown.map((u) => u.f)) : 0;
      body.replaceChildren(timeline(shown, Math.max(c0, m.cycle - 24), Math.max(0, m.cycle - 1)), legend());
      return;
    }
    const head = snap.rob[0]?.tag;
    const robT = h('table', { class: 'data ooo-tab ooo-ptab' }, h('tr', null, ...['#', 'instruction', 'state'].map((t) => h('th', null, t))),
      ...snap.rob.map((r) => {
        const u = uopOf(r.tag), port = snap.iq.find((e) => e.tag === r.tag)?.port ?? u?.port ?? -1;
        return row(r.pc, port, `${r.tag === head ? 'head' : ''}${u?.wrong ? ' wrong' : ''}`, selPc, String(r.tag), h('td', { class: 'mono' }, text(words, r.pc)),
          h('td', null, ...robState(snap, r.tag, r.done, r.mis && !u?.wrong)));
      }));
    const iqT = h('table', { class: 'data ooo-tab ooo-ptab' }, h('tr', null, ...['#', 'instruction', 'port', 'operands'].map((t) => h('th', null, t))),
      ...snap.iq.map((e) => row(e.pc, e.port, uopOf(e.tag)?.wrong ? 'wrong' : '', selPc, String(e.tag), h('td', { class: 'mono' }, text(words, e.pc)), String(e.port),
        h('td', { class: 'ops' }, ...(e.waitA === null && e.waitB === null ? [h('span', { class: 'ok' }, 'ready')]
          : [e.waitA, e.waitB].filter((w): w is number => w !== null).map((w) => h('span', { class: 'tag' }, `#${w}`)))))));
    const rat = h('div', { class: 'ooo-regs' }, ...(snap.rat.length
      ? [...snap.rat.map(([r, t]) => h('span', null, `${ABI[r]} → #${t}`)), h('span', { class: 'muted' }, 'others: register file')]
      : [h('span', null, 'every register in the register file')]));
    const sq = snap.sq.length ? h('div', { class: 'ooo-regs' }, ...snap.sq.map((s) => h('span', null, `#${s.tag} ${s.executed ? `[${hex(s.addr)}] ← ${hex(s.data)}` : 'address not known yet'}`)))
      : h('div', { class: 'ooo-regs' }, h('span', null, 'no store in flight'));
    body.replaceChildren(...(tab === 'rob'
      ? [h('div', { class: 'cpu-sec' }, 'Reorder buffer', h('span', { class: 'cpu-sec-hint' }, 'head first')), snap.rob.length ? robT : h('div', { class: 'ooo-regs' }, h('span', null, 'empty')),
        h('div', { class: 'cpu-sec' }, 'Rename table'), rat]
      : [h('div', { class: 'cpu-sec' }, 'Issue queue', h('span', { class: 'cpu-sec-hint' }, 'oldest first')), snap.iq.length ? iqT : h('div', { class: 'ooo-regs' }, h('span', null, 'empty')),
        h('div', { class: 'cpu-sec' }, 'Store queue', h('span', { class: 'cpu-sec-hint' }, 'oldest first')), sq]));
  }
  const el = h('div', { class: 'ooo-view' }, h('div', { class: 'rb-ctl' }, tabs), sum, body);
  return { el, show };
}

/** The chapter's panel (docked bottom left, like the pipeline diagram), beside the CPU panel. */
export function oooPanel(words: number[], mem: { imemWords: number; dmemWords: number }, link: OooLink): ScenePanel {
  return (stage: Stage): Widget => {
    const f = new OooFollower(words, mem);
    const status = h('div', { class: 'cpu-status' });
    const view = oooView((pc, port) => link.select?.(link.selected?.() === pc ? null : pc, port));
    const title = h('h4', null, 'Out of order', h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel ooo-panel', 'data-dock': 'left', 'data-phone': 'flow' }, title, status, view.el);
    title.addEventListener('click', () => el.classList.toggle('collapsed'));
    stage.edgeHooks.add({
      before: () => { if (stage.sim && stage.rootCtx) f.before(stage.sim, stage.rootCtx.node); },
      after: () => f.after(),
    });
    stage.historyHooks.add({ save: () => f.mismatch, restore: (v) => { f.sync(0, null); f.mismatch = v as string | null; } });
    const update = () => {
      const sim = stage.sim, root = stage.rootCtx?.node;
      if (!sim || !root || stage.inEdge) return;
      f.sync(stage.cycles);
      status.replaceChildren(f.mismatch ? h('span', { class: 'bad' }, `✗ ${f.mismatch}`)
        : h('span', { class: 'good', title: 'riscv/ooomodel.ts runs beside the gates: the same commits and the same pick on each port, every cycle' }, '✓ in step with the model'),
      ...(f.model.halted ? [h('span', { class: 'warn' }, 'halted')] : []));
      view.show(oooSnap(sim, root), words, f, link.selected?.() ?? null);
    };
    update();
    return { el, update };
  };
}
