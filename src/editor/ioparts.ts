// The sandbox's I/O parts beyond keys and displays: a console (a terminal the circuit writes
// characters to), a switch bank (N toggle switches the learner flips) and a pixel screen (three
// ways to drive it: a frame buffer written pixel by pixel, rows latched from a bus, or one wire
// per pixel). Nothing here touches the DOM (ioface.ts draws them, ioui.ts adds their panels).
//
// The console, the switch bank and the screen's write and rows modes are behavioural leaves
// with no structure (sim/types isExternal): zero cost, a comment in Verilog, leaves of every
// simulation. Their state is the leaf's private state, so it survives a rebuild (carry: same path,
// same definition id), steps back with Sim.saveState / restoreState and goes with a power cycle
// (Sim.reset re-runs init), except the switches: EditorSim puts their positions back, like a held
// key, since they are the world outside the circuit. The console and the clocked screens sample
// their inputs when their own clk input rises (the leaf is evaluated as the edge arrives, before
// anything the edge causes has had a gate delay to propagate: a register's view of its D).
//
// Visual settings (a console's size, a screen's scale and look) are part of the definition
// object but not of its id, so changing them rebuilds the simulation and carries the text or the
// picture over. The pixels mode is a pure view (an alias box with no aliases, like the LED bank):
// what is on the wire is on the screen.
//
// Bit order follows the LED bank: the most significant field first, so a row of a rows-mode bus
// reads left to right as the number is written (pixel x = field W−1−x), and the pixels-mode bus
// is the whole picture, top-left pixel in the top field.

import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { B0, B1, type Bit, type ComponentDef, type NetDef, type PortDef } from '../sim/types';
import { splitter } from '../lib/define';

/** Widest bus (parts.ts MAX_WIDTH; kept here to avoid an import cycle, a test checks they agree). */
export const IO_MAX_BITS = 1024;

export type IoInfo =
  | { kind: 'console'; cols: number; rows: number }
  | { kind: 'switches'; width: number }
  | { kind: 'screen'; ref: ScreenRef };

const infos = new WeakMap<ComponentDef, IoInfo>();
/** What an I/O part's definition is (null for any other definition). */
export const ioInfo = (d: ComponentDef | undefined): IoInfo | null => (d && infos.get(d)) ?? null;

const even = (x: number) => 2 * Math.ceil(x / 2);
/** Width of the strip holding the port names inside the box (left, or right when flipped). */
const STRIP = 4;

export interface FaceLayout {
  w: number; h: number;
  /** The screen / terminal area. */
  face: { x: number; y: number; w: number; h: number };
  /** Port names drawn inside the box. */
  labels: { text: string; x: number; y: number; anchor: 'start' | 'middle' | 'end' }[];
}

/** Box pins: inputs on the left at y = 2, 4, …; clk at the bottom (x = 2); outputs on the right. */
function boxPorts(ins: PortDef[], clk: boolean, outs: PortDef[]): { ports: PortDef[]; portPos: Record<string, number> } {
  const portPos: Record<string, number> = {};
  ins.forEach((p, i) => (portPos[p.name] = 2 + 2 * i));
  outs.forEach((p, i) => (portPos[p.name] = 2 + 2 * i));
  const ports = [...ins, ...(clk ? [{ name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true, doc: 'Samples the inputs on its rising edge' } as PortDef] : []), ...outs];
  if (clk) portPos.clk = 2;
  return { ports, portPos };
}

/** Where the face and the port names go in a box of w × h (mirrored when the part is flipped). */
function layoutOf(def: ComponentDef, fw: number, fh: number, flip: boolean): FaceLayout {
  const w = def.symbol.w!, h = def.symbol.h!;
  const pos = def.symbol.portPos ?? {};
  const fx = flip ? w - STRIP - fw : STRIP;
  const labels: FaceLayout['labels'] = [];
  for (const p of def.ports) {
    const v = pos[p.name];
    if (v === undefined) continue;
    if (p.side === 'bottom') labels.push({ text: p.name, x: flip ? w - v : v, y: h - 0.45, anchor: 'middle' });
    else if (p.dir === 'out') labels.push({ text: p.name, x: flip ? 0.4 : w - 0.4, y: v + 0.3, anchor: flip ? 'start' : 'end' });
    else labels.push({ text: p.name, x: flip ? w - 0.4 : 0.4, y: v + 0.3, anchor: flip ? 'end' : 'start' });
  }
  return { w, h, face: { x: fx, y: 1, w: fw, h: fh }, labels };
}

// ---- console ---------------------------------------------------------------------------------

/** Every console shares this id: its text does not depend on its size (resizing keeps it). */
export const CONSOLE_ID = 'console';
export const CONSOLE_COLS = { min: 8, max: 80, def: 32 };
export const CONSOLE_ROWS = { min: 2, max: 40, def: 8 };
/** Lines of scrollback a console keeps (older ones go). */
export const CONSOLE_SCROLLBACK = 500;
/** A line longer than this continues on the next one (the text stays bounded). */
const MAX_LINE = 2000;
/** Character cell of the terminal face, grid units. */
export const CON_CH = 0.6;
export const CON_LINE = 1;

/** Private state of a console leaf: the clock level last seen, the lines (the last one is being written), characters taken. */
export interface ConsoleState { c: number; lines: string[]; n: number }

export const consoleInit = (): ConsoleState => ({ c: -1, lines: [''], n: 0 });

/** What a character code shows as on the console (one character; control codes as their pictures). */
export function consoleGlyph(code: number): string {
  if (code < 0) return '▒'; // unknown (X): a shaded block
  if (code >= 32 && code < 127) return String.fromCharCode(code);
  if (code < 32) return String.fromCharCode(0x2400 + code); // ␀ ␁ …
  if (code === 127) return '␡'; // ␡
  return '·'; // 128–255: not ASCII
}

/**
 * Take one character: \n a new line, \b erases the last character of the line, \f (0x0C) clears,
 * \r is ignored (CR LF prints once), \t pads to the next multiple of 8; anything else as a glyph.
 */
export function consoleAppend(st: ConsoleState, code: number): void {
  st.n++;
  const L = st.lines;
  if (code === 10) L.push('');
  else if (code === 12) st.lines = [''];
  else if (code === 13) return;
  else if (code === 8) L[L.length - 1] = L[L.length - 1].slice(0, -1);
  else if (code === 9) L[L.length - 1] += ' '.repeat(8 - (L[L.length - 1].length % 8));
  else {
    if (L[L.length - 1].length >= MAX_LINE) L.push('');
    L[L.length - 1] += consoleGlyph(code);
  }
  if (st.lines.length > CONSOLE_SCROLLBACK) st.lines.splice(0, st.lines.length - CONSOLE_SCROLLBACK);
}

/** The whole text (scrollback included). */
export const consoleText = (st: ConsoleState): string => st.lines.join('\n');

/** The last `rows` rows of the text wrapped at `cols` (fewer when there is less text). */
export function consoleRows(st: ConsoleState, cols: number, rows: number): string[] {
  const out: string[] = [];
  for (let i = st.lines.length - 1; i >= 0 && out.length < rows; i--) {
    const l = st.lines[i];
    const parts: string[] = [];
    for (let k = 0; k < Math.max(1, l.length); k += cols) parts.push(l.slice(k, k + cols));
    out.unshift(...parts.slice(Math.max(0, parts.length - (rows - out.length))));
  }
  return out;
}

const consoleCache = new Map<string, ComponentDef>();

export function consoleLayout(def: ComponentDef, flip: boolean): FaceLayout {
  const i = ioInfo(def) as Extract<IoInfo, { kind: 'console' }>;
  return layoutOf(def, i.cols * CON_CH + 1, i.rows * CON_LINE + 1, flip);
}

/** A console of cols × rows characters on screen (the text it keeps does not depend on them). */
export function consolePart(cols: number, rows: number): ComponentDef {
  const key = `${cols}x${rows}`;
  let d = consoleCache.get(key);
  if (d) return d;
  const fw = cols * CON_CH + 1, fh = rows * CON_LINE + 1;
  const { ports, portPos } = boxPorts([
    { name: 'data', width: 8, dir: 'in', doc: 'The character (ASCII) taken at the clock edge' },
    { name: 'we', width: 1, dir: 'in', doc: 'Write: 1 takes data at the next rising clk edge' },
  ], true, []);
  d = {
    id: CONSOLE_ID, name: 'Console', category: 'plumbing',
    summary: 'A terminal: on a rising clk edge with we = 1 it prints the character on data (ASCII; \\n new line, \\b backspace, '
      + '\\f clears; other control codes show as their symbols). Keeps 500 lines of scrollback; Reset clears it. '
      + 'Outside the circuit: no gates, nothing in Verilog.',
    ports,
    symbol: { kind: 'box', label: '', w: even(STRIP + fw + 1), h: even(Math.max(fh + 3, 6)), portPos },
    behavior: {
      init: consoleInit,
      eval: ([data, we, clk], s) => {
        const st = s as ConsoleState;
        if (clk === 1 && st.c === 0 && we === 1) consoleAppend(st, data);
        st.c = clk;
        return [];
      },
    },
  };
  infos.set(d, { kind: 'console', cols, rows });
  consoleCache.set(key, d);
  return d;
}

// ---- switch bank -----------------------------------------------------------------------------

export const SWITCH_PREFIX = 'switches_';
export const MAX_SWITCHES = 32;
/** Switches per row and their pitch (grid units). */
const SW_ROW = 8;
export const SW_PITCH = 1.4;
export const SW_ROW_H = 2.2;

/** Private state of a switch bank: the positions, bit i = switch i. */
export interface SwitchState { v: number }

export function switchGrid(w: number): { cols: number; rows: number; w: number; h: number; x0: number; y0: number } {
  const cols = Math.min(w, SW_ROW), rows = Math.ceil(w / SW_ROW);
  const bw = Math.max(4, even(cols * SW_PITCH + 1.2)), bh = even(rows * SW_ROW_H + 1.6);
  return { cols, rows, w: bw, h: bh, x0: (bw - cols * SW_PITCH) / 2, y0: 0.4 };
}

/** Where switch `bit` sits (its cell's top-left; most significant first, rows of 8). */
export function switchCell(w: number, bit: number): [number, number] {
  const g = switchGrid(w), i = w - 1 - bit;
  return [g.x0 + SW_PITCH * (i % g.cols), g.y0 + SW_ROW_H * Math.floor(i / g.cols)];
}

/** The switch under a point of the part (local grid units, unflipped), or null. */
export function switchAt(w: number, x: number, y: number): number | null {
  const g = switchGrid(w);
  const c = Math.floor((x - g.x0) / SW_PITCH), r = Math.floor((y - g.y0) / SW_ROW_H);
  if (c < 0 || c >= g.cols || r < 0 || r >= g.rows) return null;
  const i = r * g.cols + c;
  return i < w ? w - 1 - i : null;
}

/** The value with switch `bit` flipped (exact up to 32 bits). */
export const flipSwitch = (v: number, bit: number): number => (Math.floor(v / 2 ** bit) % 2 ? v - 2 ** bit : v + 2 ** bit);

const switchCache = new Map<number, ComponentDef>();

/** A bank of w toggle switches: q = their positions (bit i = switch i, most significant on the left). */
export function switchBank(w: number): ComponentDef {
  let d = switchCache.get(w);
  if (d) return d;
  const g = switchGrid(w);
  d = {
    id: `${SWITCH_PREFIX}${w}`, name: w > 1 ? `Switches (${w})` : 'Switch', category: 'plumbing',
    summary: 'Toggle switches: click one on the canvas (also while running, or inside a placed chip from look inside or the Screens panel). '
      + 'q = their positions, most significant on the left. They keep their positions through Reset. Outside the circuit: no gates, nothing in Verilog.',
    ports: [{ name: 'q', width: w, dir: 'out', doc: 'The switch positions (bit i = switch i)' }],
    symbol: { kind: 'box', label: '', w: g.w, h: g.h, noPortLabels: true },
    behavior: { init: (): SwitchState => ({ v: 0 }), eval: (_i, s) => [(s as SwitchState).v] },
  };
  infos.set(d, { kind: 'switches', width: w });
  switchCache.set(w, d);
  return d;
}

/** Every switch bank's positions now, to put back after `sim.reset` (they are the world outside). */
export function holdSwitches(sim: Sim): () => void {
  const saved: [number, unknown][] = [];
  sim.design.leaves.forEach((l, li) => { if (l.def.id.startsWith(SWITCH_PREFIX)) saved.push([li, sim.leafState(li)]); });
  return () => { for (const [li, s] of saved) if (s !== undefined) sim.poke(li, s); };
}

// ---- pixel screen ----------------------------------------------------------------------------

export type ScreenMode = 'write' | 'rows' | 'pixels';
export type ColorFormat = 'mono' | 'rgb111' | 'pal16' | 'rgb332' | 'rgb565';

/** A screen part's settings (PartRef.screen). */
export interface ScreenRef {
  mode: ScreenMode;
  /** Pixels per side: 8, 16, 32, 64 or 128. */
  size: number;
  color: ColorFormat;
  /** Round dots (an LED matrix) instead of square pixels. */
  look?: 'dots';
  /** Size on the canvas (default 2). */
  scale?: 1 | 2 | 4;
  /** Lines between pixels. */
  grid?: true;
  /** write / rows: a vsync output, high for one cycle every N rising edges. */
  vsync?: number;
}

export const SCREEN_SIZES = [8, 16, 32, 64, 128] as const;
export const SCREEN_MODES: ScreenMode[] = ['write', 'rows', 'pixels'];
export const COLOR_FORMATS: ColorFormat[] = ['mono', 'rgb111', 'pal16', 'rgb332', 'rgb565'];
export const COLOR_BITS: Record<ColorFormat, number> = { mono: 1, rgb111: 3, pal16: 4, rgb332: 8, rgb565: 16 };
export const COLOR_NAMES: Record<ColorFormat, string> = { mono: 'Mono (1 bit)', rgb111: 'RGB111 (3 bits)', pal16: '16-colour palette (4 bits)', rgb332: 'RGB332 (8 bits)', rgb565: 'RGB565 (16 bits)' };
export const MAX_VSYNC = 1 << 20;
/** Side of the face on the canvas at scale 1, grid units, by size. */
const FACE_SIDE: Record<number, number> = { 8: 4, 16: 6, 32: 8, 64: 12, 128: 16 };

/**
 * The classic 16-colour palette (CGA / EGA, IBM PC order): 0 black, 1 blue, 2 green, 3 cyan, 4 red,
 * 5 magenta, 6 brown, 7 light grey, 8 dark grey, 9–14 the bright blue … yellow, 15 white.
 */
export const PAL16 = [0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xaa5500, 0xaaaaaa,
  0x555555, 0x5555ff, 0x55ff55, 0x55ffff, 0xff5555, 0xff55ff, 0xffff55, 0xffffff];
/** A lit mono pixel (green phosphor), the same in both themes. */
export const MONO_ON = 0x3ddc84;
/** colorRgb's results that are not a colour: an unknown pixel, and an unlit mono pixel (the theme's "off"). */
export const PX_X = -1;
export const PX_OFF = -2;

/** The 0xRRGGBB colour of value v in a format (PX_OFF: mono 0, PX_X: unknown). */
export function colorRgb(fmt: ColorFormat, v: number): number {
  if (v < 0) return PX_X;
  const x5 = (c: number) => (c << 3) | (c >> 2), x6 = (c: number) => (c << 2) | (c >> 4);
  switch (fmt) {
    case 'mono': return v & 1 ? MONO_ON : PX_OFF;
    case 'rgb111': return (v & 4 ? 0xff0000 : 0) | (v & 2 ? 0xff00 : 0) | (v & 1 ? 0xff : 0);
    case 'pal16': return PAL16[v & 15];
    case 'rgb332': return (Math.round(((v >> 5) & 7) * 255 / 7) << 16) | (Math.round(((v >> 2) & 7) * 255 / 7) << 8) | Math.round((v & 3) * 255 / 3);
    case 'rgb565': return (x5((v >> 11) & 31) << 16) | (x6((v >> 5) & 63) << 8) | x5(v & 31);
  }
}

const log2 = (n: number) => Math.round(Math.log2(n));

/** Why a screen setting cannot be built (null: it can). */
export function screenProblem(r: ScreenRef): string | null {
  if (!SCREEN_MODES.includes(r.mode)) return `screen: unknown mode '${String(r.mode)}'`;
  if (!(SCREEN_SIZES as readonly number[]).includes(r.size)) return 'screen: size must be 8, 16, 32, 64 or 128';
  if (!COLOR_FORMATS.includes(r.color)) return `screen: unknown colour format '${String(r.color)}'`;
  const c = COLOR_BITS[r.color];
  if (r.mode === 'pixels' && r.size * r.size * c > IO_MAX_BITS) return `screen: ${r.size}×${r.size} at ${c} bit${c > 1 ? 's' : ''} is a ${r.size * r.size * c}-bit bus (at most ${IO_MAX_BITS}): smaller, or the rows or write mode`;
  if (r.mode === 'rows' && r.size * c > IO_MAX_BITS) return `screen: a row of ${r.size} pixels at ${c} bits is ${r.size * c} bits (at most ${IO_MAX_BITS})`;
  if (r.scale !== undefined && r.scale !== 1 && r.scale !== 2 && r.scale !== 4) return 'screen: scale 1, 2 or 4';
  if (r.vsync !== undefined && (r.mode === 'pixels' || !Number.isInteger(r.vsync) || r.vsync < 1 || r.vsync > MAX_VSYNC)) return `screen: vsync every 1–${MAX_VSYNC} edges (write and rows modes)`;
  return null;
}

/** Private state of a write / rows screen: its picture (PX values: −1 unknown) and counters. */
export interface ScreenState {
  /** The clock level last seen. */
  c: number;
  px: Int32Array;
  /** Bumped on every change of the picture (what a view redraws on). */
  ver: number;
  /** Pixels (write) or rows (rows mode) taken. */
  writes: number;
  edges: number;
  /** vsync pulses so far. */
  frames: number;
  /** Writes ignored or clock edges unclear because of an X (we / load / clk / x / y / row unknown). */
  warns: number;
  /** vsync now. */
  vs: number;
}

export const screenInit = (n: number) => (): ScreenState => ({ c: -1, px: new Int32Array(n * n), ver: 0, writes: 0, edges: 0, frames: 0, warns: 0, vs: 0 });

/**
 * The clock of a write / rows screen: `take` runs on a rising edge; an X on clk counts a warning
 * (whether it rose is unknown, so nothing is written). Returns the outputs (vsync, when it has one).
 */
function clocked(st: ScreenState, clk: number, vsync: number | undefined, take: () => void): number[] {
  if (clk !== st.c) {
    if (clk === 1 && st.c === 0) {
      st.edges++;
      take();
      if (vsync) {
        st.vs = st.edges % vsync === 0 ? 1 : 0;
        if (st.vs) st.frames++;
      }
    } else if (clk < 0 && st.c >= 0) st.warns++;
    st.c = clk;
  }
  return vsync ? [st.vs] : [];
}

const screenCache = new Map<string, ComponentDef>();

const screenKey = (r: ScreenRef) => `${r.mode}/${r.size}/${r.color}/${r.vsync ?? 0}/${r.scale ?? 2}/${r.look ?? ''}/${r.grid ? 1 : 0}`;
/** The id: what the state depends on (not the scale or look, so changing those keeps the picture). */
const screenId = (r: ScreenRef) => `${SCREEN_PREFIX}${r.mode[0]}${r.size}_${r.color}${r.vsync ? `_v${r.vsync}` : ''}`;
export const SCREEN_PREFIX = 'screen_';

export function screenLayout(def: ComponentDef, flip: boolean): FaceLayout {
  const r = (ioInfo(def) as Extract<IoInfo, { kind: 'screen' }>).ref;
  const f = FACE_SIDE[r.size] * (r.scale ?? 2);
  return layoutOf(def, f, f, flip);
}

/** The pixel screen in one of its three modes (screenProblem first: this assumes a valid setting). */
export function screenPart(r: ScreenRef): ComponentDef {
  const key = screenKey(r);
  let d = screenCache.get(key);
  if (d) return d;
  const n = r.size, c = COLOR_BITS[r.color], lg = log2(n);
  const f = FACE_SIDE[n] * (r.scale ?? 2);
  const vs: PortDef[] = r.vsync ? [{ name: 'vsync', width: 1, dir: 'out', doc: `1 for one cycle every ${r.vsync} rising clk edges` }] : [];
  const fmt = `${n}×${n} · ${COLOR_NAMES[r.color]}`;
  let ins: PortDef[];
  if (r.mode === 'write') {
    ins = [
      { name: 'x', width: lg, dir: 'in', doc: 'Column of the pixel to write (0 = left)' },
      { name: 'y', width: lg, dir: 'in', doc: 'Row of the pixel to write (0 = top)' },
      { name: 'color', width: c, dir: 'in', doc: `The pixel's new colour (${COLOR_NAMES[r.color]})` },
      { name: 'we', width: 1, dir: 'in', doc: 'Write: 1 stores color at (x, y) at the next rising clk edge' },
    ];
  } else if (r.mode === 'rows') {
    ins = [
      { name: 'row', width: lg, dir: 'in', doc: 'The row to load (0 = top)' },
      { name: 'data', width: n * c, dir: 'in', doc: `The row's ${n} pixels, ${c} bit${c > 1 ? 's' : ''} each, the leftmost in the most significant bits` },
      { name: 'load', width: 1, dir: 'in', doc: 'Load: 1 stores data into the row at the next rising clk edge' },
    ];
  } else ins = [{ name: 'px', width: n * n * c, dir: 'in', doc: `Every pixel, ${c} bit${c > 1 ? 's' : ''} each, row by row from the top-left one in the most significant bits` }];
  const clk = r.mode !== 'pixels';
  const { ports, portPos } = boxPorts(ins, clk, vs);
  const symbol = { kind: 'box' as const, label: '', w: even(STRIP + f + (r.vsync ? 5 : 1)), h: even(Math.max(f + (clk ? 3 : 2), 2 * ins.length + 2)), portPos };
  const base = { id: screenId(r), name: `Screen ${n}×${n}`, category: 'plumbing' as const, ports, symbol };
  const tail = ' Its picture is simulation state: kept through edits, cleared by Reset. Outside the circuit: no gates, nothing in Verilog.';
  if (r.mode === 'pixels') {
    d = { ...base, summary: `${fmt}, one wire per pixel: shows what is on px, no clock, no memory. Pure view: no gates, no delay.`, prim: 'alias', alias: [] };
  } else if (r.mode === 'write') {
    d = {
      ...base,
      summary: `${fmt}, with its own frame buffer: on a rising clk edge with we = 1, pixel (x, y) takes color.${r.vsync ? ` vsync: 1 for one cycle every ${r.vsync} edges.` : ''}${tail}`,
      behavior: {
        init: screenInit(n),
        eval: ([x, y, color, we, ck], s) => {
          const st = s as ScreenState;
          return clocked(st, ck, r.vsync, () => {
            if (we < 0) st.warns++;
            else if (we === 1) {
              if (x < 0 || y < 0) st.warns++;
              else {
                st.px[y * n + x] = color;
                st.writes++;
                st.ver++;
              }
            }
          });
        },
      },
    };
  } else d = { ...base, summary: `${fmt}, loaded a row at a time: on a rising clk edge with load = 1, row takes data (the leftmost pixel in the top bits).${r.vsync ? ` vsync: 1 for one cycle every ${r.vsync} edges.` : ''}${tail}`, ...rowsStructure(r, n, c) };
  infos.set(d, { kind: 'screen', ref: { ...r } });
  screenCache.set(key, d);
  return d;
}

/**
 * A rows-mode screen: the row bus can be wider than a simulator's packed behaviour inputs are
 * exact (53 bits), so a splitter cuts it into whole pixels of at most 32 bits for the leaf that
 * holds the picture (pure wiring: still zero cost).
 */
function rowsStructure(r: ScreenRef, n: number, c: number): Pick<ComponentDef, 'netlist'> {
  const per = Math.floor(32 / c);
  const chunks: number[] = [];
  for (let px = 0; px < n; px += per) chunks.push(Math.min(per, n - px) * c);
  const core = rowsCore(r, n, c, chunks);
  const sp = splitter(chunks);
  const nl = {
    pins: { row: [0, 2] as [number, number], load: [0, 4] as [number, number], clk: [0, 6] as [number, number], data: [0, 10 + chunks.length] as [number, number], ...(r.vsync ? { vsync: [30, 2] as [number, number] } : {}) },
    instances: [{ name: 'sp', def: sp, at: [6, 10] as [number, number] }, { name: 'core', def: core, at: [14, 0] as [number, number], label: 'picture' }],
    nets: [
      { name: 'row', ends: ['row', 'core.row'] },
      { name: 'load', ends: ['load', 'core.load'] },
      { name: 'clk', ends: ['clk', 'core.clk'] },
      { name: 'data', ends: ['data', 'sp.in'] },
      ...chunks.map((_, i): NetDef => ({ ends: [`sp.o${i}`, `core.d${i}`] })),
      ...(r.vsync ? [{ name: 'vsync', ends: ['core.vsync', 'vsync'] }] : []),
    ],
  };
  return { netlist: () => nl };
}

const coreCache = new Map<string, ComponentDef>();

/** The leaf of a rows-mode screen: the picture, loaded a row at a time from data cut into chunks d0, d1, … (d0 = the low bits). */
function rowsCore(r: ScreenRef, n: number, c: number, chunks: number[]): ComponentDef {
  const id = `${screenId(r)}_core`;
  let d = coreCache.get(id);
  if (d) return d;
  const per = Math.floor(32 / c), M = 2 ** c;
  d = {
    id, name: 'Screen picture', category: 'plumbing',
    summary: `The picture of a ${n}×${n} screen (rows mode): ${n * n} pixels of ${c} bits. Outside the circuit: no gates.`,
    ports: [
      { name: 'row', width: log2(n), dir: 'in' }, { name: 'load', width: 1, dir: 'in' }, { name: 'clk', width: 1, dir: 'in', clock: true },
      ...chunks.map((w, i): PortDef => ({ name: `d${i}`, width: w, dir: 'in' })),
      ...(r.vsync ? [{ name: 'vsync', width: 1, dir: 'out' } as PortDef] : []),
    ],
    symbol: { kind: 'box', label: 'picture' },
    behavior: {
      init: screenInit(n),
      eval: (ins, s) => {
        const st = s as ScreenState;
        const [row, load, ck] = ins;
        return clocked(st, ck, r.vsync, () => {
          if (load < 0) st.warns++;
          else if (load === 1) {
            if (row < 0) { st.warns++; return; }
            for (let x = 0; x < n; x++) {
              const f = n - 1 - x, ch = ins[3 + Math.floor(f / per)];
              st.px[row * n + x] = ch < 0 ? -1 : Math.floor(ch / M ** (f % per)) % M;
            }
            st.writes++;
            st.ver++;
          }
        });
      },
    },
  };
  coreCache.set(id, d);
  return d;
}

/** A pixels-mode screen's picture from the bits on its px bus (−1 where a pixel has an X or Z bit). */
export function pixelsOf(bits: readonly Bit[], n: number, fmt: ColorFormat, out: Int32Array = new Int32Array(n * n)): Int32Array {
  const c = COLOR_BITS[fmt], N = n * n;
  for (let p = 0; p < N; p++) {
    const f = N - 1 - p;
    let v = 0;
    for (let b = c - 1; b >= 0; b--) {
      const bit = bits[f * c + b];
      if (bit !== B0 && bit !== B1) { v = -1; break; }
      v = v * 2 + bit;
    }
    out[p] = v;
  }
  return out;
}

/** The colours a picture needs from the theme (0xRRGGBB). */
export interface ScreenTheme { off: number; gap: number; x: number }

/** Canvas pixels per screen pixel: 1 for square pixels, more for dots or grid lines (at least 256 px a side). */
export const screenRes = (n: number, look: 'dots' | undefined, grid: boolean): number => (look === 'dots' || grid ? Math.min(32, Math.max(4, Math.ceil(256 / n))) : 1);

const masks = new Map<string, Uint8Array>();

/** Per canvas pixel of one screen pixel's k × k cell: 1 lit, 0 gap (a dot's surround, a grid line). */
function cellMask(k: number, look: 'dots' | undefined, grid: boolean): Uint8Array {
  const key = `${k}/${look ?? ''}/${grid ? 1 : 0}`;
  let m = masks.get(key);
  if (m) return m;
  m = new Uint8Array(k * k).fill(1);
  const r = k * 0.42, c = (k - 1) / 2;
  for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
    if (look === 'dots' && (i - c) ** 2 + (j - c) ** 2 > r * r) m[j * k + i] = 0;
    if (grid && k >= 3 && (i === k - 1 || j === k - 1)) m[j * k + i] = 0;
  }
  masks.set(key, m);
  return m;
}

/** 0xRRGGBB as one canvas pixel of a Uint32 view of ImageData (little-endian: A B G R). */
const rgba = (c: number) => (0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff)) >>> 0;

/**
 * Paint a picture into a Uint32 view of an ImageData of (n·k)² pixels: each pixel's colour, the
 * theme's off colour for an unlit mono pixel, gaps for dots and grid lines, and an unknown pixel as
 * an X drawn in the X colour (k ≥ 4) or a checkerboard of it (k < 4).
 */
export function paintScreen(out: Uint32Array, px: ArrayLike<number>, n: number, fmt: ColorFormat, k: number, look: 'dots' | undefined, grid: boolean, th: ScreenTheme): void {
  const m = cellMask(k, look, grid), W = n * k;
  const off = rgba(th.off), gap = rgba(th.gap), xc = rgba(th.x);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = px[y * n + x], rgb = colorRgb(fmt, v);
    const on = rgb === PX_OFF ? off : rgb === PX_X ? xc : rgba(rgb);
    for (let j = 0; j < k; j++) {
      let o = (y * k + j) * W + x * k;
      for (let i = 0; i < k; i++, o++) {
        let col = m[j * k + i] ? on : gap;
        if (rgb === PX_X) col = k >= 4 ? (i === j || i === k - 1 - j ? xc : gap) : ((x + y + i + j) & 1 ? xc : gap);
        out[o] = col;
      }
    }
  }
}

// ---- finding them in a simulation --------------------------------------------------------------

export interface IoNode { path: string[]; node: HierNode; info: IoInfo; def: ComponentDef }

/** Every I/O part under `root`, at any depth (a user chip's own ones after it, depth first). */
export function ioNodes(root: HierNode, out: IoNode[] = []): IoNode[] {
  for (const c of root.children?.values() ?? []) {
    const info = ioInfo(c.def);
    if (info) out.push({ path: c.path, node: c, info, def: c.def });
    else if (c.children) ioNodes(c, out);
  }
  return out;
}

/** The leaf holding an I/O part's state (a rows-mode screen keeps it one level down), if it has one. */
export function ioLeaf(node: HierNode): number | undefined {
  return node.leafIndex ?? node.children?.get('core')?.leafIndex;
}

/** The private state of an I/O part's leaf (undefined for a pixels-mode screen). */
export function ioState(sim: Sim, node: HierNode): unknown {
  const li = ioLeaf(node);
  return li === undefined ? undefined : sim.leafState(li);
}

/** A fresh state for an I/O part's leaf (Clear), keeping the clock level it last saw. */
export function clearedState(info: IoInfo, old: unknown): unknown {
  const c = (old as { c?: number } | undefined)?.c ?? -1;
  if (info.kind === 'console') return { ...consoleInit(), c };
  if (info.kind === 'screen') {
    const o = old as ScreenState | undefined;
    return { ...screenInit(info.ref.size)(), c, ver: (o?.ver ?? 0) + 1, vs: o?.vs ?? 0 };
  }
  return old;
}

// ---- documents -----------------------------------------------------------------------------------

type IoRef = { console: { cols: number; rows: number } } | { switches: number } | { screen: ScreenRef };
const intIn = (x: unknown, lo: number, hi: number): x is number => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;

/** The definition of a console / switch-bank / screen part reference, an error, or null for any other reference. */
export function ioRefDef(ref: object): ComponentDef | { error: string } | null {
  if ('console' in ref) {
    const c = (ref as Extract<IoRef, { console: unknown }>).console;
    if (!c || !intIn(c.cols, CONSOLE_COLS.min, CONSOLE_COLS.max) || !intIn(c.rows, CONSOLE_ROWS.min, CONSOLE_ROWS.max)) {
      return { error: `console: ${CONSOLE_COLS.min}–${CONSOLE_COLS.max} columns, ${CONSOLE_ROWS.min}–${CONSOLE_ROWS.max} rows` };
    }
    return consolePart(c.cols, c.rows);
  }
  if ('switches' in ref) {
    const w = (ref as { switches: unknown }).switches;
    return intIn(w, 1, MAX_SWITCHES) ? switchBank(w) : { error: `switch bank: 1–${MAX_SWITCHES} switches` };
  }
  if ('screen' in ref) {
    const r = (ref as { screen: ScreenRef }).screen;
    if (!r || typeof r !== 'object') return { error: 'screen: no settings' };
    const why = screenProblem(r);
    return why ? { error: why } : screenPart(r);
  }
  return null;
}

/** An I/O part reference rebuilt field by field from untrusted JSON (store.ts), null when it is none or broken. */
export function sanitizeIoRef(r: Record<string, unknown>): IoRef | null {
  if ('console' in r) {
    const c = r.console as Record<string, unknown> | null;
    return c && typeof c === 'object' && intIn(c.cols, CONSOLE_COLS.min, CONSOLE_COLS.max) && intIn(c.rows, CONSOLE_ROWS.min, CONSOLE_ROWS.max) ? { console: { cols: c.cols, rows: c.rows } } : null;
  }
  if ('switches' in r) return intIn(r.switches, 1, MAX_SWITCHES) ? { switches: r.switches } : null;
  if ('screen' in r) {
    const s = r.screen as Record<string, unknown> | null;
    if (!s || typeof s !== 'object') return null;
    const out: ScreenRef = { mode: s.mode as ScreenMode, size: s.size as number, color: s.color as ColorFormat };
    if (s.look === 'dots') out.look = 'dots';
    if (s.scale === 1 || s.scale === 2 || s.scale === 4) out.scale = s.scale;
    if (s.grid === true) out.grid = true;
    if (s.vsync !== undefined) out.vsync = s.vsync as number;
    return screenProblem(out) ? null : { screen: out };
  }
  return null;
}
