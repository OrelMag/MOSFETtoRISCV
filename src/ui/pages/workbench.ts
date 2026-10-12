// The workbench: open any component from the library on its own, drive its inputs freely,
// and drill into it; "Open in Sandbox" (stage bar) copies it into the editor as a chip.

import { bench } from '../../chapters/types';
import { libraryItems } from '../../lib/catalog';
import { familyOf, resolveComponent } from '../../lib/resolve';
import { needsSwitchLevel } from '../../sim/harness';
import type { ComponentDef } from '../../sim/types';
import { netlistOf } from '../../sim/types';
import { Inspector } from '../../view/inspector';
import { Stage } from '../../view/stage';
import { memGridPanel } from '../../widgets/memgrid';
import { transistorLeaf } from '../../widgets/mosfet';
import { benchOpened, benchTabs } from '../benchtabs';
import { h } from '../dom';
import type { Page } from './chapter';

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
    const lib = h('aside', { class: 'library' }, benchTabs('components'), search, this.params, this.list);
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
    benchOpened(def.id, this.el);
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
    for (const { title, items } of libraryItems()) {
      const shown = items.filter((i) => !this.filter || i.name.toLowerCase().includes(this.filter) || i.id.includes(this.filter));
      if (!shown.length) continue;
      l.append(h('div', { class: 'lib-cat' }, title));
      const fam = familyOf(this.current)?.fam;
      for (const it of shown) {
        const on = it.id === this.current || (!!it.family && familyOf(it.id)?.fam === fam);
        l.append(h('button', { class: `lib-item${on ? ' on' : ''}`, onclick: () => this.open(it.id) }, it.name, it.family ? h('small', null, 'n-bit') : null));
      }
    }
  }

  destroy(): void {
    this.stage.destroy();
  }
}

