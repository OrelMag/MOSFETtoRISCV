// The stage's Why? card: in Why mode a click on a wire explains its value at the level on screen
// (sim/explain.ts: the cause chain, the parts on it lit), and its second tab says what each part
// of the level is for (sim/ablate.ts: every part removed in turn against the whole truth table).
// Values follow the simulation: the explanation is redone after every update.

import { ablate, roleText, type Ablation } from '../sim/ablate';
import { explainNets, portValue } from '../sim/explain';
import { netlistOf } from '../sim/types';
import { h, icon } from '../ui/dom';
import type { ViewCtx } from './context';

export interface WhyHost {
  ctx(): ViewCtx | null;
  /** Light these instances of the level on screen (focus: fade the rest); [] puts the scene's own highlight back. */
  light(names: string[]): void;
  selectNet(idx: number): void;
  /** Mode switched: the stage keeps its button, cursor and the probe mode in step. */
  toggled(on: boolean): void;
}

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
  netClick(idx: number): boolean {
    if (!this.on) return false;
    this.all = this.all && idx === this.net;
    this.net = idx;
    this.show('wire');
    return true;
  }

  /** The level on screen changed: its nets are others. */
  levelChanged(): void {
    this.net = -1;
    if (this.on) this.render();
  }

  /** After every update of the stage: the values may have moved. */
  update(): void {
    if (this.on && this.tab === 'wire' && this.net >= 0) this.render();
  }

  private clear(): void {
    this.net = -1;
    this.host.light([]);
    this.host.selectNet(-1);
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
    const ctx = this.host.ctx();
    const nets = ctx?.node.nets?.[this.net];
    if (!ctx || this.net < 0 || !nets?.length) {
      this.host.light([]);
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
    const insts = [...new Set(steps.map((s) => s.inst).filter((x): x is string => !!x))];
    this.host.selectNet(this.net);
    this.host.light(insts);
    const nd = netlistOf(ctx.node.def)?.nets[this.net];
    const name = nd?.name ?? nd?.ends.find((e) => !e.includes('.')) ?? nd?.ends[0] ?? 'this wire';
    // a long trace shows its first SHOWN steps, the rest on request
    const shown = this.all ? steps.length : Math.min(steps.length, SHOWN);
    const list = h('ol', { class: 'why-chain' }, ...steps.slice(0, shown).map((s, i) => {
      const li = h('li', { tabindex: 0, 'data-kind': s.kind },
        h('span', { class: 'why-n' }, String(i + 1)), h('span', null, lines[i]));
      const lit = () => this.host.light(s.inst ? [s.inst] : insts);
      li.addEventListener('pointerenter', lit);
      li.addEventListener('focus', lit);
      li.addEventListener('pointerleave', () => this.host.light(insts));
      li.addEventListener('blur', () => this.host.light(insts));
      return li;
    }));
    this.body.replaceChildren(
      h('p', { class: 'why-q' }, `Why is `, h('code', null, name), ` ${portValue(sim, nets)}?`),
      list,
      ...(shown < steps.length ? [h('button', { class: 'btn ghost sm why-more', onclick: () => { this.all = true; this.render(); } }, `Show ${steps.length - shown} more`)] : []),
      h('p', { class: 'why-hint' }, 'Hover a line to light its part. Open a box to follow the trace inside it.'));
  }

  private renderParts(): void {
    const ctx = this.host.ctx();
    this.host.selectNet(-1);
    if (!ctx) return void this.body.replaceChildren();
    const a = ablate(ctx.node.def);
    if (typeof a === 'string') {
      this.host.light([]);
      this.body.replaceChildren(h('p', { class: 'why-hint' }, `Not for this level: ${a}. Open a smaller block to see what each of its parts is for.`));
      return;
    }
    this.body.replaceChildren(
      h('p', { class: 'why-q' }, `Each part removed in turn, over all ${a.rows} rows of the truth table:`),
      partsTable(a, (inst) => this.host.light(inst ? [inst] : [])),
      h('p', { class: 'why-hint' }, 'Removed: the part\'s outputs left open. Hover a row to light the part; its title gives the rows wrong with the output held at 0 and at 1.'));
  }
}

function partsTable(a: Ablation, light: (inst: string | null) => void): HTMLElement {
  const rows = a.parts.map((p) => {
    const cells = a.outputs.map((o) => h('td', { class: p.wrong.open[o] ? 'bad' : 'muted' }, `${p.wrong.open[o]}`));
    const tip = FAULT_TIP(p, a);
    const tr = h('tr', { tabindex: 0, title: tip }, h('td', null, h('code', null, p.inst)), ...cells, h('td', null, roleText(p, a.outputs)));
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
