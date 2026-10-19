// The workbench: open any component from the library on its own, drive its inputs freely,
// and drill into it; "Open in Sandbox" (stage bar) copies it into the editor as a chip.

import { bench } from '../../chapters/types';
import { libraryItems, suggestItems } from '../../lib/catalog';
import { familyOf, resolveComponent } from '../../lib/resolve';
import { needsSwitchLevel } from '../../sim/harness';
import type { ComponentDef } from '../../sim/types';
import { netlistOf } from '../../sim/types';
import { Inspector } from '../../view/inspector';
import { Stage } from '../../view/stage';
import { memGridPanel } from '../../widgets/memgrid';
import { transistorLeaf } from '../../widgets/mosfet';
import { benchOpened, benchTabs } from '../benchtabs';
import { h, icon } from '../dom';
import { drillLanded, drillSegs, syncDrill } from '../drillpath';
import type { Page } from './chapter';

export class WorkbenchPage implements Page {
  readonly el: HTMLElement;
  private stage: Stage;
  private list: HTMLElement;
  private params: HTMLElement;
  private current = '';
  private filter = '';
  /** On a phone the library is a drawer above the stage, closed until this button opens it (app.css). */
  private libBtn: HTMLButtonElement;
  private libName: HTMLElement;
  /** Following the address bar (a route): the stage's moves are not new history entries. */
  private routing = false;

  constructor(id: string, path?: string[]) {
    const inspector = new Inspector();
    this.stage = new Stage(inspector);
    this.stage.leafFactory = transistorLeaf;
    const search = h('input', { type: 'search', placeholder: 'Search components…', 'aria-label': 'Search components' }) as HTMLInputElement;
    search.addEventListener('input', () => { this.filter = search.value.toLowerCase(); this.renderList(); });
    this.list = h('div', { class: 'lib-list' });
    this.params = h('div', { class: 'param-row', style: 'padding:0 12px 10px' });
    const lib = h('aside', { class: 'library', id: 'bench-library' }, benchTabs('components'), search, this.params, this.list);
    this.libName = h('span', { class: 'bench-libname' });
    this.libBtn = h('button', { class: 'btn sm bench-libbtn', 'aria-controls': 'bench-library', 'aria-expanded': 'false', title: 'Show or hide the component library',
      onclick: () => this.showLibrary(!this.el.classList.contains('lib-open')) }, icon('menu', 15), h('b', null, 'Components'), this.libName, icon('chevD', 14)) as HTMLButtonElement;
    this.el = h('div', { class: 'bench' }, this.libBtn, lib, this.stage.el, inspector.el);
    // Each level opened is a history entry (ui/drillpath.ts): #/workbench/<id>/<instance>/…
    this.stage.onNavigate(() => {
      if (this.current) syncDrill(this.hash(), this.routing);
    });
    this.open(id || 'rca4', path);
  }

  private hash(): string {
    return `#/workbench/${this.current}${drillSegs(this.stage.targetPath)}`;
  }

  /** The route: `id` and the drill path after it (undefined: the top level). */
  route(id: string, path?: string[]): void {
    if (drillLanded()) {
      // our own step back (Up, a breadcrumb) arrived: the stage is there, or has moved on since
      syncDrill(this.hash());
      return;
    }
    this.open(id, path, true);
  }

  private showLibrary(on: boolean): void {
    this.el.classList.toggle('lib-open', on);
    this.libBtn.setAttribute('aria-expanded', String(on));
  }

  /** `fromRoute`: following the address bar, so the stage's move corrects the entry rather than adding one. */
  open(id: string, path?: string[], fromRoute = false): void {
    // A pick in the phone's drawer closes it, the circuit comes back into view.
    if (this.el?.classList.contains('lib-open')) this.showLibrary(false);
    const def = resolveComponent(id);
    if (def && def.id === this.current && this.stage.target) {
      // the part on the stage already: only the drill path moved (Back / Forward, a link, the Parts tab), or the
      // library's pick of it again goes back to its top level
      this.routing = fromRoute;
      try {
        this.stage.openPath(path ?? []);
      } finally {
        this.routing = false;
      }
      if (fromRoute) syncDrill(this.hash(), true);
      return;
    }
    if (!def) {
      // A stale or mistyped link: say so, offer the closest parts, and keep the library list to pick from.
      const near = suggestItems(id);
      this.current = '';
      this.stage.showWidget({ el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
        h('h3', null, 'Unknown component'),
        h('p', { class: 'sub' }, `No component called "${id}". ${near.length ? 'Did you mean:' : 'Pick one from the library list, or search it.'}`),
        near.length ? h('div', { class: 'suggest' }, near.map((it) => h('button', { class: 'btn', onclick: () => this.open(it.id) }, it.name))) : null)) });
      this.renderParams();
      this.renderList();
      this.showLibrary(true); // a phone: the list to pick from, opened
      return;
    }
    this.current = def.id;
    this.libName.textContent = def.name;
    benchOpened(def.id, this.el);
    // Primitives and transistor-level parts are shown inside a test bench so they can be opened.
    const root: ComponentDef = def.prim === 'nand' || def.prim === 'nmos' || def.prim === 'pmos' || (!netlistOf(def) && !needsSwitchLevel(def))
      ? bench(def) : def;
    const panels = /^ram\d/.test(def.id) ? [memGridPanel] : [];
    // the 6502's active-low lines start inactive (else the chip sits in reset)
    const inputs = def.id === 'm6502_core' ? { resb: 1, irqb: 1, nmib: 1 } : undefined;
    this.stage.load({ root, panels, ...(inputs ? { inputs } : {}) }, path);
    // a different part replaces the entry, as it always did (its drill entries behind are another part's)
    const want = this.hash();
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

