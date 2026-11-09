// The right-click menu's rows for a wire or a part of a schematic, in a chunk of their own: loaded on the first
// right-click, so the stage's chunk carries only the shell (ui/menu.ts) and what a surface hands over (plain data:
// MeasureHost, ExplainHost, ElsewhereHost). The view does the selecting before this loads; this builds and opens.

import { closeMenu, type MenuEntry, showMenu } from '../ui/menu';
import { hueSwatches } from '../editor/hueswatch';
import { colourOf, setColour } from './netcolours';
import { h } from '../ui/dom';
import type { ViewFocus } from '../ui/viewlink';
import type { ViewCtx } from './context';
import { factsOf, type NetEnd } from './netfacts';
import type { SchematicEvents } from './schematic';
import { SwitchSim } from '../sim/switchsim';
import { NmosSim } from '../sim/nmossim';
import { elsewhereGroup, elsewhereRows, explainGroup, partHeader, partMeasure, wireHeader, wireRows } from './tracemenu';

type Item = NonNullable<MenuEntry>;

/** What the view lends the menu: its level, its host, its layout rows, and the few things only it can do. */
export interface MenuSite {
  ctx: ViewCtx;
  events: SchematicEvents;
  /** The menu's owner (the view), for closeMenu(owner). */
  owner: object;
  back: HTMLElement | null;
  /** The layout rows for what is under the pointer, after everything else. */
  layout: MenuEntry[];
  selectNet(i: number): void;
  jump(e: NetEnd): void;
  /** What a switch-level net's bit does not say (a short, a weak level). */
  netNote(i: number): string;
  /** Where the learner can colour this level's nets (view/layout.ts hues; the writes are netcolours.ts, in this chunk). */
  hues?: HueSite | undefined;
}

/** A level whose nets the learner can colour: its component id, net i's key, and what to do after a change (recolour). */
export interface HueSite { id: string; key(i: number): string; done(): void }

const items = (list: MenuEntry[]): Item[] => list.filter((x): x is Item => !!x);

const explainOf = (events: SchematicEvents, c: string | null): Item[] => {
  const x = events.explain?.(c);
  return x ? items(explainGroup(x.def, x.host)) : [];
};

const elsewhereOf = (events: SchematicEvents, t: ViewFocus | null): Item[] => {
  const x = events.elsewhere?.(t);
  return x ? items(elsewhereGroup(elsewhereRows(x))) : [];
};

/** A wire's menu: its value, Trace, the groups, then the layout rows. */
export function openNet(site: MenuSite, idx: number, x: number, y: number): boolean {
  const { ctx, events } = site;
  const f = factsOf(ctx.def, idx);
  if (!f) return false;
  const into = h('div', {});
  wireHeader(into, f, () => ctx.netBits(idx), () => site.netNote(idx));
  // the sandbox's swatches (editor/ctxmenu.ts), in the same order: no colour, Auto, the WIRE_HUES
  const hs = site.hues;
  if (hs) {
    const key = hs.key(idx);
    into.append(h('div', { class: 'sb-ctx-hues' }, h('span', null, 'Net colour'),
      hueSwatches(colourOf(hs.id, key), (c) => { closeMenu(); setColour(hs.id, key, c); hs.done(); }, 'menuitemradio')), h('hr'));
  }
  const rows = wireRows(f, {
    highlight: () => site.selectNet(idx),
    jump: (e) => site.jump(e),
    upLevel: (e) => e.inst === null && !!ctx.parent,
    ...(events.why ? { why: () => events.why!(idx) } : { whyOff: 'The Why? card is on stages and in Look inside.' }),
    design: () => ctx.sim.design,
    flat: () => ctx.node.nets?.[idx] ?? [],
    transistors: ctx.sim instanceof SwitchSim || ctx.sim instanceof NmosSim,
    more: elsewhereOf(events, { net: idx }),
    ...(events.measure ? { measure: events.measure({ net: idx }) } : {}),
  });
  // a "find it" step's accusation rows lead the menu
  const acc = events.accuse?.(ctx.node.nets?.[idx] ?? [], f.name) ?? [];
  const all = acc.length ? [...acc, null, ...rows] : rows;
  showMenu(x, y, site.layout.length ? [...all, null, ...site.layout] : all, { owner: site.owner, into, label: `Actions for wire ${f.name}`, ...(site.back ? { back: site.back } : {}) });
  return true;
}

/** A part's menu: its cost, Look inside and Inspect, the groups, then the layout rows. */
export function openPart(site: MenuSite, name: string, x: number, y: number): boolean {
  const { ctx, events } = site;
  const node = ctx.node.children?.get(name);
  if (!node) return false;
  const into = h('div', {});
  partHeader(into, name, node.def);
  const rows: Item[] = [
    { label: 'Look inside', key: 'double-click', run: () => events.open(name), ...(ctx.canOpen(name) ? {} : { why: 'A primitive of the simulator: it has no inside.' }) },
    ...(events.inspect && events.canInspect?.() !== false ? [{ label: 'Inspect', hint: 'Its datasheet and cost', run: () => events.inspect!(name) }] : []),
    ...(events.measure ? items(partMeasure(name, events.measure({ inst: name }))) : []),
    ...explainOf(events, name),
    ...elsewhereOf(events, { inst: name }),
  ];
  showMenu(x, y, site.layout.length ? [...rows, null, ...site.layout] : rows, { owner: site.owner, into, label: `Actions for part ${name}`, ...(site.back ? { back: site.back } : {}) });
  return true;
}

/** A group's rows, for a row the view drew before this chunk loaded (the level's own Explain and Take it elsewhere). */
export async function levelGroup(events: SchematicEvents, which: 'explain' | 'elsewhere'): Promise<MenuEntry[]> {
  const g = which === 'explain' ? explainOf(events, null)[0] : elsewhereOf(events, null)[0];
  const sub = g?.sub;
  return !sub ? [] : typeof sub === 'function' ? await sub() : sub;
}
