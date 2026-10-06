// The workbench: open any component from the library on its own, drive its inputs freely,
// and drill into it. (The full wiring sandbox comes in a later phase.)

import { bench } from '../../chapters/types';
import { registry } from '../../lib';
import { families, familyOf, initialParams, resolveComponent } from '../../lib/resolve';
import { needsSwitchLevel } from '../../sim/harness';
import type { ComponentDef } from '../../sim/types';
import { netlistOf } from '../../sim/types';
import { Inspector } from '../../view/inspector';
import { Stage } from '../../view/stage';
import { memGridPanel } from '../../widgets/memgrid';
import { transistorLeaf } from '../../widgets/mosfet';
import { h } from '../dom';
import type { Page } from './chapter';

const CATS: [string, string][] = [
  ['transistor', 'Transistors'], ['cell', 'CMOS cells'], ['gate', 'Gates'], ['arithmetic', 'Arithmetic'],
  ['routing', 'Selection & routing'], ['sequential', 'Sequential'], ['memory', 'Memory'], ['cpu', 'Processor parts'],
  ['plumbing', 'Wiring & constants'],
];

// Single (non-family) components whose id contains a digit. Other ids with digits are generated
// widths (families, or internal parts such as the 33-bit rows of MUL32) and stay out of the list.
const FIXED = new Set(['nmos', 'pmos', 'cla4', 'mul32', 'sram6t', 'sramcol2', 'dram1t1c', 'arb2', 'btb16', 'fpu32', 'freectr32', 'plus4', 'plus4ks']);
const listed = (id: string) => FIXED.has(id) || (!/\d/.test(id.replace(/^(full_adder|half_adder)/, '')) && !id.startsWith('bench_') && !id.startsWith('pipe_'));

export class WorkbenchPage implements Page {
  readonly el: HTMLElement;
  private stage: Stage;
  private list: HTMLElement;
  private params: HTMLElement;
  private current = '';
  private filter = '';

  constructor(id: string) {
    const inspector = new Inspector();
    this.stage = new Stage(inspector);
    this.stage.leafFactory = transistorLeaf;
    const search = h('input', { type: 'search', placeholder: 'Search components…', 'aria-label': 'Search components' }) as HTMLInputElement;
    search.addEventListener('input', () => { this.filter = search.value.toLowerCase(); this.renderList(); });
    this.list = h('div', { class: 'lib-list' });
    this.params = h('div', { class: 'param-row', style: 'padding:0 12px 10px' });
    const lib = h('aside', { class: 'library' }, search, this.params, this.list);
    this.el = h('div', { class: 'bench' }, lib, this.stage.el, inspector.el);
    this.open(id || 'rca4');
  }

  open(id: string): void {
    const def = resolveComponent(id);
    if (!def) {
      this.stage.showWidget({ el: h('div', { class: 'widget' }, h('div', { class: 'panel' }, h('h3', null, 'Unknown component'), h('p', { class: 'sub' }, `No component called "${id}".`))) });
      return;
    }
    this.current = def.id;
    // Primitives and transistor-level parts are shown inside a test bench so they can be opened.
    const root: ComponentDef = def.prim === 'nand' || def.prim === 'nmos' || def.prim === 'pmos' || (!netlistOf(def) && !needsSwitchLevel(def))
      ? bench(def) : def;
    const panels = /^ram\d/.test(def.id) ? [memGridPanel] : [];
    this.stage.load({ root, panels });
    const want = `#/workbench/${def.id}`;
    if (location.hash !== want) history.replaceState(null, '', want);
    this.renderParams();
    this.renderList();
  }

  private renderParams(): void {
    this.params.replaceChildren();
    const f = familyOf(this.current);
    if (!f) return;
    for (const p of f.fam.params) {
      const sel = h('select', { 'aria-label': p.name }) as HTMLSelectElement;
      for (const v of p.values) sel.append(h('option', { value: v, selected: v === f.values[p.name] }, p.label ? p.label(v) : `${v} ${p.name}`));
      sel.addEventListener('change', () => {
        const values = { ...f.values, [p.name]: Number(sel.value) };
        this.open(f.fam.make(values).id);
      });
      this.params.append(sel);
    }
  }

  private renderList(): void {
    const l = this.list;
    l.replaceChildren();
    const statics = [...registry.values()].filter((d) => d.prim !== 'alias' && listed(d.id) && !familyOf(d.id));
    for (const [cat, title] of CATS) {
      const items: { id: string; name: string; tag?: string }[] = [];
      for (const d of statics) if (d.category === cat) items.push({ id: d.id, name: d.name });
      for (const f of families) if (f.category === cat) items.push({ id: f.key(initialParams(f)), name: f.name, tag: 'n-bit' });
      const shown = items.filter((i) => !this.filter || i.name.toLowerCase().includes(this.filter) || i.id.includes(this.filter));
      if (!shown.length) continue;
      l.append(h('div', { class: 'lib-cat' }, title));
      const fam = familyOf(this.current)?.fam;
      for (const it of shown) {
        const on = it.id === this.current || (!!it.tag && familyOf(it.id)?.fam === fam);
        l.append(h('button', { class: `lib-item${on ? ' on' : ''}`, onclick: () => this.open(it.id) }, it.name, it.tag ? h('small', null, it.tag) : null));
      }
    }
  }

  destroy(): void {
    this.stage.destroy();
  }
}

