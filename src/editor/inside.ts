// Look inside: any placed part (a library part or a user chip) opens over the canvas (read-only but for a library part's wires, view/layout.ts),
// on the editor's own running simulation. The root ViewCtx wraps EditorSim's simulator and its
// flattened root, so a part expanded by the flatten shows the very nets the editor simulates,
// and a primitive (a NAND at gate level) opens onto a lock-step sub-simulation of its inside
// driven by the parent's values (view/context.ts). Every repaint of the editor (paintHooks)
// syncs and redraws it, so values stay live while the circuit runs; double-click keeps drilling
// down to transistors. A structural edit rebuilds the simulator: the view reattaches to the new
// one at the same path, as far as it still exists. It sits beside the circuit (which stays
// usable: toggle its inputs and watch the inside follow), or over all of it.

import type { Sim } from '../sim/sim';
import { netlistOf } from '../sim/types';
import { h, hintBadge, icon, s } from '../ui/dom';
import { isMenuKey } from '../ui/menu';
import { ViewCtx } from '../view/context';
import { type CrumbValue, crumbTitle, crumbValues, paintCrumbVals } from '../view/crumbvals';
import { SchematicView } from '../view/schematic';
import { WhyPanel } from '../view/whypanel';
import type { Widget } from '../view/stage';
import { modelLeaf } from '../widgets/modelleaf';
import { transistorLeaf } from '../widgets/mosfet';
import type { Editor } from './editor';
import { drawFace, type FaceEls, paintFace } from './dispface';
import { faceOf } from './face';
import { decorateInside, toggleSwitch } from './ioface';

const views = new WeakMap<Editor, InsideView>();
/** Instances to light at one path (the CPU drawer: the units an instruction uses inside a placed core). */
const wanted = new WeakMap<Editor, { path: string; names: string[] }>();

/** Light `names` in the look-inside view when it shows the part `path` (an empty list, or another path, lets go). */
export function lightInside(ed: Editor, path: string, names: string[]): void {
  if (names.length) wanted.set(ed, { path, names });
  else wanted.delete(ed);
  views.get(ed)?.applyLight();
}

/** Open the inside of a part of the chip being edited (`path`: instance names from the chip). */
export function lookInside(ed: Editor, path: string[]): void {
  ed.sim.flush();
  const sim = ed.sim.sim;
  if (!sim) return void ed.toast('This chip is not simulated yet: see the problems listed in the properties', 'err');
  const node = sim.design.root.children?.get(path[0]);
  if (!node) return void ed.toast('Not wired into the circuit yet', 'err');
  const prim = node.def.prim;
  if (!netlistOf(node.def) && prim !== 'nmos' && prim !== 'pmos' && !node.def.modelPanel) {
    return void ed.toast(`${node.def.name} has no inside: it is a primitive of the simulator`);
  }
  let v = views.get(ed);
  if (!v) views.set(ed, (v = new InsideView(ed)));
  v.goTo(path);
}

/** Can this part be looked inside? (Has a structure, or is a transistor.) */
export function canLookInside(ed: Editor, part: string): boolean {
  const d = ed.defOf(ed.doc.parts.find((p) => p.id === part)!);
  return !!d && (!!netlistOf(d) || d.prim === 'nmos' || d.prim === 'pmos' || !!d.modelPanel);
}

class InsideView {
  readonly el: HTMLElement;
  private canvas: HTMLElement;
  private crumbs: HTMLElement;
  private badge: HTMLElement;
  private view: SchematicView;
  private sim: Sim | null = null;
  private root: ViewCtx | null = null;
  private ctx: ViewCtx | null = null;
  private leaf: { name: string; w: Widget } | null = null;
  /** Repaints the faces of the consoles, switches and screens at this level (ioface.ts). */
  private ioPaint: (() => void) | null = null;
  private crumbVals: { el: HTMLElement; v: CrumbValue }[] = [];
  private readonly chip: string;
  private readonly hook = () => this.tick();
  /** What the drawer's lighting last set here (so another highlight, the Why? panel's, is not undone). */
  private litKey = '';
  /** Why? (view/whypanel.ts): a click on a wire traces its value; what each part of the level is for. */
  private why: WhyPanel;
  private whyBtn: HTMLButtonElement;

  constructor(private ed: Editor) {
    this.chip = ed.chipId;
    const btn = (ic: string, title: string, f: () => void) => h('button', { class: 'btn ghost icon-only', title, 'aria-label': title, onclick: f }, icon(ic, 16));
    this.crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Inside' });
    this.badge = h('div', { class: 'level-badge' });
    this.canvas = h('div', { class: 'canvas sb-inside-canvas' }, this.badge,
      hintBadge('double-click a part to open it · Esc: up · live: toggle inputs on the left, or Run', 'double-tap a part: open · tap an input to toggle it', 'inside'));
    this.why = new WhyPanel({
      ctx: () => this.ctx,
      light: (names) => this.view.highlight(names, names.length > 0),
      selectNet: (i) => this.view.selectNet(i),
      toggled: (on) => {
        this.whyBtn.classList.toggle('on', on);
        this.canvas.classList.toggle('probing', on);
        if (!on) this.view.setCover([], true);
      },
    });
    this.whyBtn = h('button', { class: 'btn ghost sm toggle why-btn', title: 'Why? (W): click any wire to trace its value back to the inputs that decide it, or see what each part is for', onclick: () => this.why.setOn(!this.why.on) },
      icon('why', 15), h('span', { class: 'lbl' }, 'Why?')) as HTMLButtonElement;
    this.canvas.append(this.why.el);
    new ResizeObserver(() => {
      if (!this.why.on) return;
      const c = this.canvas.getBoundingClientRect(), r = this.why.el.getBoundingClientRect();
      this.view.setCover([{ x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height }]);
    }).observe(this.why.el);
    this.el = h('section', { class: 'sb-inside', role: 'dialog', 'aria-label': 'Look inside', tabindex: '-1' },
      h('div', { class: 'stage-bar sb-inside-bar' },
        h('span', { class: 'sb-inside-tag' }, icon('layers', 14), 'Inside'), this.crumbs, this.whyBtn,
        btn('up', 'Up one level (Esc)', () => this.up()),
        btn('minus', 'Zoom out', () => this.view.zoom(1.25)),
        btn('plus', 'Zoom in', () => this.view.zoom(0.8)),
        btn('fit', 'Fit to screen', () => this.view.fit()),
        btn('sidebar', 'Wide / beside the circuit (the circuit stays usable on the left)', () => {
          this.el.classList.toggle('wide');
          requestAnimationFrame(() => this.view.fit());
        }),
        h('button', { class: 'btn sm', title: 'Back to editing', onclick: () => this.close() }, icon('close', 14), 'Close')),
      this.canvas);
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (isMenuKey(e) && e.target === this.el) {
        e.preventDefault();
        this.view.keyMenu();
        return;
      }
      // the wires moved here (view/layout.ts), not the chip's own undo
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
        if (this.view.undo(k === 'y' || e.shiftKey)) e.preventDefault();
        return;
      }
      if (e.key === 'Escape' && this.why.on) {
        e.preventDefault();
        this.why.setOn(false);
        return;
      }
      if (k === 'w' && !e.ctrlKey && !e.metaKey && !e.altKey) this.why.setOn(!this.why.on);
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        this.up();
      }
    });
    ed.slots.overlay.append(this.el);
    this.view = new SchematicView(this.canvas, {
      open: (c) => this.open(c),
      select: () => {},
      toggleInput: () => {},
      editInput: () => {},
      layoutChanged: () => this.decorate(),
      netClick: (i) => this.why.netClick(i),
    });
    this.view.radix = ed.view.radix;
    this.view.pickable = true;
    this.view.menuBack = this.el;
    ed.paintHooks.add(this.hook);
  }

  /** (Re)attach to the editor's current simulator. */
  private bind(): void {
    const sim = this.ed.sim.sim;
    if (sim === this.sim && this.root) return;
    this.sim = sim;
    this.root = sim ? new ViewCtx(sim, sim.design.root) : null;
  }

  goTo(path: string[], keepView = false): void {
    this.bind();
    this.closeLeaf();
    if (!this.root) return this.close();
    let ctx = this.root;
    let leaf: string | null = null;
    for (let i = 0; i < path.length; i++) {
      let c: ViewCtx | null = null;
      try {
        c = ctx.child(path[i]);
      } catch {
        c = null; // its inside cannot be simulated on its own: stop at the parent
      }
      if (!c) {
        const d = ctx.node.children?.get(path[i])?.def;
        if ((d?.prim === 'nmos' || d?.prim === 'pmos' || d?.modelPanel) && i === path.length - 1) leaf = path[i];
        break;
      }
      ctx = c;
    }
    if (ctx === this.root && !leaf) return this.close();
    this.ctx = ctx;
    this.why.levelChanged();
    // A library part's wires move as on the stage (the same layout, by component id); a user chip's are drawn in its own tab.
    this.view.arrange = ctx.def.id.startsWith('u_') ? false : 'wires';
    this.view.show(ctx, false, keepView);
    this.litKey = '';
    this.applyLight();
    this.decorate();
    // The panel may still be settling into its size on the first frame.
    if (!keepView) requestAnimationFrame(() => this.view.fit());
    if (leaf) this.openLeaf(leaf);
    this.renderCrumbs();
    this.tick();
    if (!this.el.contains(document.activeElement)) this.el.focus({ preventScroll: true });
  }

  applyLight(): void {
    const w = wanted.get(this.ed), p = this.path;
    const key = w && p.length === 1 && p[0] === w.path && !this.leaf ? w.names.join() : '';
    if (key === this.litKey) return;
    this.litKey = key;
    this.view.highlight(key ? w!.names : [], !!key);
  }

  /** The live faces drawn into the schematic: again after every redraw (a wire moved). */
  private decorate(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const io = decorateInside(this.view.el, ctx, ctx.isSubSim ? null : (node, bit) => toggleSwitch(this.ed.sim, node, bit));
    const faces = this.decorateFaces(ctx);
    this.ioPaint = io || faces ? () => { io?.(); faces?.(); } : null;
    this.ioPaint?.();
  }

  /** The displays placed user chips show on their boxes (face.ts), live from below their nodes. */
  private decorateFaces(ctx: ViewCtx): (() => void) | null {
    const all: { els: FaceEls[]; name: string }[] = [];
    for (const inst of netlistOf(ctx.def)?.instances ?? []) {
      const g = faceOf(inst.def) && this.view.el.querySelector(`[data-inst="${CSS.escape(inst.name)}"]`);
      if (!g) continue;
      const fg = s('g', null);
      const els = drawFace(fg, inst.def, !!inst.flip, inst.rot);
      if (!els) continue;
      g.append(fg);
      all.push({ els, name: inst.name });
    }
    if (!all.length) return null;
    return () => { for (const f of all) paintFace(f.els, ctx.sim, ctx.node.children?.get(f.name) ?? null, this.ed.view.radix); };
  }

  private get path(): string[] {
    const p = this.ctx?.path ?? [];
    return this.leaf ? [...p, this.leaf.name] : p;
  }

  private open(child: string): void {
    const ctx = this.ctx;
    if (!ctx || this.leaf) return;
    const p = ctx.node.children?.get(child)?.def.prim;
    if (p === 'nmos' || p === 'pmos' || ctx.canOpen(child)) this.goTo([...ctx.path, child]);
  }

  private up(): void {
    const p = this.path;
    if (p.length <= 1) return this.close();
    this.goTo(p.slice(0, -1));
  }

  private openLeaf(name: string): void {
    const ctx = this.ctx!;
    const node = ctx.node.children!.get(name)!, def = node.def;
    // a model (a line part: chapter 41's cable) shows its panel; a transistor its cross-section
    const w = def.modelPanel
      ? modelLeaf(def, { state: () => (node.leafIndex === undefined ? undefined : ctx.sim.leafState(node.leafIndex)) })
      : transistorLeaf(def, () => ctx.transistorGate(name));
    const host = h('div', { class: 'widget-host' }, w.el);
    this.canvas.append(host);
    this.leaf = { name, w: { ...w, el: host } };
  }

  private closeLeaf(): void {
    if (!this.leaf) return;
    this.leaf.w.destroy?.();
    this.leaf.w.el.remove();
    this.leaf = null;
  }

  private renderCrumbs(): void {
    const c = this.crumbs;
    c.replaceChildren();
    const ed = this.ed;
    // The chip itself first: it is the editor underneath, so it closes the view.
    c.append(h('button', { title: 'Back to editing', onclick: () => this.close() }, ed.doc.name));
    const p = this.path;
    const levels: ViewCtx[] = [];
    for (let l: ViewCtx | null = this.ctx; l; l = l.parent) levels.unshift(l);
    const vals = crumbValues(levels);
    this.crumbVals = [];
    const valEl = (i: number, name: string, above: string, btn: HTMLElement) => {
      const v = vals[i];
      if (!v) return;
      const el = h('span', { class: 'val' });
      this.crumbVals.push({ el, v });
      btn.append(el);
      btn.title = btn.title ? `${btn.title}\n${crumbTitle(v, name, above)}` : crumbTitle(v, name, above);
    };
    valEl(0, ed.doc.name, '', c.lastChild as HTMLElement);
    let ctx: ViewCtx | null = this.root;
    p.forEach((name, i) => {
      const node = ctx?.node.children?.get(name);
      const last = i === p.length - 1;
      const btn = h('button', { class: last ? 'cur' : '', onclick: () => (last ? null : this.goTo(p.slice(0, i + 1))) },
        name, node ? h('span', { class: 'kind' }, node.def.name) : null);
      c.append(h('span', { class: 'sep' }, '›'), btn);
      valEl(i + 1, name, i ? p[i - 1] : ed.doc.name, btn);
      ctx = ctx && !last ? safeChild(ctx, name) : null;
    });
    this.syncCrumbVals();
    // Deep paths overflow the bar: keep the current level in view.
    requestAnimationFrame(() => (c.scrollLeft = c.scrollWidth));
  }

  private syncCrumbVals(): void {
    paintCrumbVals(this.crumbVals, this.ed.view.radix);
  }

  /** Sync and redraw from the editor's simulation (every repaint). */
  private tick(): void {
    const ed = this.ed;
    if (ed.chipId !== this.chip) return this.close();
    if (ed.sim.sim !== this.sim) {
      // A rebuilt simulator (a structural edit): the same place in the new one.
      if (!ed.sim.sim) return;
      const p = this.path;
      this.root = null;
      return this.goTo(p, true);
    }
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.isSubSim) ctx.sync();
    this.view.radix = ed.view.radix;
    this.view.update();
    this.why.update();
    this.applyLight();
    this.ioPaint?.();
    this.leaf?.w.update?.();
    this.syncCrumbVals();
    const nl = netlistOf(ctx.def);
    const what = this.leaf ? (this.ctx?.node.children?.get(this.leaf.name)?.def.modelPanel ? 'a model, not transistors' : 'a single transistor') : nl?.level === 'switch' ? 'transistors' : 'gates & blocks';
    const txt = `${what} · ${ctx.isSubSim ? 'own simulation, driven by its parent' : 'live'}`;
    if (this.badge.textContent !== txt) this.badge.textContent = txt;
  }

  close(): void {
    this.closeLeaf();
    this.ed.paintHooks.delete(this.hook);
    this.el.remove();
    views.delete(this.ed);
    this.ed.view.svg.focus({ preventScroll: true });
  }
}

function safeChild(ctx: ViewCtx, name: string): ViewCtx | null {
  try {
    return ctx.child(name);
  } catch {
    return null;
  }
}
