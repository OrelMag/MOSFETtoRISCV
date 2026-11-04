// The live circuit at the top of View options: a few parts drawn by the site's own renderer on a running simulation, so every option
// shows what it does on pages with no circuit too. Its own chunk, loaded when the menu first opens; the svg is in the page only while
// the menu is open, so nothing looking for "the circuit" finds this one.

import '../lib'; // the drawing code reaches the registry's readers (ui/pages/printfig.ts)
import { NOT } from '../lib/gates';
import { splitter } from '../lib/define';
import { bitwise } from '../lib/wide';
import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import type { ComponentDef } from '../sim/types';
import { ViewCtx } from '../view/context';
import { SchematicView } from '../view/schematic';

const box = bitwise('xor', 4);
const split = splitter([1, 3]);

/** Not registered: it exists only to be looked at. a ^ b on a bus, one bit tapped through an inverter. */
export const PREVIEW_DEF: ComponentDef = {
  id: 'view_preview', name: 'Preview', summary: 'A few parts to show the view options on.', category: 'gate',
  ports: [{ name: 'a', width: 4, dir: 'in' }, { name: 'b', width: 4, dir: 'in' }, { name: 'q', width: 1, dir: 'out' }, { name: 'hi', width: 3, dir: 'out' }],
  symbol: { kind: 'box', label: 'Preview' },
  netlist: () => ({
    pins: { a: [0, 1], b: [0, 3], q: [27, 2], hi: [27, 7] },
    instances: [
      { name: 'x', def: box, at: [3, 0] },
      { name: 's', def: split, at: [14, 1] },
      { name: 'n', def: NOT, at: [18, 0] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'x.a'] },
      { name: 'b', ends: ['b', 'x.b'] },
      { name: 'y', ends: ['x.y', 's.in'] },
      { name: 'lo', ends: ['s.o0', 'n.a'] },
      { name: 'hi', ends: ['s.o1', 'hi'] },
      { name: 'q', ends: ['n.y', 'q'] },
    ],
  }),
};

let view: SchematicView | null = null;

/** Draws the preview in `host`. */
export function showPreview(host: HTMLElement): void {
  if (!view) {
    view = new SchematicView(host, { open: () => {}, select: () => {}, editInput: () => {}, toggleInput: () => {} });
    // every label stays, small as it is here: the Labels switches must show on it (view/legible.ts keys its rules on this class)
    view.el.classList.remove('lg');
  }
  host.append(view.el);
  const design = flatten(PREVIEW_DEF, { mode: 'gate' });
  const sim = new GateSim(design);
  sim.setInput('a', 0b0101);
  sim.setInput('b', 0b0011);
  sim.reset('zero');
  sim.settle();
  view.show(new ViewCtx(sim, design.root), false);
  view.update();
  view.fit();
}

/** Takes it off the page. */
export function hidePreview(): void {
  if (!view) return;
  view.clear();
  view.el.remove();
}
