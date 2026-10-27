// The right-hand drawer dock of the sandbox: the Inspector, the CPU panel and the challenge list
// are drawers (.sb-drawer) that share the right edge of the canvas. One shows at a time; with two
// or more, tabs above it switch between them. The dock tells the overlay how much room it takes
// (--dock-space), so the look-inside view (inside.ts) stops at its left edge instead of hiding
// under it.

import '../styles/sbdock.css';
import { h, icon } from '../ui/dom';
import type { Editor } from './editor';

export interface DockPane {
  /** One pane per id: docking an id again replaces its element. */
  id: string;
  label: string;
  icon: string;
  /** The drawer (an `aside.sb-drawer`). */
  el: HTMLElement;
  /** Preferred width in px (default 360). */
  width?: number;
}

class Dock {
  readonly host: HTMLElement;
  private tabs: HTMLElement;
  private panes: DockPane[] = [];
  private active = '';
  /** What had the focus when each pane opened: closing a pane that holds the focus gives it back there. */
  private openers = new Map<string, HTMLElement>();

  constructor(private ed: Editor) {
    this.tabs = h('div', { class: 'sb-dock-tabs', role: 'tablist', 'aria-label': 'Side panels' });
    this.host = h('div', { class: 'sb-dock' }, this.tabs);
  }

  /** Dock a drawer; `front` false (one opening by itself) keeps the drawer already shown in front. */
  add(p: DockPane, front = true): void {
    const old = this.panes.find((q) => q.id === p.id);
    if (old && old.el !== p.el) old.el.remove();
    const a = document.activeElement;
    if (!old && a instanceof HTMLElement && a !== document.body && !p.el.contains(a)) this.openers.set(p.id, a);
    this.panes = [...this.panes.filter((q) => q.id !== p.id), p];
    p.el.classList.add('sb-docked');
    this.host.append(p.el);
    if (front || !this.has(this.active) || this.active === p.id) this.show(p.id);
    else this.render();
  }

  remove(id: string): void {
    const p = this.panes.find((q) => q.id === id);
    if (!p) return;
    const focused = p.el.contains(document.activeElement);
    const opener = this.openers.get(id);
    this.openers.delete(id);
    p.el.remove();
    this.panes = this.panes.filter((q) => q !== p);
    if (this.active === id) this.active = this.panes[this.panes.length - 1]?.id ?? '';
    this.render();
    if (!focused) return;
    // the opener, or its twin if the toolbar was redrawn since (same data-action), else the canvas
    const act = opener?.dataset.action;
    const back = opener?.isConnected ? opener : act ? this.ed.el.querySelector<HTMLElement>(`[data-action="${CSS.escape(act)}"]:not([hidden])`) : null;
    (back ?? this.ed.view.svg).focus({ preventScroll: true });
  }

  has(id: string): boolean {
    return this.panes.some((p) => p.id === id);
  }

  isActive(id: string): boolean {
    return this.active === id && this.has(id);
  }

  show(id: string): void {
    if (!this.has(id)) return;
    this.active = id;
    this.render();
  }

  /** A view still as fitted follows the room the dock leaves (a CPU drawer opening by itself). */
  private refit(): void {
    const space = this.ed.slots.overlay.style.getPropertyValue('--dock-space');
    if (space !== this.space && this.ed.view.cam.fitted) this.ed.fitView();
    this.space = space;
  }

  private space = '';

  private render(): void {
    const overlay = this.ed.slots.overlay;
    const cur = this.panes.find((p) => p.id === this.active);
    if (!cur) {
      this.host.remove();
      overlay.style.removeProperty('--dock-space');
      overlay.parentElement?.style.removeProperty('--toast-dock');
      this.refit();
      this.ed.renderActions();
      return;
    }
    if (this.host.parentElement !== overlay) overlay.append(this.host);
    const w = cur.width ?? 360;
    this.host.style.setProperty('--dock-w', `${w}px`);
    overlay.style.setProperty('--dock-space', `${w + 16}px`);
    // the toast is the overlay's sibling: it centres in the room the drawer leaves (not over the drawer's title)
    overlay.parentElement?.style.setProperty('--toast-dock', `${w + 16}px`);
    this.refit();
    for (const p of this.panes) p.el.hidden = p !== cur;
    this.tabs.hidden = this.panes.length < 2;
    this.tabs.replaceChildren(...this.panes.map((p) => h('button', {
      class: `sb-dock-tab${p === cur ? ' on' : ''}`, role: 'tab', 'aria-selected': String(p === cur), title: p.label,
      onclick: () => this.show(p.id),
    }, icon(p.icon, 13), h('span', null, p.label))));
    this.ed.renderActions();
  }
}

const docks = new WeakMap<Editor, Dock>();
const dockOf = (ed: Editor) => docks.get(ed) ?? (docks.set(ed, new Dock(ed)), docks.get(ed)!);

/** Put a drawer in the dock and show it (`front` false: behind the drawer shown, if any). */
export const dockPane = (ed: Editor, p: DockPane, front = true): void => dockOf(ed).add(p, front);
/** Take a drawer out of the dock. */
export const undockPane = (ed: Editor, id: string): void => dockOf(ed).remove(id);
/** Show a docked drawer (its tab). */
export const showPane = (ed: Editor, id: string): void => dockOf(ed).show(id);
export const paneDocked = (ed: Editor, id: string): boolean => dockOf(ed).has(id);
export const paneShown = (ed: Editor, id: string): boolean => dockOf(ed).isActive(id);
