// The sandbox palette: what can be placed, in groups. Groups are registered (later phases add
// theirs, e.g. a ROM, without editing this file); each lists its items for the current context,
// so "My chips" can grey out chips that would contain the chip being edited.
//
// Purist mode keeps only what the journey builds from: transistors, NAND, pins, constants,
// wiring, displays and the user's own chips.

import { libraryItems } from '../lib/catalog';
import { h } from '../ui/dom';
import type { PartRef, Workspace } from './model';

export type PinKind = 'toggle' | 'button' | 'clock';

/** What a palette item puts on the canvas. */
export type Placement =
  | { part: PartRef }
  | { pin: { dir: 'in' | 'out'; width: number; kind?: PinKind } }
  | { pointer: true };

export interface PaletteItem {
  /** Unique within its group. */
  id: string;
  name: string;
  /** Tooltip. */
  title?: string;
  /** Small hint after the name ('n-bit'). */
  tag?: string;
  /** Sub-heading inside the group (library categories). */
  section?: string;
  place: Placement;
  /** Why it cannot be placed here (shown greyed out with this as tooltip). */
  disabled?: string;
  /** A user chip's colour: a swatch before the name. */
  hue?: number;
}

export interface PaletteCtx {
  ws: Workspace;
  chipId: string;
  canPlace(chip: string): boolean;
}

export interface PaletteGroup {
  id: string;
  title: string;
  /** Position (lower first). Built-in groups use 10, 20, ... */
  order: number;
  /** In purist mode: show every item (true), none (absent), or those that pass. */
  purist?: boolean | ((it: PaletteItem) => boolean);
  /** Start collapsed. */
  collapsed?: boolean;
  items(ctx: PaletteCtx): PaletteItem[];
}

const groups: PaletteGroup[] = [];

/** Add a group (or replace the one with the same id). */
export function registerPaletteGroup(g: PaletteGroup): void {
  const i = groups.findIndex((q) => q.id === g.id);
  if (i >= 0) groups[i] = g;
  else groups.push(g);
  groups.sort((a, b) => a.order - b.order);
}

export function paletteGroups(): readonly PaletteGroup[] {
  return groups;
}

/** The items a group shows in a context, purist filter applied. */
export function visibleItems(g: PaletteGroup, ctx: PaletteCtx, purist: boolean, filter = ''): PaletteItem[] {
  if (purist && !g.purist) return [];
  const f = filter.trim().toLowerCase();
  return g.items(ctx).filter((it) =>
    (!purist || g.purist === true || (typeof g.purist === 'function' && g.purist(it)))
    && (!f || it.name.toLowerCase().includes(f) || it.id.toLowerCase().includes(f) || (it.section ?? '').toLowerCase().includes(f)));
}

// ---- built-in groups ------------------------------------------------------------------------

const lib = (id: string, name: string, title?: string): PaletteItem => ({ id, name, title, place: { part: { lib: id } } });

registerPaletteGroup({
  id: 'io', title: 'Inputs & outputs', order: 10, purist: true,
  items: () => [
    { id: 'in1', name: 'Input', title: 'A 1-bit input pin: click it to toggle', place: { pin: { dir: 'in', width: 1 } } },
    { id: 'button', name: 'Button', title: 'A 1-bit input that is 1 only while held down', place: { pin: { dir: 'in', width: 1, kind: 'button' } } },
    { id: 'clock', name: 'Clock', title: 'A 1-bit input driven by the run loop (Run / Step)', place: { pin: { dir: 'in', width: 1, kind: 'clock' } } },
    { id: 'in8', name: 'Input bus', tag: '8-bit', title: 'An N-bit input pin: click it to edit the value (width in the properties)', place: { pin: { dir: 'in', width: 8 } } },
    { id: 'out1', name: 'Output', title: 'A 1-bit output pin', place: { pin: { dir: 'out', width: 1 } } },
    { id: 'out8', name: 'Output bus', tag: '8-bit', title: 'An N-bit output pin', place: { pin: { dir: 'out', width: 8 } } },
  ],
});

registerPaletteGroup({
  id: 'fets', title: 'Transistors', order: 20, purist: true,
  items: () => [
    lib('nmos', 'NMOS', 'Conducts while its gate is 1'), lib('pmos', 'PMOS', 'Conducts while its gate is 0'),
    lib('vdd', 'VDD', 'Supply rail: a constant 1'), lib('gnd', 'GND', 'Ground rail: a constant 0'),
    lib('nmos_strong', 'NMOS strong', 'A wide NMOS: wins a fight against a weak PMOS (ratioed logic, SRAM)'),
    lib('pmos_weak', 'PMOS weak', 'A narrow PMOS: a pull-up that a strong NMOS overrides'),
  ],
});

registerPaletteGroup({
  id: 'const', title: 'Constants', order: 30, purist: true,
  items: () => [
    { id: 'k0', name: 'Constant 0', place: { part: { const: { width: 1, value: 0 } } } },
    { id: 'k1', name: 'Constant 1', place: { part: { const: { width: 1, value: 1 } } } },
    { id: 'k8', name: 'Constant', tag: '8-bit', title: 'An N-bit constant (width and value in the properties)', place: { part: { const: { width: 8, value: 0 } } } },
  ],
});

registerPaletteGroup({
  id: 'disp', title: 'Displays', order: 40, purist: true,
  items: () => [
    { id: 'led', name: 'LED', title: 'Lights when its input is 1', place: { part: { display: 'led' } } },
    { id: 'seg7', name: '7-segment', tag: '8-bit', title: 'Bit 0 = segment a … bit 6 = g, bit 7 = decimal point', place: { part: { display: 'seg7', width: 8 } } },
    { id: 'hex', name: 'Hex digit', tag: '4-bit', title: 'Shows a 4-bit value as 0–F', place: { part: { display: 'hex', width: 4 } } },
    { id: 'value', name: 'Value', tag: '8-bit', title: 'Shows a bus value in the chosen radix', place: { part: { display: 'value', width: 8 } } },
  ],
});

const many = (n: number, w: number) => Array.from({ length: n }, () => w);

registerPaletteGroup({
  id: 'wiring', title: 'Wiring', order: 50, purist: true,
  items: () => [
    { id: 'pointer', name: 'Pointer', tag: 'L', title: 'A named net label: every pointer with the same name is the same net, no wire needed', place: { pointer: true } },
    { id: 's4', name: 'Split 4 → 1×4', place: { part: { split: many(4, 1) } } },
    { id: 's8', name: 'Split 8 → 1×8', place: { part: { split: many(8, 1) } } },
    { id: 's16', name: 'Split 16 → 8+8', place: { part: { split: [8, 8] } } },
    { id: 's32', name: 'Split 32 → 8×4', place: { part: { split: many(4, 8) } } },
    { id: 'm4', name: 'Merge 1×4 → 4', place: { part: { merge: many(4, 1) } } },
    { id: 'm8', name: 'Merge 1×8 → 8', place: { part: { merge: many(8, 1) } } },
    { id: 'm16', name: 'Merge 8+8 → 16', place: { part: { merge: [8, 8] } } },
    { id: 'm32', name: 'Merge 8×4 → 32', place: { part: { merge: many(4, 8) } } },
  ],
});

registerPaletteGroup({
  id: 'lib', title: 'Library', order: 60, purist: (it) => it.id === 'nand',
  items: () => libraryItems().filter((c) => c.cat !== 'custom').flatMap((c) => c.items.map((it): PaletteItem => ({
    id: it.id, name: it.name, section: c.title, tag: it.family ? 'n-bit' : undefined, place: { part: { lib: it.id } },
    title: it.family ? 'A family: its parameters are in the properties once placed' : undefined,
  }))),
});

registerPaletteGroup({
  id: 'mine', title: 'My chips', order: 70, purist: true,
  items: (ctx) => Object.values(ctx.ws.chips).filter((c) => c.id !== ctx.chipId).map((c): PaletteItem => {
    const ins = c.pins.filter((p) => p.dir !== 'out').length, outs = c.pins.length - ins;
    return {
      id: c.id, name: c.name, place: { part: { chip: c.id } }, hue: c.hue ?? 250, tag: `${ins}→${outs}`,
      title: `${c.name}: ${ins} input${ins === 1 ? '' : 's'}, ${outs} output${outs === 1 ? '' : 's'}${c.notes ? `. ${c.notes}` : ''}`,
      disabled: ctx.canPlace(c.id) ? undefined : `${c.name} contains this chip: placing it would make a chip contain itself`,
    };
  }),
});

// ---- the panel ------------------------------------------------------------------------------

export interface PaletteHooks {
  /** Pointer down on an item: start dragging it (or arm it for a click on the canvas). */
  pick(item: PaletteItem, e: PointerEvent): void;
  purist(): boolean;
  setPurist(v: boolean): void;
}

const OPEN_LIB = new Set(['Gates', 'Transistors']);

export class PalettePanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private purist: HTMLInputElement;
  /** Groups the user collapsed or opened (kept across re-renders). */
  private open = new Map<string, boolean>();
  armed: string | null = null;

  constructor(private ctx: () => PaletteCtx, private hooks: PaletteHooks) {
    this.search = h('input', { type: 'search', placeholder: 'Search parts…', 'aria-label': 'Search parts' }) as HTMLInputElement;
    this.search.addEventListener('input', () => this.render());
    this.purist = h('input', { type: 'checkbox' }) as HTMLInputElement;
    this.purist.addEventListener('change', () => hooks.setPurist(this.purist.checked));
    const pur = h('label', { class: 'sb-purist', title: 'Only transistors, NAND, pins, constants, wiring, displays and your own chips: build everything else yourself' },
      this.purist, 'Purist');
    this.list = h('div', { class: 'sb-pal-list' });
    this.el = h('aside', { class: 'sb-palette', 'aria-label': 'Parts' }, h('div', { class: 'sb-pal-head' }, this.search, pur), this.list);
  }

  render(): void {
    const ctx = this.ctx();
    const purist = this.hooks.purist();
    this.purist.checked = purist;
    const filter = this.search.value;
    this.list.replaceChildren();
    for (const g of groups) {
      const items = visibleItems(g, ctx, purist, filter);
      if (!items.length) continue;
      const det = h('details', { class: 'sb-group', 'data-group': g.id }) as HTMLDetailsElement;
      det.open = filter ? true : this.open.get(g.id) ?? !g.collapsed;
      det.addEventListener('toggle', () => { if (!filter) this.open.set(g.id, det.open); });
      det.append(h('summary', null, g.title, h('small', null, items.length)));
      let sec: HTMLElement = det;
      let cur: string | undefined;
      for (const it of items) {
        if (it.section !== cur) {
          cur = it.section;
          if (cur) {
            const key = `${g.id}/${cur}`;
            const sd = h('details', { class: 'sb-sec' }) as HTMLDetailsElement;
            sd.open = filter ? true : this.open.get(key) ?? OPEN_LIB.has(cur);
            sd.addEventListener('toggle', () => { if (!filter) this.open.set(key, sd.open); });
            sd.append(h('summary', null, cur));
            det.append(sd);
            sec = sd;
          } else sec = det;
        }
        const b = h('button', {
          class: `lib-item sb-item${it.disabled ? ' disabled' : ''}${this.armed === `${g.id}/${it.id}` ? ' on' : ''}`,
          title: it.disabled ?? it.title ?? it.name, 'data-item': `${g.id}/${it.id}`, 'aria-disabled': it.disabled ? 'true' : null,
        }, it.hue !== undefined ? h('i', { class: 'sb-swatch-dot', style: `--chip-h:${it.hue}` }) : null, h('span', null, it.name), it.tag ? h('small', null, it.tag) : null);
        b.addEventListener('pointerdown', (e) => {
          if (it.disabled || e.button !== 0) return;
          e.preventDefault();
          this.hooks.pick(it, e);
        });
        sec.append(b);
      }
      this.list.append(det);
    }
    if (!this.list.childElementCount) this.list.append(h('p', { class: 'sb-empty' }, 'Nothing matches.'));
  }

  setArmed(key: string | null): void {
    this.armed = key;
    for (const b of this.list.querySelectorAll<HTMLElement>('.sb-item')) b.classList.toggle('on', b.dataset.item === key);
  }
}
