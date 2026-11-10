// The workbench: open any component from the library on its own, drive its inputs freely,
// and drill into it; "Open in Sandbox" (stage bar) copies it into the editor as a chip.

import { setPageTitle } from '../pagetitle';
import { bench } from '../../chapters/types';
import { libraryItems, suggestItems } from '../../lib/catalog';
import { familyOf, resolveComponent } from '../../lib/resolve';
import { needsSwitchLevel } from '../../sim/harness';
import type { ComponentDef } from '../../sim/types';
import { netlistOf } from '../../sim/types';
import { Inspector } from '../../view/inspector';
import { Stage } from '../../view/stage';
import { maybeCoach } from '../coachmarks';
import { transistorLeaf } from '../../widgets/mosfet';
import { benchOpened, benchTabs } from '../benchtabs';
import { h, icon } from '../dom';
import { bookmarkButton } from '../notesui';
import { drillLanded, drillSegs, syncDrill } from '../drillpath';
import type { Page } from './chapter';

export class WorkbenchPage implements Page {
  readonly kind = 'workbench';
  readonly el: HTMLElement;
  private stage: Stage;
  private inspector: Inspector;
  private list: HTMLElement;
  private params: HTMLElement;
  private current = '';
  private filter = '';
  /** On a phone the library is a drawer above the stage, closed until this button opens it (app.css). */
  private libBtn: HTMLButtonElement;
  private libName: HTMLElement;
  /** Save this component in My notes (ui/notes.ts). */
  private mark = h('div', { class: 'bench-mark' });
  /** Following the address bar (a route): the stage's moves are not new history entries. */
  private routing = false;
  private search!: HTMLInputElement;

  constructor(id: string, path?: string[]) {
    const inspector = this.inspector = new Inspector();
    this.stage = new Stage(inspector);
    this.stage.leafFactory = transistorLeaf;
    // the workbench follows the Load-dependent delay setting (a chapter's scenes stay on the unit model)
    this.stage.delayFromSetting = true;
    this.stage.onReady(() => maybeCoach('stage'));
    const search = h('input', { type: 'search', placeholder: 'Search components…', 'aria-label': 'Search components' }) as HTMLInputElement;
    search.addEventListener('input', () => { this.filter = search.value.toLowerCase(); this.renderList(); });
    // Enter opens the first hit
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const first = this.list.querySelector<HTMLButtonElement>('.lib-item');
      if (first) { e.preventDefault(); first.click(); }
    });
    this.search = search;
    this.list = h('div', { class: 'lib-list' });
    this.params = h('div', { class: 'param-row', style: 'padding:0 12px 10px' });
    const lib = h('aside', { class: 'library', id: 'bench-library' }, benchTabs('components'), this.mark, search, this.params, this.list);
    this.libName = h('span', { class: 'bench-libname' });
    this.libBtn = h('button', { class: 'btn sm bench-libbtn', 'aria-controls': 'bench-library', 'aria-expanded': 'false', title: 'Show or hide the component library',
      onclick: () => this.showLibrary(!this.el.classList.contains('lib-open')) }, icon('menu', 15), h('b', null, 'Components'), this.libName, icon('chevD', 14)) as HTMLButtonElement;
    // the page's heading for screen readers (the stage bar names the component)
    this.el = h('div', { class: 'bench' }, h('h1', { class: 'sr-only' }, 'Workbench'), this.libBtn, lib, this.stage.el, inspector.el);
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
    setPageTitle(def ? def.name : 'Unknown component', 'Workbench');
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
      // nothing to describe: the Info / Table / HDL pane would be three empty tabs
      this.el.classList.add('no-part');
      this.libName.textContent = '';
      this.mark.replaceChildren();
      this.stage.showWidget({ el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
        h('h3', null, 'Unknown component'),
        h('p', { class: 'sub' }, `No component called "${id}". ${near.length ? 'Did you mean:' : 'Pick one from the library list, or search it.'}`),
        near.length ? h('div', { class: 'suggest' }, near.map((it) => h('button', { class: 'btn', onclick: () => this.open(it.id) }, it.name))) : null)) });
      // the stage's last part is gone from view: its description must go too
      this.inspector.reset();
      this.renderParams();
      this.renderList();
      this.showLibrary(true); // a phone: the list to pick from, opened
      return;
    }
    this.el.classList.remove('no-part');
    this.current = def.id;
    this.libName.textContent = def.name;
    this.mark.replaceChildren(bookmarkButton({ kind: 'bench', id: def.id }, () => `Workbench · ${def.name}`));
    benchOpened(def.id, this.el);
    // Primitives and transistor-level parts are shown inside a test bench so they can be opened.
    const root: ComponentDef = def.prim === 'nand' || def.prim === 'nmos' || def.prim === 'pmos' || (!netlistOf(def) && !needsSwitchLevel(def))
      ? bench(def) : def;
    // the 6502's active-low lines start inactive (else the chip sits in reset)
    const inputs = def.id === 'm6502_core' ? { resb: 1, irqb: 1, nmib: 1 } : undefined;
    this.stage.load({ root, ...(inputs ? { inputs } : {}) }, path);
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
    // a label, so the selects read as the size of this part and not as filters of the list under them
    this.params.append(h('span', { class: 'param-k' }, 'Size of this part'));
    for (const p of f.fam.params) {
      const sel = h('select', { 'aria-label': p.name }) as HTMLSelectElement;
      for (const v of p.values) sel.append(h('option', { value: v, selected: v === f.values[p.name] }, p.label ? p.label(v) : `${v} ${v === 1 ? p.name.replace(/(\w+?)s\b/, '$1') : p.name}`));
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
    let any = false;
    for (const { title, items } of libraryItems()) {
      const shown = items.filter((i) => !this.filter || i.name.toLowerCase().includes(this.filter) || i.id.includes(this.filter));
      if (!shown.length) continue;
      any = true;
      l.append(h('div', { class: 'lib-cat' }, title));
      const fam = familyOf(this.current)?.fam;
      for (const it of shown) {
        const on = it.id === this.current || (!!it.family && familyOf(it.id)?.fam === fam);
        l.append(h('button', { class: `lib-item${on ? ' on' : ''}`, 'aria-current': on ? 'true' : null, onclick: () => this.open(it.id) }, it.name, it.family ? h('small', null, 'sizes') : null));
      }
    }
    if (!any) l.append(h('div', { class: 'lib-empty' }, `No component matches “${this.filter}”. `, h('button', { class: 'btn sm', onclick: () => { this.search.value = ''; this.filter = ''; this.renderList(); this.search.focus(); } }, 'Clear the search')));
    // the open part in view (a long list opens at the top otherwise)
    if (!this.filter) l.querySelector<HTMLElement>('.lib-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  /** The top bar's way back (ui/returnto.ts): the part on the bench. */
  returnLabel(): { label: string; short: string } {
    const name = resolveComponent(this.current)?.name ?? this.current;
    return { label: `Workbench: ${name}`, short: name };
  }

  destroy(): void {
    this.stage.destroy();
  }
}

