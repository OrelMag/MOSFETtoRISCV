// The stage's Why? card: in Why mode a click on a wire explains its value at the level on screen
// (sim/explain.ts: the cause chain, the parts on it lit), and its second tab says what each part
// of the level is for (sim/ablate.ts: every part removed in turn against the whole truth table).
// Values follow the simulation: the explanation is redone after every update.

import { ablate, roleText, type Ablation } from '../sim/ablate';
import { acrossRim, explainNets, portValue, type Crossing, type WhyStep } from '../sim/explain';
import { netlistOf } from '../sim/types';
import { h, icon, tx } from '../ui/dom';
import type { ViewCtx } from './context';

export interface WhyHost {
  ctx(): ViewCtx | null;
  /** Light these instances of the level on screen (focus: fade the rest); [] puts the scene's own highlight back. */
  light(names: string[]): void;
  selectNet(idx: number): void;
  /** Mode switched: the stage keeps its button, cursor and the probe mode in step. */
  toggled(on: boolean): void;
  /** The zoom lens open over the level (view/lens.ts), or null: a trace crosses its rim (DESIGN.md track 2b). */
  lens?(): LensSide | null;
}

/** An open lens as the card sees it: its level, its box's name on the level on screen, lighting and selecting inside. */
export interface LensSide {
  ctx: ViewCtx;
  box: string;
  /** Light these parts inside the lens ([]: none). */
  light(names: string[]): void;
  selectNet(idx: number): void;
}

/** Which level the card speaks of: the one on screen, or the open lens's. */
export type WhyAt = 'stage' | 'lens';

/** What each part of a level is for: the same table on a drilled level and in a lens showing it. */
export const levelAblation = (ctx: ViewCtx): Ablation | string => ablate(ctx.node.def);

type Tab = 'wire' | 'parts';

/** Steps a trace shows before "Show more". */
const SHOWN = 12;

export class WhyPanel {
  readonly el: HTMLElement;
  on = false;
  private tab: Tab = 'wire';
  /** The net explained (an index into the level's netlist), or -1. */
  private net = -1;
  /** Every step of a long trace shown (until another wire is clicked). */
  private all = false;
  private body: HTMLElement;
  private tabs: Record<Tab, HTMLButtonElement>;
  /** The level of the wire explained and of the parts table. */
  private at: WhyAt = 'stage';
  /** A part to light in the parts table (Break a part on it). */
  private part: string | null = null;

  constructor(private host: WhyHost) {
    const tab = (t: Tab, label: string) => h('button', { role: 'tab', 'aria-selected': 'false', onclick: () => this.show(t) }, label) as HTMLButtonElement;
    this.tabs = { wire: tab('wire', 'This wire'), parts: tab('parts', 'Each part') };
    this.body = h('div', { class: 'why-body', 'aria-live': 'polite' });
    this.el = h('aside', { class: 'why-card', hidden: true, 'aria-label': 'Why?' },
      h('header', null,
        h('b', null, 'Why?'),
        h('div', { class: 'seg why-tabs', role: 'tablist' }, this.tabs.wire, this.tabs.parts),
        h('button', { class: 'btn ghost icon-only', title: 'Close (Esc)', 'aria-label': 'Close Why?', onclick: () => this.setOn(false) }, icon('close', 14))),
      this.body);
  }

  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.el.hidden = !on;
    if (!on) this.clear();
    else this.render();
    this.host.toggled(on);
  }

  /** In Why mode a click on a wire explains it instead of selecting it. */
  netClick(idx: number, at: WhyAt = 'stage'): boolean {
    if (!this.on) return false;
    this.all = this.all && idx === this.net && at === this.at;
    this.net = idx;
    this.at = at;
    this.show('wire');
    return true;
  }

  /** Break a part: the parts table of a level (the lens's from its menu), the part named lit. */
  showParts(at: WhyAt, part: string | null = null): void {
    this.at = at;
    this.part = part;
    if (!this.on) this.setOn(true);
    this.show('parts');
  }

  /** The level on screen changed: its nets are others. */
  levelChanged(): void {
    this.net = -1;
    this.at = 'stage';
    if (this.on) this.render();
  }

  /** A lens opened or closed: a trace inside a closed one is gone; one outside may now cross into it. */
  lensChanged(): void {
    if (this.at === 'lens') {
      this.net = -1;
      this.at = 'stage';
      this.part = null;
    }
    if (this.on) this.render();
  }

  /** After every update of the stage: the values may have moved. */
  update(): void {
    if (this.on && this.tab === 'wire' && this.net >= 0) this.render();
  }

  private clear(): void {
    this.net = -1;
    this.at = 'stage';
    this.part = null;
    this.lightBoth([], []);
    this.host.selectNet(-1);
    this.host.lens?.()?.selectNet(-1);
  }

  /** The open lens, if it shows a child of the level on screen. */
  private lens(): LensSide | null {
    const l = this.host.lens?.() ?? null;
    return l && l.ctx.parent === this.host.ctx() ? l : null;
  }

  /** Parts lit on the level on screen and inside the lens. */
  private lightBoth(outer: string[], inner: string[]): void {
    this.host.light(outer);
    this.host.lens?.()?.light(inner);
  }

  private show(t: Tab): void {
    this.tab = t;
    this.render();
  }

  private render(): void {
    for (const [t, b] of Object.entries(this.tabs)) b.setAttribute('aria-selected', String(t === this.tab));
    if (this.tab === 'wire') this.renderWire();
    else this.renderParts();
  }

  private renderWire(): void {
    const lens = this.lens();
    if (this.at === 'lens' && !lens) this.at = 'stage';
    const inLens = this.at === 'lens';
    const ctx = inLens ? lens!.ctx : this.host.ctx();
    const nets = ctx?.node.nets?.[this.net];
    if (!ctx || this.net < 0 || !nets?.length) {
      this.lightBoth([], []);
      this.body.replaceChildren(h('p', { class: 'why-hint' }, 'Click a wire: its value is traced back, gate by gate or block by block, to the inputs that decide it.'));
      return;
    }
    const sim = ctx.sim;
    if (sim.kind !== 'gate') {
      this.body.replaceChildren(h('p', { class: 'why-hint' }, 'This level is solved at switch level: the transistors decide together, so there is no single cause to follow. Go up a level to trace gates.'));
      return;
    }
    // A bus: every bit traced, folded together (the same child port collects its bits).
    const { steps, lines } = explainNets(sim, nets, ctx.node);
    // a trace reaching the lens's rim goes on across it (DESIGN.md item 5); a switch-level other side has no causes to give
    const outer = this.host.ctx();
    const other = lens && outer && (inLens ? outer.sim : lens.ctx.sim).kind === 'gate' ? lens : null;
    const cross: Crossing[] = other && outer
      ? acrossRim(steps, inLens ? 'inner' : 'outer', { sim: other.ctx.sim, node: other.ctx.node }, { sim: outer.sim, node: outer.node }, other.box)
      : [];
    const instsOf = (st: readonly WhyStep[]) => [...new Set(st.map((s) => s.inst).filter((x): x is string => !!x))];
    const here = instsOf(steps), there = instsOf(cross.flatMap((c) => c.steps));
    // this side's parts and the other side's, each lit in its own view
    const lightAll = () => (inLens ? this.lightBoth(there, here) : this.lightBoth(here, there));
    const lightOne = (inst: string | null, across: boolean) => {
      if (!inst) return lightAll();
      if (inLens !== across) this.lightBoth([], [inst]);
      else this.lightBoth([inst], []);
    };
    if (inLens) {
      this.host.selectNet(-1);
      lens!.selectNet(this.net);
    } else {
      this.host.selectNet(this.net);
      lens?.selectNet(-1);
    }
    lightAll();
    const nd = netlistOf(ctx.node.def)?.nets[this.net];
    const name = nd?.name ?? nd?.ends.find((e) => !e.includes('.')) ?? nd?.ends[0] ?? 'this wire';
    // this level's steps, then each crossing's under a line saying where it goes; a long trace shows its first SHOWN steps
    type Row = { head: HTMLElement } | { step: WhyStep; line: string; across: boolean };
    const rows: Row[] = steps.map((s, i) => ({ step: s, line: lines[i], across: false }));
    for (const c of cross) {
      const where = inLens
        ? ['Across the rim, ', h('code', null, `${lens!.box}.${c.port}`), ' on the level outside:']
        : ['Inside ', h('code', null, lens!.box), ', open: ', h('code', null, c.port), ' comes from'];
      rows.push({ head: h('li', { class: 'why-rim' }, ...where) }, ...c.steps.map((s, i) => ({ step: s, line: c.lines[i], across: true })));
    }
    const total = rows.filter((r) => 'step' in r).length;
    const shown = this.all ? total : Math.min(total, SHOWN);
    let n = 0;
    const items: HTMLElement[] = [];
    for (const r of rows) {
      if (n >= shown) break;
      if ('head' in r) { items.push(r.head); continue; }
      const { step: s, across } = r;
      const li = h('li', { tabindex: 0, 'data-kind': s.kind, ...(across ? { 'data-across': '' } : {}) },
        h('span', { class: 'why-n' }, String(++n)), h('span', null, r.line));
      li.addEventListener('pointerenter', () => lightOne(s.inst, across));
      li.addEventListener('focus', () => lightOne(s.inst, across));
      li.addEventListener('pointerleave', lightAll);
      li.addEventListener('blur', lightAll);
      items.push(li);
    }
    this.body.replaceChildren(
      h('p', { class: 'why-q' }, 'Why is ', h('code', null, inLens ? `${lens!.box}: ${name}` : name), ` ${portValue(sim, nets)}?`),
      h('ol', { class: 'why-chain' }, ...items),
      ...(shown < total ? [h('button', { class: 'btn ghost sm why-more', onclick: () => { this.all = true; this.render(); } }, `Show ${total - shown} more`)] : []),
      h('p', { class: 'why-hint' }, tx('Hover a line to light its part. Open a box to follow the trace inside it.', 'Open a box to follow the trace inside it.')));
  }

  private renderParts(): void {
    const lens = this.lens();
    if (this.at === 'lens' && !lens) this.at = 'stage';
    const inLens = this.at === 'lens';
    const ctx = inLens ? lens!.ctx : this.host.ctx();
    this.host.selectNet(-1);
    lens?.selectNet(-1);
    if (!ctx) return void this.body.replaceChildren();
    const a = levelAblation(ctx);
    const light = (inst: string | null) => {
      const on = inst ? [inst] : this.part ? [this.part] : [];
      if (inLens) this.lightBoth([], on);
      else this.lightBoth(on, []);
    };
    if (typeof a === 'string') {
      this.lightBoth([], []);
      this.body.replaceChildren(h('p', { class: 'why-hint' }, `Not for ${inLens ? `the inside of ${lens!.box}` : 'this level'}: ${a}. Open a smaller block to see what each of its parts is for.`));
      return;
    }
    light(null);
    this.body.replaceChildren(
      h('p', { class: 'why-q' }, ...(inLens ? ['Inside ', h('code', null, lens!.box), `: each part removed in turn, over all ${a.rows} rows of its truth table:`] : [`Each part removed in turn, over all ${a.rows} rows of the truth table:`])),
      partsTable(a, light, this.part),
      h('p', { class: 'why-hint' }, tx("Removed: the part's outputs left open. Hover a row to light the part; its title gives the rows wrong with the output held at 0 and at 1.", "Removed: the part's outputs left open.")));
  }
}

function partsTable(a: Ablation, light: (inst: string | null) => void, mark: string | null = null): HTMLElement {
  const rows = a.parts.map((p) => {
    const cells = a.outputs.map((o) => h('td', { class: p.wrong.open[o] ? 'bad' : 'muted' }, `${p.wrong.open[o]}`));
    const tip = FAULT_TIP(p, a);
    const tr = h('tr', { tabindex: 0, title: tip, ...(p.inst === mark ? { class: 'why-mark' } : {}) }, h('td', null, h('code', null, p.inst)), ...cells, h('td', null, roleText(p, a.outputs)));
    tr.addEventListener('pointerenter', () => light(p.inst));
    tr.addEventListener('focus', () => light(p.inst));
    tr.addEventListener('pointerleave', () => light(null));
    return tr;
  });
  return h('div', { class: 'why-table' }, h('table', null,
    h('thead', null, h('tr', null, h('th', null, 'Removed'), ...a.outputs.map((o) => h('th', null, `${o} wrong`)), h('th', null, 'So it is for'))),
    h('tbody', null, ...rows)));
}

const FAULT_TIP = (p: Ablation['parts'][number], a: Ablation) =>
  a.outputs.map((o) => `${o}: held at 0 → ${p.wrong.stuck0[o]} rows wrong, at 1 → ${p.wrong.stuck1[o]}`).join('\n');
