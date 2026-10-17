// The sandbox palette: what can be placed, in groups. Groups are registered (later phases add
// theirs, e.g. a ROM, without editing this file); each lists its items for the current context,
// so "My chips" can grey out chips that would contain the chip being edited.
//
// Purist mode keeps only what the journey builds from: transistors (and resistors, capacitors),
// NAND, pins, constants, wiring, displays and the user's own chips.
//
// Favorites (Workspace.favorites, '<group>/<item>' keys) are pinned items repeated at the top, each
// shown as its own group shows it here, so purist mode and greying out still apply.

import { libraryItems } from '../lib/catalog';
import { h, icon } from '../ui/dom';
import { sampleReaderRef } from './cardparts';
import { folderGroups } from './folders';
import type { PartRef, Workspace } from './model';

export type PinKind = 'toggle' | 'button' | 'clock';

/** What a palette item puts on the canvas. */
export type Placement =
  | { part: PartRef }
  | { pin: { dir: 'in' | 'out'; width: number; kind?: PinKind } }
  | { pointer: true }
  /** A free-text comment (drawn, never compiled). */
  | { comment: true };

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
  /**
   * The group's sections are folders (My chips): listed in this order even when empty, open by
   * default, drop targets for a chip dragged from the palette. Items name theirs in `section`.
   */
  folders?(ctx: PaletteCtx): string[];
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

// ---- favorites ------------------------------------------------------------------------------

/** A palette item's key: '<group>/<item>' (stored favorites, the armed item, `data-item`). */
export const itemKey = (group: string, item: string) => `${group}/${item}`;

/** The pinned items in their saved order, as their groups show them here (purist, search, greyed out); stale keys drop. */
export function favoriteItems(ctx: PaletteCtx, purist: boolean, filter = ''): { key: string; item: PaletteItem }[] {
  const favs = ctx.ws.favorites ?? [];
  if (!favs.length) return [];
  const want = new Set(favs);
  const found = new Map<string, PaletteItem>();
  for (const g of groups) {
    if (!favs.some((f) => f.startsWith(`${g.id}/`))) continue;
    for (const it of visibleItems(g, ctx, purist, filter)) {
      const k = itemKey(g.id, it.id);
      if (want.has(k)) found.set(k, { ...it, section: undefined, title: `${it.title ?? it.name} (${g.title})` });
    }
  }
  return favs.flatMap((key) => (found.has(key) ? [{ key, item: found.get(key)! }] : []));
}

/** Favorites with `key` added at the end, or removed. */
export function toggleFavorite(favs: readonly string[] | undefined, key: string): string[] {
  const cur = favs ?? [];
  return cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
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
    { id: 'key', name: 'Key', tag: 'A', title: 'A keyboard key: 1 while it is held (pick the key in the properties). Listens from inside a placed chip too; costs nothing', place: { part: { key: 'a' } } },
    { id: 'keyboard', name: 'Keyboard', tag: '8-bit', title: 'Typed keys wait in order: code = the oldest (ASCII), ready = 1 while one waits, ack removes it. Keys reach it while the circuit runs or with Type on; costs nothing', place: { part: { keyboard: true } } },
    { id: 'pzin', name: 'Puzzle in', tag: '8-bit', title: 'The input of a program puzzle: data = the next word of the test, ready = 1 while one waits, read = 1 at a rising clk edge takes it. Costs nothing', place: { part: { puzzle: 'in', width: 8 } } },
    { id: 'pzout', name: 'Puzzle out', tag: '8-bit', title: 'The output of a program puzzle: records data at a rising clk edge with we = 1; Check compares the words with the test. Costs nothing', place: { part: { puzzle: 'out', width: 8 } } },
    { id: 'cards', name: 'Card reader', tag: 'deck', title: 'A deck of punched cards: data = the word punched in row 9 of the card at the read station (or one column at a time), ready = 1 while one waits, next = 1 at a rising clk edge takes it. Punch, load and save decks in the properties; costs nothing', place: { part: { reader: sampleReaderRef() } } },
    { id: 'switches', name: 'Switches', tag: '8-bit', title: 'A bank of toggle switches (1–32 in the properties): click one to flip it, also while running. q = their positions; they stay put through Reset. Costs nothing', place: { part: { switches: 8 } } },
  ],
});

// Clocked sources built from gates (not purist: they open to a register and feedback logic).
registerPaletteGroup({
  id: 'sources', title: 'Sources', order: 15,
  items: () => [
    lib('cycles16', 'Cycle counter', 'Clock edges since power-on (16 bits; 8 or 32 in the properties)'),
    lib('random8', 'Random', 'A new pseudo-random number every clock edge: an XNOR LFSR that needs no seed (4, 8 or 16 bits in the properties)'),
    lib('timer1000', 'Timer', 'A periodic interrupt: irq rises every 1000 clock edges (10 to 100 000 in the properties) and stays 1 until ack; count shows the counter'),
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

// Solved by the switch-level solver like the transistors. Resistors and capacitors are primitives
// (purist); the transmission gate and the tri-states are cells built from transistors.
const PASSIVE = new Set(['res', 'pullup', 'pulldown', 'cap']);
registerPaletteGroup({
  id: 'switch', title: 'Switch level', order: 25, purist: (it) => PASSIVE.has(it.id),
  items: () => [
    lib('res', 'Resistor', 'Always conducts, weaker than any transistor: a node it alone reaches follows it, any transistor overrides it'),
    lib('pullup', 'Pull-up', 'A resistor to VDD: the node reads 1 unless a transistor pulls it down (pseudo-NMOS, open-drain buses). Costs static current while pulled down'),
    lib('pulldown', 'Pull-down', 'A resistor to GND: the node reads 0 unless a transistor pulls it up; holds an idle bus at 0'),
    lib('cap', 'Capacitor', 'A capacitor to GND: its node keeps its last value while nothing drives it (like ticking "keeps charge" on the wire)'),
    lib('tgate', 'Transmission gate', 'NMOS + PMOS in parallel: passes 0 and 1, both ways, while en = 1 and en_n = 0'),
    lib('tribuf', 'Tri-state buffer', 'y = a while en = 1, floating (Z) while en = 0: several may drive one bus, one at a time'),
    lib('triinv', 'Tri-state inverter', 'y = NOT a while en = 1, floating (Z) while en = 0'),
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
    { id: 'leds', name: 'LED bank', tag: '8-bit', title: 'One LED per bit, most significant first, rows of 8 (width in the properties)', place: { part: { display: 'led', width: 8 } } },
    { id: 'seg7', name: '7-segment', tag: '8-bit', title: 'Bit 0 = segment a … bit 6 = g, bit 7 = decimal point', place: { part: { display: 'seg7', width: 8 } } },
    { id: 'hex', name: 'Hex digit', tag: '4-bit', title: 'Shows a 4-bit value as 0–F', place: { part: { display: 'hex', width: 4 } } },
    { id: 'value', name: 'Value', tag: '8-bit', title: 'Shows a bus value in the chosen radix', place: { part: { display: 'value', width: 8 } } },
    { id: 'buzzer', name: 'Buzzer', title: 'Sounds while its input is 1 (A4, 440 Hz); give it a bus to play MIDI note v (60 = middle C)', place: { part: { display: 'buzzer' } } },
    { id: 'halt', name: 'Halt', title: 'Stops Run after the step where its input reads 1 (any bit of a bus); placed inside a chip, it still stops Run', place: { part: { display: 'halt' } } },
    { id: 'console', name: 'Console', tag: 'ASCII', title: 'A terminal: prints the character on data at a rising clk edge with we = 1 (\\n new line, \\b backspace, \\f clears). Costs nothing', place: { part: { console: { cols: 32, rows: 8 } } } },
    { id: 'screen', name: 'Screen', tag: '32×32', title: 'A pixel screen: write pixels by x, y and colour into its own frame buffer, latch rows from a bus, or one wire per pixel (mode, size and colours in the properties). Costs nothing', place: { part: { screen: { mode: 'write', size: 32, color: 'rgb332' } } } },
  ],
});

const many = (n: number, w: number) => Array.from({ length: n }, () => w);

registerPaletteGroup({
  id: 'wiring', title: 'Wiring', order: 50, purist: true,
  items: () => [
    { id: 'pointer', name: 'Pointer', tag: 'L', title: 'A named net label: every pointer with the same name is the same net, no wire needed', place: { pointer: true } },
    { id: 'comment', name: 'Comment', tag: 'T', title: 'Free text on the canvas: saved and shared with the chip, never part of the circuit', place: { comment: true } },
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
  items: (ctx) => folderGroups(ctx.ws, (c) => c.id !== ctx.chipId).flatMap((g) => g.chips.map((c): PaletteItem => {
    const ins = c.pins.filter((p) => p.dir !== 'out').length, outs = c.pins.length - ins;
    return {
      id: c.id, name: c.name, place: { part: { chip: c.id } }, hue: c.hue ?? 250, tag: `${ins}→${outs}`, section: g.name ?? undefined,
      title: `${c.name}: ${ins} input${ins === 1 ? '' : 's'}, ${outs} output${outs === 1 ? '' : 's'}${c.notes ? `. ${c.notes}` : ''}`,
      disabled: ctx.canPlace(c.id) ? undefined : `${c.name} contains this chip: placing it would make a chip contain itself`,
    };
  })),
  folders: (ctx) => (ctx.ws.folders ?? []).map((f) => f.name),
});

// ---- the panel ------------------------------------------------------------------------------

export interface PaletteHooks {
  /** Pointer down on an item: start dragging it (or arm it for a click on the canvas). */
  pick(item: PaletteItem, e: PointerEvent): void;
  purist(): boolean;
  setPurist(v: boolean): void;
  /** Pin an item at the top, or unpin it. */
  toggleFavorite(key: string): void;
  /** The purist switch is fixed (a level screen: the level's rule decides), so it is not drawn. */
  locked?: boolean;
  /** Groups left out entirely. */
  hidden?(groupId: string): boolean;
  /** Groups listed first, in this order (a level screen: its own parts before pins and displays). */
  first?: readonly string[];
  /** Groups closed until the user opens them. */
  closed?: readonly string[];
  /** A "New folder" button on a folder group's header (My chips). */
  newFolder?(): void;
  /** Double-click a folder's name to rename it; returns why the name cannot be used, or null. */
  renameFolder?(from: string, to: string): string | null;
}

const OPEN_LIB = new Set(['Gates', 'Transistors']);

export class PalettePanel {
  readonly el: HTMLElement;
  /** Above the search box: the project switcher (projectui.ts). */
  readonly top: HTMLElement;
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
    this.top = h('div', { class: 'sb-pal-top' });
    this.el = h('aside', { class: 'sb-palette', 'aria-label': 'Parts' }, this.top, h('div', { class: 'sb-pal-head' }, this.search, hooks.locked ? null : pur), this.list);
  }

  render(): void {
    const ctx = this.ctx();
    const purist = this.hooks.purist();
    this.purist.checked = purist;
    const filter = this.search.value;
    this.list.replaceChildren();
    const favs = this.favorites(filter);
    const pinned = new Set(ctx.ws.favorites);
    if (favs.length) {
      const det = h('details', { class: 'sb-group sb-favs', 'data-group': 'fav' }) as HTMLDetailsElement;
      det.open = filter ? true : this.open.get('fav') ?? true;
      det.addEventListener('toggle', () => { if (!filter) this.open.set('fav', det.open); });
      det.append(h('summary', null, 'Favorites', h('small', null, favs.length)));
      // Number keys arm the first nine (unfiltered: a search must not move them).
      const nums = new Map(this.favorites().slice(0, 9).map((f, i) => [f.key, i + 1]));
      for (const f of favs) det.append(this.itemButton(f.key, f.item, true, nums.get(f.key)));
      this.list.append(det);
    }
    const first = this.hooks.first ?? [];
    const rank = (id: string) => (first.includes(id) ? first.indexOf(id) : first.length);
    for (const g of [...groups].sort((a, b) => rank(a.id) - rank(b.id))) {
      if (this.hooks.hidden?.(g.id)) continue;
      const items = visibleItems(g, ctx, purist, filter);
      const folders = g.folders && (!purist || g.purist) ? g.folders(ctx) : null;
      if (!items.length && (filter || !folders?.length)) continue;
      const det = h('details', { class: 'sb-group', 'data-group': g.id }) as HTMLDetailsElement;
      det.open = filter ? true : this.open.get(g.id) ?? (!g.collapsed && !this.hooks.closed?.includes(g.id));
      det.addEventListener('toggle', () => { if (!filter) this.open.set(g.id, det.open); });
      const add = folders && this.hooks.newFolder ? h('button', { class: 'sb-addfolder', title: 'New folder', 'aria-label': 'New folder', onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); this.hooks.newFolder!(); } }, icon('folderPlus', 14)) : null;
      det.append(h('summary', null, g.title, h('small', null, items.length), add));
      let queue: HTMLElement | null = null;
      if (folders) {
        // Folders in their own order (empty ones too, unless searching), then the unfiled items.
        det.dataset.folder = '';
        const by = new Map<string, PaletteItem[]>();
        for (const it of items) if (it.section) by.set(it.section, [...(by.get(it.section) ?? []), it]);
        for (const name of filter ? folders.filter((f) => by.has(f)) : folders) {
          const key = `${g.id}/${name}`;
          const its = by.get(name) ?? [];
          const sd = h('details', { class: 'sb-sec sb-folder', 'data-folder': name }) as HTMLDetailsElement;
          sd.open = filter ? true : this.open.get(key) ?? true;
          sd.addEventListener('toggle', () => { if (!filter) this.open.set(key, sd.open); });
          const sum = h('summary', { title: this.hooks.renameFolder ? 'Double-click to rename; drag a chip here to file it' : null }, icon('folder', 13), h('span', null, name), h('small', null, its.length));
          if (this.hooks.renameFolder) sum.addEventListener('dblclick', (e) => { e.preventDefault(); this.editFolder(sum, name); });
          sd.append(sum);
          if (this.pendingRename === name) queue = sum;
          for (const it of its) sd.append(this.itemButton(itemKey(g.id, it.id), it, pinned.has(itemKey(g.id, it.id))));
          det.append(sd);
        }
        for (const it of items) if (!it.section) det.append(this.itemButton(itemKey(g.id, it.id), it, pinned.has(itemKey(g.id, it.id))));
        this.list.append(det);
        if (queue) {
          const q = queue;
          this.pendingRename = null;
          det.open = true;
          this.editFolder(q, q.querySelector('span')!.textContent!);
        }
        continue;
      }
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
        const key = itemKey(g.id, it.id);
        sec.append(this.itemButton(key, it, pinned.has(key)));
      }
      this.list.append(det);
    }
    if (!this.list.childElementCount) this.list.append(h('p', { class: 'sb-empty' }, 'Nothing matches.'));
  }

  /** One item: drag or click to place; its star pins it to Favorites (number `n`: the key that arms it). */
  private itemButton(key: string, it: PaletteItem, fav: boolean, n?: number): HTMLElement {
    const star = h('span', { class: `sb-star${fav ? ' on' : ''}`, title: fav ? 'Remove from favorites' : 'Add to favorites', 'aria-hidden': 'true' }, fav ? '★' : '☆');
    const b = h('button', {
      class: `lib-item sb-item${it.disabled ? ' disabled' : ''}${this.armed === key ? ' on' : ''}`,
      title: `${it.disabled ?? it.title ?? it.name}${n ? ` (key ${n})` : ''}`, 'data-item': key, 'aria-disabled': it.disabled ? 'true' : null,
    }, it.hue !== undefined ? h('i', { class: 'sb-swatch-dot', style: `--chip-h:${it.hue}` }) : null, h('span', null, it.name),
    it.tag ? h('small', null, it.tag) : null, n ? h('kbd', { class: 'sb-fav-key' }, n) : null, star);
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target === star) {
        e.preventDefault();
        e.stopPropagation();
        return this.hooks.toggleFavorite(key);
      }
      if (it.disabled) return;
      e.preventDefault();
      this.hooks.pick(it, e);
    });
    return b;
  }

  /** The n-th favorite (0-based) as number keys see it: purist applied, no search filter. */
  favorite(n: number): { key: string; item: PaletteItem } | null {
    return this.favorites()[n] ?? null;
  }

  /** The favorites shown here: those of hidden groups (a level screen) left out. */
  private favorites(filter = ''): { key: string; item: PaletteItem }[] {
    const hidden = this.hooks.hidden;
    const all = favoriteItems(this.ctx(), this.hooks.purist(), filter);
    return hidden ? all.filter((f) => !hidden(f.key.slice(0, f.key.indexOf('/')))) : all;
  }

  private pendingRename: string | null = null;

  /** Put this folder's name in an edit box at the next render (a folder just made). */
  renameSoon(name: string): void {
    this.pendingRename = name;
  }

  /** The folder's name as an edit box in its header: Enter or leaving keeps it, Esc puts the old one back. */
  private editFolder(sum: HTMLElement, name: string): void {
    const label = sum.querySelector('span');
    if (!label || sum.querySelector('input')) return;
    const input = h('input', { class: 'sb-folder-name', value: name, 'aria-label': 'Folder name', maxlength: '40' }) as HTMLInputElement;
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const to = input.value;
      input.replaceWith(label);
      if (keep && to.trim() !== name) {
        const why = this.hooks.renameFolder?.(name, to);
        if (why) {
          label.textContent = name;
          sum.title = `Not renamed: ${why}`;
        }
      }
    };
    // Inside a <summary>: clicks and Space would fold the folder.
    input.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('keyup', (e) => { e.preventDefault(); e.stopPropagation(); });
    input.addEventListener('blur', () => finish(true));
    label.replaceWith(input);
    input.focus();
    input.select();
  }

  /** The folder under a point while a chip is dragged: its name, '' for My chips itself (unfiled), null elsewhere. */
  folderAt(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-folder]');
    return el && this.list.contains(el) ? el.dataset.folder ?? null : null;
  }

  /** Outline the drop target (null: none). */
  markDrop(folder: string | null): void {
    for (const el of this.list.querySelectorAll<HTMLElement>('[data-folder]')) el.classList.toggle('sb-drop', el.dataset.folder === folder);
  }

  setArmed(key: string | null): void {
    this.armed = key;
    for (const b of this.list.querySelectorAll<HTMLElement>('.sb-item')) b.classList.toggle('on', b.dataset.item === key);
  }
}
