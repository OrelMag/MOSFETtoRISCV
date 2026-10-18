// The level screen's walkthrough: the reference answer built one step at a time (campaign/walk.ts)
// on a scratch chip of its own, so the learner's drawing is never touched. The chips the answer
// places come in once (renamed if their ids are taken) and the scratch chip refers to them through
// those names. Each step redraws the scratch chip and selects what the step added. "I'll take it
// from here" copies the partial circuit into the level's chip (one undo step); leaving removes the
// scratch chip and the chips it brought, unless the learner took them. A step with a question (WalkStep.ask) keeps its
// parts back until it is answered: predict first, then see. Build along: the learner places the step's parts on their
// outlines and wires them, and Check step compares the result with the reference (campaign/buildalong.ts).

import { checkBuild, snapCandidate, type BuildCheck } from '../../campaign/buildalong';
import { codexById } from '../../campaign/codex';
import { stepMetrics, partialDoc, type StepMetrics, type Walk, walkOf } from '../../campaign/walk';
import type { CampaignNode } from '../../campaign/types';
import type { BuildChallenge } from '../../editor/challenges';
import type { Editor } from '../../editor/editor';
import { compileChip } from '../../editor/compile';
import type { ChipDoc, PartDoc, Workspace } from '../../editor/model';
import { moveSel } from '../../editor/ops';
import { partDef } from '../../editor/parts';
import { openChip } from '../../editor/session';
import { importChips } from '../../editor/store';
import { h, icon } from '../dom';
import { quizBox } from '../quiz';
import { settings } from '../settings';

export class WalkMode {
  readonly walk: Walk;
  /** The step shown (−1: before the first). */
  k = 0;
  private scratchId: string;
  /** Chips the answer brought into the workspace (removed on leave). */
  private added: string[] = [];
  /** Reference chip id → its id in the workspace. */
  private ids = new Map<string, string>();
  private metrics = new Map<number, StepMetrics>();
  /** Steps whose question was answered (or skipped) in this walk. */
  private revealed = new Set<number>();
  /** Watch the reference being built, or build each step yourself. */
  mode: 'watch' | 'build' = 'watch';
  /** The step the scratch chip was last set up for in Build along (the learner's work on it is kept). */
  private buildStep = -1;
  private checkRes: BuildCheck | null = null;
  private passed = new Set<number>();
  private readonly snapHook = () => this.snap();

  /** undefined when the level has no walkthrough. */
  static open(ed: Editor, node: CampaignNode, ch: BuildChallenge, k: number, levelChip: string, changed: () => void): WalkMode | undefined {
    const w = walkOf(node);
    if (!w || !w.steps.length) return undefined;
    return new WalkMode(ed, node, ch, w, k, levelChip, changed);
  }

  private constructor(private ed: Editor, private node: CampaignNode, private ch: BuildChallenge, w: Walk, k: number, private levelChip: string, private changed: () => void) {
    this.walk = w;
    this.scratchId = `u_walk_${node.id}`;
    // Bring the answer's chips in, the way "Do it for me" does, and learn their names in the workspace
    // from the main chip's rewritten references.
    const r = importChips(w.docs, ed.ws);
    const mainId = r.order[r.order.length - 1];
    const imported = r.ws.chips[mainId];
    for (const p of w.main.parts) {
      const q = imported.parts.find((x) => x.id === p.id);
      if ('chip' in p.ref && q && 'chip' in q.ref) this.ids.set(p.ref.chip, q.ref.chip);
    }
    const chips = { ...r.ws.chips };
    if (r.added.includes(mainId)) delete chips[mainId];
    this.added = r.added.filter((a) => a !== mainId);
    if (ed.level) ed.level.chipId = this.scratchId;
    ed.paintHooks.add(this.snapHook);
    // The step's parts are shown selected: that selection must not open the properties panel.
    ed.el.classList.add('walking');
    this.k = Math.max(0, Math.min(k, w.steps.length - 1));
    this.show({ ...r.ws, chips }, true);
  }

  get steps() { return this.walk.steps; }
  get last(): boolean { return this.k >= this.walk.steps.length - 1; }

  /** The scratch chip after step k, its sub-chip references renamed into the workspace. */
  private docAt(k: number): ChipDoc {
    const d = partialDoc(this.walk, k);
    return {
      ...d, id: this.scratchId, name: `${this.node.title} (walkthrough)`,
      parts: d.parts.map((p) => ('chip' in p.ref && this.ids.has(p.ref.chip) ? { ...p, ref: { chip: this.ids.get(p.ref.chip)! } } : p)),
    };
  }

  /** The step's question, if it still holds the step's parts back. */
  private pending(k = this.k) {
    const ask = this.walk.steps[k]?.ask;
    return ask && !this.revealed.has(k) && !settings.isSolved(this.askKey(k)) ? ask : undefined;
  }

  private askKey(k: number): string {
    return `walk:${this.node.id}:${k}`;
  }

  private reveal(): void {
    this.revealed.add(this.k);
    this.show(this.ed.ws);
  }

  /** The step's parts as they sit in the reference: the outlines of Build along. */
  private guides(k = this.k): PartDoc[] {
    const ids = new Set(this.walk.steps[k].parts);
    return this.docAt(k).parts.filter((p) => ids.has(p.id));
  }

  private show(ws: Workspace, first = false): void {
    const ed = this.ed;
    const held = !!this.pending();
    const build = this.mode === 'build';
    let doc: ChipDoc;
    if (build) {
      // A step entered in Build along starts from the reference before it; the learner's work on it then stays.
      if (this.buildStep !== this.k || !ws.chips[this.scratchId]) { doc = this.docAt(this.k - 1); this.buildStep = this.k; this.checkRes = null; }
      else doc = ws.chips[this.scratchId];
    } else doc = this.docAt(held ? this.k - 1 : this.k);
    const next = openChip({ ...ws, chips: { ...ws.chips, [this.scratchId]: doc } }, this.scratchId);
    ed.volatile(next);
    const s = this.walk.steps[this.k];
    ed.view.showGuides(build && !held ? this.guides().map((part) => ({ part, def: ed.defOf(part) })) : []);
    ed.select(held || build ? {} : { parts: [...s.parts], wires: [...s.wires], labels: [...s.labels] });
    if (first) ed.fitView();
    this.changed();
  }

  go(k: number): void {
    this.k = Math.max(0, Math.min(k, this.walk.steps.length - 1));
    this.show(this.ed.ws);
  }

  setMode(m: 'watch' | 'build'): void {
    if (m === this.mode) return;
    this.mode = m;
    this.buildStep = -1;
    this.show(this.ed.ws);
  }

  /** Build along: is the learner's chip wired like the reference after this step? */
  checkStep(): void {
    const ed = this.ed;
    const mine = ed.ws.chips[this.scratchId];
    const mc = ed.lib.compiled(this.scratchId);
    if (!mine || !mc) return;
    const ref = this.docAt(this.k);
    const rc = compileChip(ref, (r) => partDef(r, (id) => ed.lib.defOf(id)));
    this.checkRes = checkBuild(ref, rc.netOfEnd, mine, mc.netOfEnd);
    if (this.checkRes.ok) this.passed.add(this.k);
    this.changed();
  }

  /** Build along: a part dropped near its outline moves onto it (after a drag, never during one). */
  private snap(): void {
    const ed = this.ed;
    if (this.mode !== 'build' || ed.chipId !== this.scratchId || ed.history.inTransaction || this.pending()) return;
    const mine = ed.ws.chips[this.scratchId];
    const c = mine && snapCandidate(this.guides(), mine);
    if (!c) return;
    const p = mine.parts.find((x) => x.id === c.id)!;
    ed.edit((doc) => {
      const moved = moveSel(doc, { parts: [c.id] }, [c.at[0] - p.at[0], c.at[1] - p.at[1]], ed.defOf);
      return { ...moved, parts: moved.parts.map((x) => (x.id === c.id ? { ...x, flip: c.flip || undefined } : x)) };
    });
  }

  /** Cost and rows right after the current step (measured once, compiling the partial circuit). */
  metricsNow(): StepMetrics | undefined {
    if (!this.metrics.has(this.k)) {
      try { this.metrics.set(this.k, stepMetrics(this.walk, this.k, this.ch)); } catch { return undefined; }
    }
    return this.metrics.get(this.k);
  }

  /** The partial circuit becomes the level's chip (one undo step); the walkthrough ends. */
  takeOver(): void {
    const ed = this.ed;
    const sc = ed.ws.chips[this.scratchId] ?? this.docAt(this.k);
    this.added = []; // the level's chip places them now
    this.restoreLevel();
    ed.editWs((ws) => {
      const chips = { ...ws.chips };
      delete chips[this.scratchId];
      const cur = chips[this.levelChip];
      const { ff: _ff, ...rest } = cur;
      chips[this.levelChip] = { ...rest, pins: sc.pins, parts: sc.parts, wires: sc.wires, labels: sc.labels, ...(this.last && sc.ff ? { ff: { ...sc.ff } } : {}) };
      return openChip({ ...ws, chips }, this.levelChip);
    });
    ed.select({});
    ed.toast('The circuit so far is yours to finish (Ctrl+Z brings your drawing back)');
  }

  /** Leave: the scratch chip and the chips it brought go, the level's chip comes back. */
  leave(): void {
    const ed = this.ed;
    this.restoreLevel();
    const chips = { ...ed.ws.chips };
    delete chips[this.scratchId];
    for (const id of this.added) delete chips[id];
    ed.volatile(openChip({ ...ed.ws, chips, open: ed.ws.open.filter((o) => o !== this.scratchId && !this.added.includes(o)) }, this.levelChip));
    ed.select({});
  }

  private restoreLevel(): void {
    if (this.ed.level) this.ed.level.chipId = this.levelChip;
    this.ed.el.classList.remove('walking');
    this.ed.paintHooks.delete(this.snapHook);
    this.ed.view.showGuides([]);
  }

  // ---- the side panel ----------------------------------------------------------------------------

  /** Build along's part of the step card: what to do, Check step, and the verdict. */
  private buildBox(): HTMLElement {
    const r = this.checkRes, done = this.passed.has(this.k);
    const name = (p: PartDoc) => p.label ?? p.id;
    const verdict = !r ? null : r.ok ? h('p', { class: 'lv-verdict ok' }, icon('check', 12), ' Wired like the reference.')
      : h('div', { class: 'lv-verdict' },
        r.missing.length ? h('p', null, 'Still to place on their outlines: ', r.missing.map(name).join(', '), '.') : null,
        r.wiring.length ? h('p', null, 'Wired differently from the reference: ', r.wiring.slice(0, 4).join(', '), r.wiring.length > 4 ? ` and ${r.wiring.length - 4} more` : '', '.') : null,
        r.extra.length ? h('p', null, 'Not in the reference here: ', r.extra.join(', '), '.') : null);
    return h('div', { class: 'lv-build' },
      h('p', { class: 'sub' }, done ? 'Done. Next starts the next step from the reference.' : 'Place the outlined parts (a part dropped near its outline snaps onto it) and wire them.'),
      h('p', null, h('button', { class: 'btn sm primary', onclick: () => this.checkStep() }, 'Check step')), verdict);
  }

  panel(par: { nand?: number; depth?: number }, close: () => void, take: () => void): HTMLElement {
    const w = this.walk, s = w.steps[this.k];
    const list = h('ol', { class: 'lv-steps' }, w.steps.map((st, i) => h('li', { class: i < this.k ? 'done' : i === this.k ? 'cur' : '' },
      h('button', { onclick: () => this.go(i), title: `Go to step ${i + 1}` }, h('span', { class: 'k' }, i < this.k ? icon('check', 11) : String(i + 1)), h('span', null, st.title)))));
    const meters = h('div', { class: 'lv-meters' }, h('p', { class: 'sub' }, 'Measuring…'));
    const ask = this.pending();
    const learn = (this.node.chapters ?? []).map((c) => h('a', { class: 'lv-chip acc', href: `#/c/${c.chapter}/${c.step ?? 0}` }, icon('book', 12), c.label));
    const card = h('section', { class: 'lv-step' },
      h('h3', null, `Step ${this.k + 1} of ${w.steps.length} · ${s.title}`),
      ask ? h('div', { class: 'lv-predict' }, quizBox(ask, this.askKey(this.k), 'Predict first', () => this.reveal()),
        h('button', { class: 'btn ghost sm', onclick: () => this.reveal() }, 'Show the step')) : h('p', null, s.text),
      !ask && this.mode === 'build' ? this.buildBox() : null,
      s.codex.length ? h('div', { class: 'lv-chips' }, s.codex.map((id) => codexById(id)).filter((e) => !!e).map((e) => h('a', { class: 'lv-chip acc', href: `#/campaign/codex/${e!.id}` }, `Codex: ${e!.title}`))) : null,
      ask || this.mode === 'build' ? null : meters,
      s.authored ? null : h('p', { class: 'lv-gen sub' }, 'Generated from the reference circuit.'));
    // Compiling the partial circuit takes a moment on a big level: after the panel is on screen.
    setTimeout(() => {
      const m = this.metricsNow();
      if (!m) return void meters.replaceChildren(h('p', { class: 'sub' }, 'The partial circuit cannot be measured yet.'));
      const bar = (label: string, v: number, p?: number) => h('div', { class: 'lv-meter' },
        h('span', null, label, ' ', h('b', null, v.toLocaleString()), p !== undefined ? ` of par ${p.toLocaleString()}` : ''),
        p ? h('span', { class: 'track' }, h('i', { class: v > p ? 'over' : '', style: `width:${Math.min(100, (100 * v) / p).toFixed(1)}%` })) : null);
      const out: HTMLElement[] = [bar('Cost so far:', m.nand, par.nand)];
      // Depth 0 with parts placed: no output is driven yet, nothing to measure.
      if (m.depth !== null && (m.depth > 0 || !m.nand)) out.push(bar('Depth so far:', m.depth, par.depth));
      if (m.rows) out.push(h('p', { class: 'lv-rows' }, 'Rows right: ', m.rows.map((r, i) => [i ? ' · ' : '', h('b', { class: r.right === r.total ? 'ok' : '' }, `${r.out} ${r.right}/${r.total}`)])));
      meters.replaceChildren(...out);
    }, 0);
    const nav = h('div', { class: 'lv-walknav' },
      h('button', { class: 'btn sm', disabled: this.k === 0, onclick: () => this.go(this.k - 1) }, icon('chevL', 13), 'Back'),
      this.last ? h('button', { class: 'btn sm primary', onclick: close }, 'Done') : h('button', { class: 'btn sm primary', onclick: () => this.go(this.k + 1) }, 'Next', icon('chevR', 13)),
      h('span', { class: 'lv-spacer' }),
      h('button', { class: 'btn sm', title: 'Copy the circuit so far into your chip and finish it yourself (one undo step)', onclick: take }, this.last ? 'Use this answer' : 'I\'ll take it from here'));
    const modes = h('div', { class: 'lv-modes', role: 'tablist' },
      h('button', { class: this.mode === 'watch' ? 'on' : '', role: 'tab', onclick: () => this.setMode('watch') }, 'Watch'),
      h('button', { class: this.mode === 'build' ? 'on' : '', role: 'tab', title: 'Place each step\'s parts on their outlines and wire them yourself', onclick: () => this.setMode('build') }, 'Build along'));
    return h('div', { class: 'lv-walk' }, modes, learn.length ? h('div', { class: 'lv-chips lv-learn' }, h('span', { class: 'lv-learn-k' }, 'Learn it'), ...learn) : null, list, card, nav);
  }
}
