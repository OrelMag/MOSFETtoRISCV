// The level screen's walkthrough: the reference answer built one step at a time (campaign/walk.ts)
// on a scratch chip of its own, so the learner's drawing is never touched. The chips the answer
// places come in once (renamed if their ids are taken) and the scratch chip refers to them through
// those names. Each step redraws the scratch chip and selects what the step added. "I'll take it
// from here" copies the partial circuit into the level's chip (one undo step); leaving removes the
// scratch chip and the chips it brought, unless the learner took them.

import { codexById } from '../../campaign/codex';
import { stepMetrics, partialDoc, type StepMetrics, type Walk, walkOf } from '../../campaign/walk';
import type { CampaignNode } from '../../campaign/types';
import type { BuildChallenge } from '../../editor/challenges';
import type { Editor } from '../../editor/editor';
import type { ChipDoc, Workspace } from '../../editor/model';
import { openChip } from '../../editor/session';
import { importChips } from '../../editor/store';
import { h, icon } from '../dom';

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

  private show(ws: Workspace, first = false): void {
    const ed = this.ed;
    const next = openChip({ ...ws, chips: { ...ws.chips, [this.scratchId]: this.docAt(this.k) } }, this.scratchId);
    ed.volatile(next);
    const s = this.walk.steps[this.k];
    ed.select({ parts: [...s.parts], wires: [...s.wires], labels: [...s.labels] });
    if (first) ed.fitView();
    this.changed();
  }

  go(k: number): void {
    this.k = Math.max(0, Math.min(k, this.walk.steps.length - 1));
    this.show(this.ed.ws);
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
  }

  // ---- the side panel ----------------------------------------------------------------------------

  panel(par: { nand?: number; depth?: number }, close: () => void, take: () => void): HTMLElement {
    const w = this.walk, s = w.steps[this.k];
    const list = h('ol', { class: 'lv-steps' }, w.steps.map((st, i) => h('li', { class: i < this.k ? 'done' : i === this.k ? 'cur' : '' },
      h('button', { onclick: () => this.go(i), title: `Go to step ${i + 1}` }, h('span', { class: 'k' }, i < this.k ? icon('check', 11) : String(i + 1)), h('span', null, st.title)))));
    const meters = h('div', { class: 'lv-meters' }, h('p', { class: 'sub' }, 'Measuring…'));
    const card = h('section', { class: 'lv-step' },
      h('h3', null, `Step ${this.k + 1} of ${w.steps.length} · ${s.title}`),
      h('p', null, s.text),
      s.codex.length ? h('div', { class: 'lv-chips' }, s.codex.map((id) => codexById(id)).filter((e) => !!e).map((e) => h('a', { class: 'lv-chip acc', href: `#/campaign/codex/${e!.id}` }, `Codex: ${e!.title}`))) : null,
      meters,
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
    return h('div', { class: 'lv-walk' }, list, card, nav);
  }
}
