// A scene as a figure for paper (print view, ui/pages/print.ts): the site's own drawing (SchematicView, view/image.ts svgImage) at
// the scene's initial inputs, on a white board in the Monochrome palette whatever the learner's theme.
//
// The look is a set of attributes on <html> (data-theme, data-palette, data-look, data-board …), which scoped CSS cannot override, so
// they are swapped for the length of one figure's synchronous work and put back before the browser can paint: the page behind never
// flashes. A design too large to simulate is drawn at its top level only: its parts become blocks that compute nothing (values X).

// the drawing code reaches the registry's readers, and nothing else here fills it (tests/firstload.test.ts); this page has its own chunk
import '../../lib';
import { flatten, type HierNode } from '../../sim/flatten';
import { GateSim } from '../../sim/gatesim';
import { needsSwitchLevel } from '../../sim/harness';
import type { Sim } from '../../sim/sim';
import { netlistOf, type ComponentDef } from '../../sim/types';
import { ViewCtx, switchSim } from '../../view/context';
import { svgImage } from '../../view/image';
import { SchematicView } from '../../view/schematic';
import type { Scene } from '../../view/stage';
import { h } from '../dom';

/** The attributes that shape a drawn circuit, and what paper wants of each (null: absent). */
const PAPER: [string, string | null][] = [
  ['data-theme', 'light'], ['data-palette', 'print'], ['data-modules', 'plain'], ['data-wireflow', 'off'],
  ['data-netcolors', null], ['data-look', null], ['data-board', null], ['data-parts', null], ['data-wires', null], ['data-hide', null], ['data-lens-fill', null],
  // (print.css: no transitions meanwhile, or a wire whose class just changed to 1 is read still on its way from 0's grey)
  ['data-paper', ''],
];

/** Run `fn` with <html> dressed for paper; the learner's attributes are back when it returns. */
export function onPaper<T>(fn: () => T): T {
  const root = document.documentElement;
  const saved = PAPER.map(([a]) => root.getAttribute(a));
  for (const [a, v] of PAPER) { if (v === null) root.removeAttribute(a); else root.setAttribute(a, v); }
  try {
    return fn();
  } finally {
    PAPER.forEach(([a], i) => { const v = saved[i]; if (v === null) root.removeAttribute(a); else root.setAttribute(a, v); });
  }
}

const stubs = new WeakMap<ComponentDef, ComponentDef>();

/** A part as a block that computes nothing: its ports, symbol and name, outputs unknown. */
function stub(d: ComponentDef): ComponentDef {
  if (d.prim === 'nand' || d.prim === 'alias') return d;
  let s = stubs.get(d);
  if (!s) {
    s = { id: d.id, name: d.name, summary: d.summary, category: d.category, ports: d.ports, symbol: d.symbol, behavior: { eval: () => [] } };
    stubs.set(d, s);
  }
  return s;
}

/** The top level of `root` with every part below it a stub: it flattens to a handful of leaves however large the design. */
export function topLevelOnly(root: ComponentDef): ComponentDef {
  const nl = netlistOf(root);
  if (!nl) throw new Error('no structure to draw');
  return {
    id: root.id, name: root.name, summary: root.summary, category: root.category, ports: root.ports, symbol: root.symbol,
    netlist: () => ({ ...nl, instances: nl.instances.map((i) => ({ ...i, def: stub(i.def) })) }),
  };
}

/** The stage's own policy: the root is always its structure, a part that prefers its behaviour stays a leaf. */
const expand = (d: ComponentDef, n: HierNode) => n.parent === null || !d.preferBehavior;

/** Draws figures one after another on a single off-screen view (one set of document listeners, whatever the chapter's length). */
export class FigureMaker {
  private host = h('div', { 'aria-hidden': 'true', style: 'position:fixed;left:-100000px;top:0;width:1200px;height:800px;pointer-events:none' });
  private view: SchematicView;

  constructor() {
    document.body.append(this.host);
    this.view = new SchematicView(this.host, { open: () => {}, select: () => {}, editInput: () => {}, toggleInput: () => {} });
  }

  /** The scene's figure as an inline SVG, sized by the page (its drawn size is the most it grows to: a small gate stays small); throws when it cannot be drawn. */
  svg(scene: Scene, top: boolean): SVGSVGElement {
    const root = top ? topLevelOnly(scene.root) : scene.root;
    const level = needsSwitchLevel(root) ? 'switch' : 'gate';
    const design = flatten(root, { mode: level, expand });
    const sim: Sim = level === 'switch' ? switchSim(design) : new GateSim(design);
    for (const [k, v] of Object.entries(scene.inputs ?? {})) sim.setInput(k, v);
    sim.reset(scene.powerOn ?? 'zero');
    sim.settle();
    return onPaper(() => {
      this.view.show(new ViewCtx(sim, design.root), false);
      this.view.update();
      const text = svgImage(this.view.el, this.view.contentBox(), '#ffffff');
      const w = this.view.contentBox().w;
      this.view.clear();
      const tpl = document.createElement('template');
      tpl.innerHTML = text.replace(/^<\?xml[^>]*\?>\s*/, '');
      const svg = tpl.content.firstElementChild as SVGSVGElement;
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.style.maxWidth = `${Math.round(w * 12.5)}px`;
      return svg;
    });
  }

  destroy(): void {
    this.view.clear();
    this.host.remove();
  }
}
