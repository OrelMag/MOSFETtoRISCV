// The workbench: open any component from the library on its own, drive its inputs freely,
// and drill into it. (The full wiring sandbox comes in a later phase.)

import { bench } from '../../chapters/types';
import { registry } from '../../lib';
import { families, type Family, resolveComponent } from '../../lib/resolve';
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
  ['routing', 'Selection & routing'], ['sequential', 'Sequential'], ['memory', 'Memory'],
];

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
    const panels = def.category === 'memory' ? [memGridPanel] : [];
    this.stage.load({ root, panels });
    const want = `#/workbench/${def.id}`;
    if (location.hash !== want) history.replaceState(null, '', want);
    this.renderParams();
    this.renderList();
  }

  private familyOf(id: string): { fam: Family; values: Record<string, number> } | null {
    if (!familyIndex) {
      familyIndex = new Map();
      for (const fam of families) for (const combo of combos(fam)) familyIndex.set(fam.make(combo).id, { fam, values: combo });
    }
    return familyIndex.get(id) ?? null;
  }

  private renderParams(): void {
    this.params.replaceChildren();
    const f = this.familyOf(this.current);
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
    const statics = [...registry.values()].filter((d) => d.prim !== 'alias' && !/\d/.test(d.id.replace(/^(full_adder|half_adder)/, '')) || ['nmos', 'pmos'].includes(d.id));
    for (const [cat, title] of CATS) {
      const items: { id: string; name: string; tag?: string }[] = [];
      for (const d of statics) if (d.category === cat && !d.id.startsWith('bench_')) items.push({ id: d.id, name: d.name });
      for (const f of families) if (f.category === cat) {
        const initial = Object.fromEntries(f.params.map((p) => [p.name, p.initial]));
        items.push({ id: f.make(initial).id, name: f.name, tag: 'n-bit' });
      }
      const shown = items.filter((i) => !this.filter || i.name.toLowerCase().includes(this.filter) || i.id.includes(this.filter));
      if (!shown.length) continue;
      l.append(h('div', { class: 'lib-cat' }, title));
      const fam = this.familyOf(this.current)?.fam;
      for (const it of shown) {
        const on = it.id === this.current || (fam && it.tag && families.find((f) => f.name === it.name) === fam);
        l.append(h('button', { class: `lib-item${on ? ' on' : ''}`, onclick: () => this.open(it.id) }, it.name, it.tag ? h('small', null, it.tag) : null));
      }
    }
  }

  destroy(): void {
    this.stage.destroy();
  }
}

let familyIndex: Map<string, { fam: Family; values: Record<string, number> }> | null = null;

function combos(f: Family): Record<string, number>[] {
  let out: Record<string, number>[] = [{}];
  for (const p of f.params) out = out.flatMap((o) => p.values.map((v) => ({ ...o, [p.name]: v })));
  return out;
}
