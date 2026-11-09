// The Cut tool (docs/PLAN-ONI.md A, ONI's Disconnect): K or the toolbar's Cut, then drag a line across the canvas and every
// wire it crosses is cut there (cut.ts: a branched trunk is split, both sides kept). Crossed wires show while dragging; the
// release is one undo step; a click on a wire cuts it at that point. Esc, K again or the pill's Cancel leaves the mode.
// Not on a level screen unless the level lists 'cut'.

import { type Vec } from '../sim/geometry';
import { matches, shortcutAllowed } from '../ui/keys';
import { cutCrossings, cutWireNear, cutWires } from './cut';
import { type Editor, registerEditorPlugin, registerToolbarAction } from './editor';
import { hitWire } from './geom';

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

const allowed = (ed: Editor) => !ed.level || ed.level.actions.includes('cut');

class CutTool {
  on = false;
  private from: Vec | null = null;
  private off: (() => void)[] = [];

  constructor(private ed: Editor) {
    const key = (e: KeyboardEvent) => {
      // Esc first: the editor's own Esc (cancel, clear the selection) marks it handled, and it leaves this mode too
      if (e.key === 'Escape' && this.on && !typing(e.target)) return this.set(false);
      if (typing(e.target) || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.('.sb-help, .key-help')) return;
      if (matches(e, 'sb.cut') && shortcutAllowed(e) && allowed(ed)) { e.preventDefault(); this.set(!this.on); }
    };
    // the pill's Cancel (a touch screen's way out) also leaves the mode
    const pill = (e: Event) => { if ((e.target as Element | null)?.closest?.('.sb-mode-cancel') && this.on) this.set(false); };
    document.addEventListener('keydown', key);
    ed.el.addEventListener('click', pill);
    this.off.push(() => document.removeEventListener('keydown', key), () => ed.el.removeEventListener('click', pill));
  }

  set(on: boolean): void {
    if (on === this.on) return;
    const ed = this.ed;
    if (on) ed.tools.cancel(); // a part being placed or a wire begun gives way
    this.on = on;
    this.from = null;
    ed.view.showCut(null);
    ed.el.querySelector('.sb-canvas')?.classList.toggle('cutting', on);
    ed.tools.capture = on ? {
      down: (p) => { this.from = p; ed.view.showCut(p, p); return true; },
      move: (p) => { if (this.from) ed.view.showCut(this.from, p, cutCrossings(ed.doc, this.from, p, ed.defOf)); },
      up: (p, moved) => this.release(p, moved),
      cancel: () => { this.from = null; ed.view.showCut(null); },
    } : null;
    if (on) ed.showMode('Cut: drag a line across wires');
    else ed.endMode();
    ed.announce(on ? 'Cut tool on: drag a line across wires to cut them. Esc leaves.' : 'Cut tool off');
    ed.renderActions();
  }

  private release(p: Vec, moved: boolean): void {
    const ed = this.ed, a = this.from;
    this.from = null;
    ed.view.showCut(null);
    if (!a) return;
    let reason: string | undefined, cut = 0;
    if (moved) {
      const r = cutWires(ed.doc, a, p, ed.defOf);
      if (!r.reason) ed.edit(() => r.doc);
      reason = r.reason; cut = r.cut;
    } else {
      // a click: the wire under it, cut at the nearest point
      const w = hitWire(ed.doc, ed.defOf, p, Math.min(1.2, Math.max(0.35, ed.view.px(10))), ed.view.polys);
      if (!w) return;
      const r = cutWireNear(ed.doc, w.id, p, ed.defOf);
      if (!r.reason) ed.edit(() => r.doc);
      reason = r.reason; cut = r.reason ? 0 : 1;
    }
    if (reason) ed.toast(`Nothing cut: ${reason}.`);
    else ed.announce(`${cut} cut${cut > 1 ? 's' : ''}`);
  }

  destroy(): void {
    this.set(false);
    for (const f of this.off) f();
  }
}

const of = new WeakMap<Editor, CutTool>();

registerEditorPlugin((ed) => {
  const c = new CutTool(ed);
  of.set(ed, c);
  return () => c.destroy();
});

/** Turn the Cut tool on or off (the right-click menu, the search). */
export function toggleCut(ed: Editor): void {
  const c = of.get(ed);
  if (c && allowed(ed)) c.set(!c.on);
}

/** Cut one wire at a point (the wire's right-click menu): one undo step. */
export function cutWireHere(ed: Editor, id: string, at: Vec): void {
  const r = cutWireNear(ed.doc, id, at, ed.defOf);
  if (r.reason) ed.toast(`Nothing cut: ${r.reason}.`);
  else ed.edit(() => r.doc);
}

export const cutAllowed = allowed;

registerToolbarAction({
  id: 'cut', title: 'Cut tool (K): drag a line across wires to cut them where it crosses', icon: 'scissors', label: 'Cut', menu: 'Cut tool (K)', order: 57,
  run: (ed) => toggleCut(ed),
  active: (ed) => !!of.get(ed)?.on,
});
