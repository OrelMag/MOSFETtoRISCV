// "Inspect": the site's Inspector (what it is, what it costs, truth table, Verilog to read or
// download) for the chip being edited or one of its parts, in a drawer of the right-hand dock
// (dock.ts). Port values are live: they are read from the editor's simulation on repaints
// (at most a few times a second, and only when they changed).

import type { Bit, ComponentDef } from '../sim/types';
import { h, icon } from '../ui/dom';
import { settings } from '../ui/settings';
import { Inspector } from '../view/inspector';
import { dockPane, undockPane } from './dock';
import { isLevelChipId } from './levelgate';
import { type Editor, registerToolbarAction } from './editor';

const drawers = new WeakMap<Editor, InspectDrawer>();

/** Inspect a part of the current chip (by instance name), or the chip itself; `at`: open at this section. */
export function inspect(ed: Editor, part?: string, at?: InspectSection): void {
  drawers.get(ed)?.close();
  const d = new InspectDrawer(ed, part);
  drawers.set(ed, d);
  if (at) d.inspector.openAt(at);
}

/** Inspect a part deeper than the chip's own (look inside): no live values, it stays until closed. */
export function inspectDef(ed: Editor, def: ComponentDef, label: string, at?: InspectSection): void {
  drawers.get(ed)?.close();
  const d = new InspectDrawer(ed, undefined, { def, label });
  drawers.set(ed, d);
  if (at) d.inspector.openAt(at);
}

export type InspectSection = Parameters<Inspector['openAt']>[0];

class InspectDrawer {
  readonly el: HTMLElement;
  readonly inspector = new Inspector();
  private title: HTMLElement;
  private def: ComponentDef | null = null;
  private valKey = '';
  private last = 0;
  private readonly chip: string;
  /** A campaign level's chip. */
  private readonly noUsage: boolean;
  private readonly hook = () => this.tick();

  constructor(private ed: Editor, private part?: string, private fixed?: { def: ComponentDef; label: string }) {
    this.chip = ed.chipId;
    this.noUsage = !!ed.level || isLevelChipId(ed.chipId);
    this.title = h('h3', null);
    this.el = h('aside', { class: 'sb-drawer', 'aria-label': 'Inspector' },
      h('div', { class: 'sb-drawer-head' }, icon('table', 15), this.title,
        h('button', { class: 'btn ghost icon-only', title: 'Close', 'aria-label': 'Close the inspector', onclick: () => this.close() }, icon('close', 15))),
      this.inspector.el);
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    dockPane(ed, { id: 'inspect', label: 'Inspector', icon: 'table', el: this.el, width: 360 });
    ed.paintHooks.add(this.hook);
    this.tick(true);
  }

  private portBits = (p: string): Bit[] => {
    const sim = this.ed.sim.sim;
    if (!sim) return [];
    const node = this.part ? sim.design.root.children?.get(this.part) : sim.design.root;
    const nets = node?.ports[p];
    return nets ? sim.getBits(nets) : [];
  };

  private tick(force = false): void {
    const ed = this.ed;
    if (ed.chipId !== this.chip) return this.close();
    if (this.fixed) {
      if (this.def === this.fixed.def) return;
      this.def = this.fixed.def;
      this.title.textContent = this.fixed.label;
      this.inspector.show({ def: this.fixed.def, ...(this.noUsage ? { noUsage: true } : {}) });
      return;
    }
    const pd = this.part ? ed.doc.parts.find((p) => p.id === this.part) : undefined;
    if (this.part && !pd) return this.close();
    const def = pd ? ed.defOf(pd) : ed.compiled?.def;
    if (!def) return this.close();
    this.inspector.radix = settings.radix;
    if (def !== this.def) {
      this.def = def;
      this.title.textContent = this.part ? `${this.part} · ${def.name}` : def.name;
      this.inspector.show({ def, portBits: this.portBits, ...(this.part ? { instance: this.part } : {}), ...(this.noUsage ? { noUsage: true } : {}) });
      return;
    }
    const now = performance.now();
    if (!force && now - this.last < 250) return;
    this.last = now;
    const key = def.ports.map((p) => this.portBits(p.name).join('')).join('|');
    if (key === this.valKey) return;
    this.valKey = key;
    this.inspector.update();
  }

  close(): void {
    this.ed.paintHooks.delete(this.hook);
    if (drawers.get(this.ed) === this) {
      drawers.delete(this.ed);
      undockPane(this.ed, 'inspect');
    } else this.el.remove();
  }
}

registerToolbarAction({
  id: 'inspect', title: 'Inspect the selected part, or this chip: info, truth table, Verilog', menu: 'Inspect', levelLabel: 'Inspect', icon: 'table', order: 70,
  run: (ed) => inspect(ed, ed.sel.parts?.length === 1 ? ed.sel.parts[0] : undefined),
});
