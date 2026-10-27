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
