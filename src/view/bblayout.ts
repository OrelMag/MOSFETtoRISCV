// The breadboard view's layout (view/breadboard.ts draws it), DOM-free: what a scene author writes to show a
// design as boards of chips, LEDs, DIP switches and 7-segment digits, every one of them a net of the scene's own
// simulation. Geometry is in breadboard holes (0.1 inch): a board is placed by hand, its contents flow inside it
// (chips in a row, then the indicators), so the author lists what is on a board and not where.
// validateLayout checks a layout against the scene's root definition; BbNets resolves it against the flattened
// design and reads every value in one call.

import { findNode, type HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { B0, B1, BX, type Bit, type ComponentDef, netlistOf } from '../sim/types';

/** A bit of the scene: a port of an instance (path of instance names from the scene root; [] = the root's own pins). */
export interface BbNet {
  path: string[];
  port: string;
  /** Default 0. */
  bit?: number;
}

export type LedColor = 'red' | 'yellow' | 'green' | 'blue' | 'white';

export interface BbLed {
  net: BbNet;
  /** Default red. */
  color?: LedColor;
  /** A few characters under the LED (a control line's name, T0, C). */
  label?: string;
  /** Leave a space before this LED (between two groups). */
  gap?: boolean;
}

/** A DIP switch: one bit of an input pin of the scene root, toggled like the stage's bottom bar does. */
export interface BbSwitch {
  port: string;
  bit?: number;
  label?: string;
  /** Leave a space before this switch (between two groups). */
  gap?: boolean;
}

/** A 7-segment digit: 8 bits of a port from `bit` up (a…g, dp), or with `hex` 4 bits shown as a hex digit. */
export interface BbDigit {
  path: string[];
  port: string;
  /** The lowest bit (segment a, or the hex digit's bit 0). Default 0. */
  bit?: number;
  hex?: boolean;
}

/** A DIP pin: a bit of the chip's port (named `name` on the pin card, else port[bit]), or a supply pin. */
export type BbPin = { port: string; bit?: number; name?: string } | 'VCC' | 'GND' | 'NC';

export interface BbChip {
  /** The instance it stands for, from the scene root; absent: a chip that is drawn only (a 555 the stage's clock stands in for). */
  path?: string[];
  /** The part number printed on it: '74LS173'. */
  part: string;
  /** DIP pin count (even). */
  dip: number;
  /** Reference designator: 'U25'. */
  ref?: string;
  /** What it does here, for the hover card: 'Puts the IR's low 4 bits on the bus while IO = 1.' */
  role?: string;
  /** Pin number (1 … dip) → what is on it: the pin card shows them live when the chip is opened. */
  pins?: Record<number, BbPin>;
}

/** A board is driving (amber ring) or loading (blue ring) while this bit is 1; `label` goes on its pill. */
export type BbActive = BbNet & { label?: string };

export interface BbBoard {
  title: string;
  /** Top-left corner and size, in holes. */
  at: [number, number];
  size: [number, number];
  /** The module instance the board stands for: double-clicking its title opens it. */
  module?: string[];
  chips: BbChip[];
  /** LEDs after the chips, in the chip row (a step counter's T0–T4). */
  beside?: BbLed[];
  /** The indicator row under the chips: DIP switches, then LEDs, then digits. */
  switches?: BbSwitch[];
  leds?: BbLed[];
  digits?: BbDigit[];
  /** The bus strip (BbBus.id) the board is wired to: a ribbon of jumpers from its side facing the strip. */
  bus?: string;
  drives?: BbActive;
  loads?: BbActive;
}

/** The bus: a strip of n jumpers (a port n bits wide), LEDs and its value on a small board at its top. */
export interface BbBus {
  id: string;
  title?: string;
  at: [number, number];
  size: [number, number];
  path: string[];
  port: string;
}

export interface BreadboardLayout {
  boards: BbBoard[];
  buses?: BbBus[];
  /** The stage's caption over the boards: '18 ICs, 74LS series'. */
  note?: string;
  /** The same boards in one column, for a canvas too narrow to read the layout whole (pickArrangement). */
  narrow?: BreadboardLayout;
}

/** LEDs for a whole port, most significant bit first (as they sit on a board). */
export function ledsOf(path: string[], port: string, width: number, color: LedColor = 'red', label?: (bit: number) => string): BbLed[] {
  return Array.from({ length: width }, (_, i) => {
    const bit = width - 1 - i;
    return { net: { path, port, bit }, color, ...(label ? { label: label(bit) } : {}) };
  });
}

// ---- geometry ---------------------------------------------------------------------------------

export interface Box { x: number; y: number; w: number; h: number }

/** Board margins and pitches, in holes. */
export const BB = {
  /** Rails, then the title above the chips. */
  top: 4.3,
  side: 1.6,
  bottom: 1.6,
  chipGap: 1.2,
  rowGap: 1.4,
  led: 1.6,
  ledGap: 0.5,
  sw: 1.15,
  digitW: 2.9,
  digitH: 4.4,
  /** Label room under an LED. */
  ledLabel: 1.1,
  /** The bus strip's header board. */
  busHead: 6.5,
  busPitch: 1.2,
} as const;

/** A DIP package's body (the legs stick out half a hole above and below): a 0.3-inch one, or 0.6 from 24 pins up. */
export function chipSize(dip: number): { w: number; h: number } {
  return { w: dip / 2, h: dip >= 24 ? 5.6 : 3.8 };
}

export interface BoardPlan {
  chips: Box[];
  beside: Box[];
  switches: Box[];
  leds: Box[];
  digits: Box[];
  /** The digits' dark window, if any. */
  window: Box | null;
  /** The contents' extent from the board's corner (overflow when larger than the board). */
  need: { w: number; h: number };
}

/** Where a board's contents go, relative to its top-left corner: chips flow in rows, the indicators below. */
export function planBoard(b: BbBoard): BoardPlan {
  const W = b.size[0];
  const chips: Box[] = [], beside: Box[] = [];
  let x = BB.side + 0.6, y = BB.top, rowH = 0, maxW = 0;
  const place = (w: number, h: number, gap: number): Box => {
    if (x > BB.side + 0.6 && x + w > W - BB.side) {
      x = BB.side + 0.6;
      y += rowH + BB.rowGap;
      rowH = 0;
    }
    const r = { x, y, w, h };
    x += w + gap;
    rowH = Math.max(rowH, h);
    maxW = Math.max(maxW, r.x + w);
    return r;
  };
  for (const c of b.chips) {
    const s = chipSize(c.dip);
    chips.push(place(s.w, s.h, BB.chipGap));
  }
  for (const l of b.beside ?? []) beside.push(place(BB.led, BB.led + BB.ledLabel, BB.ledGap + (l.gap ? 0.8 : 0)));
  // beside LEDs sit centred on the chip row
  for (const r of beside) r.y += Math.max(0, (rowH - r.h) / 2);
  let iy = (chips.length || beside.length) ? y + rowH + BB.rowGap : BB.top;
  let ix = BB.side;
  const switches: Box[] = [], leds: Box[] = [], digits: Box[] = [];
  let ih = 0;
  // a switch bank's labels (if any) under it, like the LEDs'
  const swH = 1.8 + ((b.switches ?? []).some((s) => s.label) ? BB.ledLabel : 0);
  for (const sw of b.switches ?? []) {
    if (sw.gap && switches.length) ix += 0.8;
    const w = Math.max(BB.sw, (sw.label?.length ?? 0) * 0.5);
    switches.push({ x: ix, y: iy, w, h: swH });
    ix += w;
    ih = Math.max(ih, swH);
  }
  if (switches.length) ix += 0.8;
  for (const l of b.leds ?? []) {
    if (l.gap) ix += 0.8;
    leds.push({ x: ix, y: iy, w: BB.led, h: BB.led + BB.ledLabel });
    ix += BB.led + BB.ledGap;
    ih = Math.max(ih, BB.led + BB.ledLabel);
  }
  let window: Box | null = null;
  if (b.digits?.length) {
    if (leds.length) ix += 0.6;
    const wx = ix;
    ix += 0.6;
    for (const _ of b.digits) {
      digits.push({ x: ix, y: iy + 0.5, w: BB.digitW - 0.6, h: BB.digitH - 1 });
      ix += BB.digitW;
    }
    window = { x: wx, y: iy, w: ix - wx, h: BB.digitH };
    ih = Math.max(ih, BB.digitH);
  }
  maxW = Math.max(maxW, ix);
  if (!ih) iy -= BB.rowGap;
  return { chips, beside, switches, leds, digits, window, need: { w: maxW + BB.side - 0.4, h: iy + ih + BB.bottom } };
}

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const boxOf = (at: [number, number], size: [number, number]): Box => ({ x: at[0], y: at[1], w: size[0], h: size[1] });

/** The whole layout's extent, from (0, 0). */
export function layoutBounds(l: BreadboardLayout): { w: number; h: number } {
  let w = 0, hh = 0;
  for (const r of [...l.boards, ...(l.buses ?? [])]) {
    w = Math.max(w, r.at[0] + r.size[0]);
    hh = Math.max(hh, r.at[1] + r.size[1]);
  }
  return { w, h: hh };
}

/** Holes of margin around the boards in a fitted view. */
export const BB_MARGIN = 2;

/** Pixels per hole at which the boards read: a chip's part number (about 1.9 holes) is 10 px and more. */
export const BB_READ_PX = 5.5;

/** The boards' view box (in holes) for an svg `pw` × `ph` px: all of them centred, or with `top` (a column taller than
 *  the canvas) as wide as the svg, from the top, the rest a pan away. Its aspect is the svg's, so nothing letterboxes. */
export function fitBoards(b: { w: number; h: number }, pw: number, ph: number, top = false): Box {
  const W = b.w + 2 * BB_MARGIN, H = b.h + 2 * BB_MARGIN;
  if (!(pw > 0 && ph > 0)) return { x: -BB_MARGIN, y: -BB_MARGIN, w: W, h: H };
  const all = Math.min(pw / W, ph / H), wide = pw / W;
  if (!top || all >= wide - 1e-9) {
    const w = pw / all, h = ph / all;
    return { x: -BB_MARGIN - (w - W) / 2, y: -BB_MARGIN - (h - H) / 2, w, h };
  }
  return { x: -BB_MARGIN, y: -BB_MARGIN, w: W, h: ph / wide };
}

/**
 * Which arrangement an svg `pw` × `ph` px shows: the layout whole while it reads there (BB_READ_PX), else its one-column
 * `narrow` arrangement when that is clearly larger as wide as the svg (a phone, a stage beside a panel): readable
 * boards a pan apart beat the whole computer in print too small to read.
 */
export function pickArrangement(l: BreadboardLayout, pw: number, ph: number): 'wide' | 'narrow' {
  if (!l.narrow || !(pw > 0 && ph > 0)) return 'wide';
  const b = layoutBounds(l), n = layoutBounds(l.narrow);
  const s = Math.min(pw / (b.w + 2 * BB_MARGIN), ph / (b.h + 2 * BB_MARGIN));
  if (s >= BB_READ_PX) return 'wide';
  return pw / (n.w + 2 * BB_MARGIN) >= 1.25 * s ? 'narrow' : 'wide';
}

/** The ribbon from a board to its bus strip: across the gap on the side facing the strip, centred on the board. */
export function stubOf(b: BbBoard, bus: BbBus): Box | null {
  const bx = boxOf(b.at, b.size), sx = boxOf(bus.at, bus.size);
  const cy = bx.y + bx.h / 2, hh = Math.min(3.2, bx.h - 2);
  if (cy < sx.y + BB.busHead || cy > sx.y + sx.h) return null;
  if (bx.x + bx.w <= sx.x) return { x: bx.x + bx.w, y: cy - hh / 2, w: sx.x + sx.w / 2 - (bx.x + bx.w), h: hh };
  if (sx.x + sx.w <= bx.x) return { x: sx.x + sx.w / 2, y: cy - hh / 2, w: bx.x - (sx.x + sx.w / 2), h: hh };
  return null;
}

// ---- validation -------------------------------------------------------------------------------

/** The definition at `path` below `root`, or why there is none. As the stage flattens, an instance that prefers its
 *  behaviour (a ROM) is a leaf below the root: its ports exist, its inside is a sub-simulation of its own. */
export function defAt(root: ComponentDef, path: readonly string[]): ComponentDef | string {
  let d = root;
  for (let i = 0; i < path.length; i++) {
    if (i > 0 && d.preferBehavior) return `${path.slice(0, i).join('.')} is simulated as one leaf: nothing inside it is a net of the scene`;
    const nl = netlistOf(d);
    const inst = nl?.instances.find((x) => x.name === path[i]);
    if (!inst) return `no instance ${path[i]} in ${path.slice(0, i).join('.') || d.id}`;
    d = inst.def;
  }
  return d;
}

function checkNet(root: ComponentDef, n: { path: string[]; port: string; bit?: number }, width: number, what: string, out: string[]): void {
  const d = defAt(root, n.path);
  if (typeof d === 'string') {
    out.push(`${what}: ${d}`);
    return;
  }
  const p = d.ports.find((q) => q.name === n.port);
  const at = [...n.path, n.port].join('.');
  if (!p) out.push(`${what}: ${d.id} has no port ${n.port}`);
  else if ((n.bit ?? 0) < 0 || (n.bit ?? 0) + width > p.width) out.push(`${what}: ${at} is ${p.width} bits wide, bit ${n.bit ?? 0}${width > 1 ? ` + ${width}` : ''} is outside it`);
}

/** Every problem with a layout for `root` (an empty list: it can be drawn). */
export function validateLayout(l: BreadboardLayout, root: ComponentDef): string[] {
  const out: string[] = [];
  const buses = new Map((l.buses ?? []).map((b) => [b.id, b]));
  if (buses.size !== (l.buses ?? []).length) out.push('two bus strips share an id');
  const rects: { name: string; box: Box }[] = [];
  for (const b of l.buses ?? []) {
    checkNet(root, b, 1, `bus ${b.id}`, out);
    rects.push({ name: `bus ${b.id}`, box: boxOf(b.at, b.size) });
  }
  for (const b of l.boards) {
    const B = `board ${b.title}`;
    rects.push({ name: B, box: boxOf(b.at, b.size) });
    if (b.module) {
      const d = defAt(root, b.module);
      if (typeof d === 'string') out.push(`${B}: module: ${d}`);
    }
    b.chips.forEach((c, i) => {
      const C = `${B}: chip ${c.ref ?? c.part ?? i}`;
      if (c.dip < 4 || c.dip > 64 || c.dip % 2) out.push(`${C}: ${c.dip} pins is not a DIP package`);
      if (!c.path) {
        if (c.pins) out.push(`${C}: pins without an instance`);
        return;
      }
      const d = defAt(root, c.path);
      if (typeof d === 'string') {
        out.push(`${C}: ${d}`);
        return;
      }
      for (const [k, pin] of Object.entries(c.pins ?? {})) {
        const n = Number(k);
        if (!Number.isInteger(n) || n < 1 || n > c.dip) out.push(`${C}: pin ${k} is not one of 1–${c.dip}`);
        if (typeof pin === 'string') continue;
        checkNet(root, { path: c.path, port: pin.port, bit: pin.bit }, 1, `${C} pin ${k}`, out);
      }
    });
    for (const [i, x] of [...(b.beside ?? []), ...(b.leds ?? [])].entries()) checkNet(root, x.net, 1, `${B}: LED ${x.label ?? i}`, out);
    for (const s of b.switches ?? []) {
      const p = root.ports.find((q) => q.name === s.port);
      if (!p || p.dir !== 'in') out.push(`${B}: switch: ${s.port} is not an input of ${root.id}`);
      else if ((s.bit ?? 0) < 0 || (s.bit ?? 0) >= p.width) out.push(`${B}: switch: ${s.port} has no bit ${s.bit}`);
    }
    for (const d of b.digits ?? []) checkNet(root, d, d.hex ? 4 : 8, `${B}: digit`, out);
    for (const [k, a] of [['drives', b.drives], ['loads', b.loads]] as const) if (a) checkNet(root, a, 1, `${B}: ${k}`, out);
    if (b.bus !== undefined) {
      const bus = buses.get(b.bus);
      if (!bus) out.push(`${B}: no bus strip ${b.bus}`);
      else if (!stubOf(b, bus)) out.push(`${B}: does not sit beside bus ${b.bus}`);
    }
    const need = planBoard(b).need;
    if (need.w > b.size[0] + 1e-9 || need.h > b.size[1] + 1e-9) out.push(`${B}: its contents need ${need.w.toFixed(1)} × ${need.h.toFixed(1)} holes, the board is ${b.size[0]} × ${b.size[1]}`);
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) if (overlap(rects[i].box, rects[j].box)) out.push(`${rects[i].name} overlaps ${rects[j].name}`);
  }
  if (l.narrow) {
    for (const e of validateLayout(l.narrow, root)) out.push(`narrow: ${e}`);
    const key = (x: BreadboardLayout) => x.boards.map((b) => `${b.title}:${b.chips.map((c) => c.path?.join('.') ?? c.part).join(',')}`).sort().join('|');
    if (key(l.narrow) !== key(l)) out.push('narrow: not the same boards and chips');
    if (l.narrow.narrow) out.push('narrow: has a narrow arrangement of its own');
  }
  return out;
}

// ---- live values ------------------------------------------------------------------------------

/**
 * A layout's nets in a flattened design (the stage's own: Stage.sim.design.root), read in one getBits call per
 * repaint. Each `net(...)` call returns an index into the bits read(); a net the design does not have reads X.
 */
export class BbNets {
  private nets: number[] = [];
  private missing: number[] = [];
  constructor(private readonly root: HierNode) {}

  /** Register one bit; its index into read(). */
  net(n: { path: string[]; port: string; bit?: number }): number {
    const node = findNode(this.root, n.path);
    const id = node?.ports[n.port]?.[n.bit ?? 0];
    this.nets.push(id ?? 0);
    if (id === undefined) this.missing.push(this.nets.length - 1);
    return this.nets.length - 1;
  }

  /** Register `width` bits from n.bit up; their indices, low bit first. */
  bus(n: { path: string[]; port: string; bit?: number }, width: number): number[] {
    return Array.from({ length: width }, (_, i) => this.net({ ...n, bit: (n.bit ?? 0) + i }));
  }

  get size(): number {
    return this.nets.length;
  }

  read(sim: Sim): Bit[] {
    const bits = sim.getBits(this.nets);
    for (const i of this.missing) bits[i] = BX;
    return bits;
  }
}

/** Bits (low first) as a number, -1 when one is not 0 or 1. */
export function packBits(bits: readonly Bit[]): number {
  let v = 0;
  for (let i = bits.length - 1; i >= 0; i--) {
    const b = bits[i];
    if (b !== B0 && b !== B1) return -1;
    v = v * 2 + (b === B1 ? 1 : 0);
  }
  return v;
}

/** Segments a…g (bit 0 … 6) of a hex digit. */
export const HEX_SEGMENTS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71];

/** What a DIP chip's pin card lists: pins 1 … dip/2 down the left side, the rest up the right, as on the package. */
export function pinSides(dip: number): { left: number[]; right: number[] } {
  const n = dip / 2;
  return { left: Array.from({ length: n }, (_, i) => i + 1), right: Array.from({ length: n }, (_, i) => dip - i) };
}

/** A pin's name on the card. */
export function pinName(pin: BbPin | undefined, width = 1): string {
  if (pin === undefined) return '';
  if (typeof pin === 'string') return pin;
  return pin.name ?? (width > 1 ? `${pin.port}[${pin.bit ?? 0}]` : pin.port);
}

// ---- the drill: a chip opened from its board ---------------------------------------------------------------

/** What an instance path opens into on the boards: the board it sits on and the chip (none: the board's own module). */
export interface BbDrill {
  board: BbBoard;
  chip: BbChip | null;
}

/** The board and chip `path` is at or inside: the chip whose path is the longest prefix of it, else the board whose
 *  module is a prefix of it; null for a path the boards do not hold (the root, the bus). */
export function drillOf(l: BreadboardLayout, path: readonly string[]): BbDrill | null {
  const pre = (p: readonly string[] | undefined) => !!p && p.length > 0 && p.length <= path.length && p.every((x, i) => x === path[i]);
  let best: BbDrill | null = null, len = 0;
  for (const board of l.boards) {
    for (const chip of board.chips) if (pre(chip.path) && chip.path!.length > len) [best, len] = [{ board, chip }, chip.path!.length];
    if (pre(board.module) && board.module!.length > len) [best, len] = [{ board, chip: null }, board.module!.length];
  }
  return best;
}

export interface BbCrumb {
  label: string;
  /** Its kind, after the label ('74LS173', 'DFFE_R'). */
  kind?: string;
  /** Where a click goes: 'boards' (all of them), an instance path, or nowhere (the level on screen, a board with no module). */
  to: 'boards' | string[] | null;
}

/** The drill pane's breadcrumb for `path` (inside `d`): Boards › the board › the chip › the levels below it, by name. */
export function drillCrumbs(d: BbDrill, path: readonly string[], kindAt: (path: string[]) => string = () => ''): BbCrumb[] {
  const here = (p: readonly string[]) => p.length === path.length;
  const out: BbCrumb[] = [{ label: 'Boards', to: 'boards' }];
  const mod = d.board.module;
  out.push({ label: d.board.title, to: mod && !here(mod) ? [...mod] : null });
  let from = mod?.length ?? 0;
  if (d.chip?.path) {
    const c = d.chip;
    out.push({ label: c.ref ? `${c.ref} · ${c.part}` : c.part, to: here(c.path!) ? null : [...c.path!] });
    from = c.path!.length;
  }
  for (let i = from; i < path.length; i++) {
    const p = path.slice(0, i + 1);
    out.push({ label: path[i], kind: kindAt(p) || undefined, to: here(p) ? null : p });
  }
  return out;
}

/** Below this many px of canvas beside the right-docked panels, the drill stacks the board above the inside. */
export const DRILL_STACK_PX = 760;

/** Where the drill pane (the board, its pins) goes on a canvas `w` × `h` px with `inset` px of right-docked panels:
 *  a left column, or the top part when the canvas is too narrow for two columns. */
export function drillPane(w: number, h: number, inset = 0): { stacked: boolean; w: number; h: number } {
  const free = Math.max(0, w - inset);
  if (free < DRILL_STACK_PX) return { stacked: true, w: free, h: Math.round(Math.max(Math.min(h * 0.5, 460), Math.min(h, 160))) };
  return { stacked: false, w: Math.round(Math.min(620, free * 0.46)), h };
}

// ---- what drives a net ------------------------------------------------------------------------------------

/** What drives an LED's net: an output of a chip on the boards, an input pin of the scene (a switch), or neither (a
 *  net driven inside a module by no chip the boards draw: a wired OR, a constant). */
export type BbDriver = { chip: BbChip; port: string; bit: number } | { input: string; bit: number } | null;

/** The flat net of a layout's bit (-1: the design has no such port). */
export function netIdOf(root: HierNode, n: { path: string[]; port: string; bit?: number }): number {
  return findNode(root, n.path)?.ports[n.port]?.[n.bit ?? 0] ?? -1;
}

/** Who drives flat net `id`: the chips' outputs first (in board order), then the root's inputs. */
export function driverOf(l: BreadboardLayout, root: HierNode, id: number): BbDriver {
  if (id < 0) return null;
  for (const b of l.boards) {
    for (const chip of b.chips) {
      const node = chip.path && findNode(root, chip.path);
      if (!node) continue;
      for (const p of node.def.ports) {
        if (p.dir !== 'out') continue;
        const bit = node.ports[p.name]?.indexOf(id) ?? -1;
        if (bit >= 0) return { chip, port: p.name, bit };
      }
    }
  }
  for (const p of root.def.ports) {
    if (p.dir !== 'in') continue;
    const bit = root.ports[p.name]?.indexOf(id) ?? -1;
    if (bit >= 0) return { input: p.name, bit };
  }
  return null;
}

/** Per board, the chips whose outputs feed the bus strip's instance (its 3-state drivers: the 245s), by board title. */
export function busDrivers(l: BreadboardLayout, root: HierNode, bus: BbBus): Map<string, BbChip[]> {
  const node = findNode(root, bus.path);
  const ins = new Set<number>();
  for (const p of node?.def.ports ?? []) if (p.dir === 'in') for (const id of node!.ports[p.name] ?? []) ins.add(id);
  const out = new Map<string, BbChip[]>();
  for (const b of l.boards) {
    if (b.bus !== bus.id) continue;
    const chips = b.chips.filter((c) => {
      const n = c.path && findNode(root, c.path);
      return !!n && n.def.ports.some((p) => p.dir === 'out' && (n.ports[p.name] ?? []).some((id) => ins.has(id)));
    });
    if (chips.length) out.set(b.title, chips);
  }
  return out;
}

// ---- the keyboard: one roving stop per board -------------------------------------------------------------

/**
 * Where an arrow key moves the focus among a board's controls (boxes in board order): Left / Right the previous /
 * next, Home / End the first / last, Up / Down the nearest one in the row above / below (the nearest row, then the
 * nearest across). The same index when there is none that way.
 */
export function rovingMove(boxes: readonly Box[], i: number, key: string): number {
  const n = boxes.length;
  if (!n) return i;
  if (key === 'ArrowLeft') return Math.max(0, i - 1);
  if (key === 'ArrowRight') return Math.min(n - 1, i + 1);
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return i;
  const c = (b: Box) => [b.x + b.w / 2, b.y + b.h / 2];
  const [cx, cy] = c(boxes[i]);
  const dir = key === 'ArrowDown' ? 1 : -1;
  const tol = boxes[i].h / 2;
  let row = Infinity;
  for (const b of boxes) {
    const dy = (c(b)[1] - cy) * dir;
    if (dy > tol) row = Math.min(row, dy);
  }
  if (row === Infinity) return i;
  let best = i, bx = Infinity;
  boxes.forEach((b, k) => {
    const [x, y] = c(b);
    const dy = (y - cy) * dir;
    if (dy > tol && dy <= row + Math.max(tol, 1) && Math.abs(x - cx) < bx) [best, bx] = [k, Math.abs(x - cx)];
  });
  return best;
}
