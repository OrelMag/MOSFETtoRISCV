// The sandbox's document model: plain JSON that the user edits, saves and shares. A circuit
// is a chip (as in Digital Logic Sim): its pins become the ports of the ComponentDef that
// compile.ts builds from it, so a packaged chip simulates, opens, counts and exports like any
// library part. Nothing here touches the DOM (the tests run in Node).
//
// Coordinates are grid units (1 unit = 10 px), the same as netlist layouts. Wires store only
// their interior corners: the ends follow the pins they attach to, so moving a part never
// detaches a wire. Corners are meant to be orthogonal; `polyline` repairs a diagonal step
// (left by a move) with an L, horizontal first. A `straight` wire (a simple connection, as in
// Turing Complete) instead joins its breakpoints with straight segments at any angle.

import type { IsaDoc } from '../isa/table';
import type { CustomRow } from '../riscv/custom';
import type { Custom16Row } from '../riscv/rv16/custom16';
import type { Microprogram } from '../lib/multicycle';
import { instPort, type ExitDir, type Vec } from '../sim/geometry';
import type { ComponentDef } from '../sim/types';
import type { CpuDoc } from './cpu';
import type { ProbeTarget } from './probes';
import type { ReaderRef } from './cardparts';
import type { ScreenRef } from './ioparts';

export type { Vec, ExitDir };

export const SCHEMA = 1;

export interface Workspace {
  schema: typeof SCHEMA;
  chips: Record<string, ChipDoc>;
  /** Tab stack of open chips (ids), last = active. */
  open: string[];
  /** Palette limited to transistors, NAND, IO, wiring and user chips. */
  purist?: boolean;
  /** Palette items pinned at the top, in order: '<group>/<item>' keys (palette.ts). Number keys 1–9 arm the first nine. */
  favorites?: string[];
  /** Custom instruction sets (the ISA editor) by id; ROMs that use one hold a copy of it. */
  isas?: Record<string, IsaDoc>;
  /**
   * Folders of "My chips", in order (folders.ts): one level, a chip in at most one. Kept out of the
   * chip documents so filing a chip recompiles nothing and changes no export, link or import match.
   */
  folders?: FolderDoc[];
}

/**
 * A chip drawn from Verilog. One source makes a group of chips, one per module: the top module's chip holds the
 * text (`src`), the others name it (`of`). `stale`: the body does not match the text yet (synthesized when shown).
 */
export interface HdlDoc {
  module: string;
  src?: { file: string; text: string; top?: string; gates: 'nand' | 'std' | 'aoi' };
  of?: string;
  stale?: true;
}

/**
 * A chip drawn from a truth table (ttable.ts): 1-bit inputs and outputs, one character per row and output ('0', '1',
 * '-' for don't care); a row's index is the inputs read as a binary number, the first input most significant. The
 * body is the minimized logic, redrawn on every edit of the table.
 */
/**
 * A test table on a chip, in Digital's test syntax (testtable.ts): a line of signal names (the chip's pins), then rows
 * of 0 / 1 / X / Z / C / numbers / (expressions), repeat(n), loop(v, n) … end loop, let, bits(n, e). Kept as text: what
 * the learner typed is what is stored, and a Digital Testcase imports unchanged.
 */
export interface TestDoc {
  name: string;
  src: string;
}

/**
 * A breakpoint (breakpoints.ts): Run stops after the step on which its condition holds (breakexpr.ts), or, with `pc`, when the
 * instruction at that address retires (the CPU drawer's gutter). Kept on the chip, never compiled.
 */
export interface BreakDoc {
  id: string;
  cond?: string;
  pc?: number;
  /** Switched off in the list (kept, not checked). */
  off?: true;
  /** Checked on every change of its signals (gate mode), not only after rising edges. */
  gate?: true;
}

export interface TableDoc {
  ins: string[];
  outs: string[];
  /** Per output, 2^ins.length characters. */
  rows: string[];
  /**
   * NAND–NAND (NANDs and inverters only), AND–OR (AND, OR, NOT gates), PLA (both rails of every input, an AND plane
   * of the shared terms, an OR plane) or ROM (every row stored, don't cares as 0: nothing minimized).
   */
  form: 'nand' | 'andor' | 'pla' | 'rom';
  /** Drawn for this state-machine chip (fsmchip.ts): its table follows the machine, edited only there. */
  of?: string;
}

/**
 * A chip drawn from a state machine (fsmchip.ts): 1-bit inputs and outputs, states (Moore outputs: the outputs at 1),
 * arcs taken on an input pattern (the first matching arc out of a state wins; none: the state stays), with Mealy
 * outputs. The chip gets rst (synchronous, to the reset state) and clk; its body places a next-state table chip, the
 * state flip-flops and an output table chip (<id>_next, <id>_out: TableDoc.of names this chip).
 */
export interface FsmDoc {
  ins: string[];
  outs: string[];
  states: FsmStateDoc[];
  arcs: FsmArcDoc[];
  /** Index of the reset (and power-on) state. */
  reset: number;
  encoding: 'binary' | 'gray' | 'onehot';
  /** How its two tables are built (TableDoc.form): a ROM next-state function is a microprogrammed controller. */
  form: TableDoc['form'];
  /** Codes no state has go to the reset state (else don't cares: cheapest). */
  safe?: true;
  /** A datapath (fsmd.ts): registers the states load, data inputs and outputs, tests on the arcs. */
  data?: FsmDataDoc;
  /** Generated for this chip (a datapath machine's controller): edited only there. */
  of?: string;
}

/** A state machine's datapath: every data input, register and data output is `width` bits. */
export interface FsmDataDoc {
  width: number;
  ins: string[];
  regs: string[];
  /** Data outputs: each shows a register or a data input. */
  outs: { name: string; src: string }[];
}

export interface FsmStateDoc {
  name: string;
  at: [number, number];
  out?: string[];
  /** Register transfers at the clock edge leaving the state: reg := expr (fsmd.ts), at most one per register. */
  act?: { reg: string; expr: string }[];
}

export interface FsmArcDoc {
  from: number;
  to: number;
  /** Input values the arc needs (an input left out: either). */
  when: Record<string, 0 | 1>;
  /** Mealy outputs at 1 while this arc is the one the next edge takes. */
  out?: string[];
  /** Datapath tests the arc also needs (fsmd.ts): a comparison (a < b, x = 0) or a register bit (a[7]), true or false. */
  test?: { expr: string; is: 0 | 1 }[];
  /** Drawn by hand: the curve's bend (a self-loop's angle in degrees), the label's offset. Absent: placed automatically. */
  bend?: number;
  loop?: number;
  dx?: number;
  dy?: number;
}

export interface FolderDoc {
  name: string;
  /** Chip ids in the order the palette lists them. */
  chips: string[];
}

export interface ChipDoc {
  /** 'u_<slug>': stable across renames, a valid Verilog identifier, unique in the workspace. */
  id: string;
  name: string;
  /** Box tint (0–359), shown when the chip is placed. */
  hue?: number;
  notes?: string;
  /** How the chip looks when placed (absent: inputs left, outputs right, sized to fit; face.ts). */
  face?: FaceDoc;
  /**
   * "This chip is a flip-flop": pin names of d, q, clk (and en). Compiled into ComponentDef.ff
   * once a short clocked test confirms it (static timing then stops at it; synthesis export
   * writes it as a process).
   */
  ff?: { d: string; q: string; clk: string; en?: string };
  /** "This chip is a processor": its program ROM, PC, registers, ... (cpu.ts; absent fields are detected). */
  cpu?: CpuDoc;
  /**
   * The rate its automatic clock starts at (settings.autoClock; absent: AUTO_HZ). The examples with a CPU set it:
   * at 2 Hz their program showed nothing for minutes. Not compiled (library.ts leaves it out of the hash).
   */
  hz?: number;
  /** Drawn from Verilog (hdl.ts): its body is generated by Yosys from the source, edited only as text. */
  hdl?: HdlDoc;
  /** Drawn from a truth table (ttable.ts): its body is generated from it, edited only as the table. */
  table?: TableDoc;
  /** Drawn from a state machine (fsmchip.ts): its body is generated, edited only as the machine. */
  fsm?: FsmDoc;
  /** Test tables run against the chip (testtable.ts): never compiled, so editing one rebuilds nothing. */
  tests?: TestDoc[];
  /** Breakpoints (breakpoints.ts): never compiled, like the tests. */
  breaks?: BreakDoc[];
  pins: PinDoc[];
  parts: PartDoc[];
  wires: WireDoc[];
  labels: LabelDoc[];
  /** Free-text notes on the canvas: drawn, saved and shared, never compiled (absent: none). */
  comments?: CommentDoc[];
  /** Titled frames drawn around groups of parts: saved and shared, never compiled (absent: none). */
  sections?: SectionDoc[];
  /** The fault brush's faults (faultui.ts): saved with the chip, never compiled into it; the simulation applies those on. */
  faults?: FaultDoc[];
}

/**
 * A fault on something the user drew (sim/faults.ts): stuck at 0 or 1, or slow (+delay gate delays). Its target is
 * named as a probe's is (probes.ts), so it follows the net through edits; `bit`: one bit of a bus (absent: every bit).
 */
export interface FaultDoc {
  id: string;
  kind: 'stuck0' | 'stuck1' | 'slow';
  target: ProbeTarget;
  bit?: number;
  delay?: number;
  /** Switched off in the list (kept, not applied). */
  off?: boolean;
}

/**
 * One of the chip's own pins. Inputs become `in` ports, outputs `out` ports, bidirectional pins
 * `inout` ports (switch level only: a transistor terminal brought out, like an SRAM cell's bit
 * lines; any number of transistors, and the chip's parent, may drive the net).
 */
export interface PinDoc {
  id: string;
  /** Port name: unique within the chip, identifier characters only, no '.'. */
  name: string;
  dir: 'in' | 'out' | 'inout';
  width: number;
  /** Connection point (where wires attach). */
  at: Vec;
  /** Direction a wire leaves the pin (inputs and inouts default 'right', outputs 'left'). */
  face?: ExitDir;
  /** Inputs only: how the user drives it. 'clock' marks the port `clock: true`. */
  kind?: 'toggle' | 'button' | 'clock';
  /** Inputs only: the value it is set to (kept across reloads). See PinValue. */
  value?: PinValue;
}

/**
 * A pin's value: a number while it is exact (below 2^53), else lowercase hex text '0x…' (a wide
 * pin, up to MAX_WIDTH bits). One value has one spelling (pinValue), so `===` compares values.
 */
export type PinValue = number | string;

/** The canonical PinValue of a non-negative BigInt. */
export const pinValue = (v: bigint): PinValue => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : `0x${v.toString(16)}`);

/** A PinValue as a BigInt (absent: 0). */
export const pinBig = (v: PinValue | undefined): bigint => (v === undefined ? 0n : BigInt(v));

/** Is `x` a PinValue as stored (a safe non-negative integer, or 0x hex text)? */
export const isPinValue = (x: unknown): x is PinValue =>
  typeof x === 'number' ? Number.isSafeInteger(x) && x >= 0 : typeof x === 'string' && /^0x[0-9a-f]+$/i.test(x);

/** All ones on a w-bit pin. */
export const allOnes = (w: number): PinValue => pinValue((1n << BigInt(w)) - 1n);

export interface PartDoc {
  /** Instance name: unique within the chip, identifier characters only, no '.'. */
  id: string;
  ref: PartRef;
  /** Top-left of the symbol (of its turned box when rot is set). */
  at: Vec;
  /** Mirrored left–right (before the turn). */
  flip?: boolean;
  /** Quarter turns clockwise (R). */
  rot?: 1 | 2 | 3;
  /** Caption (defaults to the id). */
  label?: string;
}

/**
 * A packaged chip's appearance (the Package dialog's face editor), all optional: a box size, pins
 * placed by hand, displays shown on the box. Size and pins left out are automatic (inputs left,
 * outputs right, in canvas order), and the box always grows to fit what is on it (face.ts resolveFace).
 */
export interface FaceDoc {
  /** Box size in grid units. */
  w?: number;
  h?: number;
  /** Pin id → side and offset along it (y on the left / right, x on the top / bottom); a pin left out goes to its default side. */
  pins?: Record<string, FacePinDoc>;
  /** Displays inside the chip drawn on its box, live. */
  displays?: FaceDisplayDoc[];
  /** Leave the chip's name off the box. */
  noLabel?: boolean;
}

export type FaceSide = 'left' | 'right' | 'top' | 'bottom';
export interface FacePinDoc { side: FaceSide; at: number }

/**
 * A display on the face: the path of part ids down to it (a display or I/O part of this chip, or one
 * a placed chip shows on its own face), the top-left of what it shows and a scale.
 */
export interface FaceDisplayDoc { path: string[]; at: Vec; scale?: number }

export type DisplayKind = 'led' | 'seg7' | 'hex' | 'value' | 'halt' | 'buzzer';

export type PartRef =
  /** Any library component, by id (registry, family key or generator pattern). */
  | { lib: string }
  /** A user chip of this workspace. */
  | { chip: string }
  | { split: number[]; pitch?: number }
  | { merge: number[]; pitch?: number }
  | { const: { width: number; value: number } }
  /**
   * Pure view: zero-cost sink that shows the value of the net on its input `a` (a wide LED: a bank,
   * one LED per bit; 'halt': stops Run while it is non-zero; 'buzzer': sounds while it is non-zero).
   */
  | { display: DisplayKind; width?: number }
  /**
   * A keyboard key (KeyboardEvent.key, letters lowercase: 'a', ' ', 'Enter', 'ArrowUp'): the 1-bit
   * output q is 1 while the key is held. An input from outside the circuit: zero cost.
   */
  | { key: string }
  /**
   * A keyboard: typed keys wait in order; `code` is the oldest (ASCII, 0 when none), `ready` says one
   * waits, `ack` removes it (sampled at rising clock edges, or continuously without a clock). Zero cost.
   */
  | { keyboard: true }
  /** A terminal: prints data (ASCII) on a rising clk edge with we = 1; cols × rows on the canvas (ioparts.ts). Zero cost. */
  | { console: { cols: number; rows: number } }
  /** A bank of 1–32 toggle switches the learner clicks: q = their positions. An input from outside the circuit: zero cost. */
  | { switches: number }
  /** A pixel screen: a frame buffer written pixel by pixel, rows latched from a bus, or one wire per pixel (ioparts.ts). Zero cost. */
  | { screen: ScreenRef }
  /**
   * A program puzzle's port (editor/puzzleparts.ts): 'in' hands the circuit the test's words (data, ready; read takes one at a
   * rising clk edge), 'out' records the words written (data at a rising clk edge with we = 1). Zero cost.
   */
  | { puzzle: 'in' | 'out'; width: number }
  /**
   * A card reader (editor/cardparts.ts, cards/reader.ts): a deck of punched cards held in the document like a ROM's program;
   * next = 1 at a rising clk edge takes the card (word mode) or column (column mode) on data, ready says one waits. Zero cost.
   */
  | { reader: ReaderRef }
  /** The Manchester Baby (lib/baby.ts) with a program in its store, in the Baby's assembly (ssem/asm.ts): 32 lines, one per word. */
  | { baby: { src: string } }
  /** Read-only memory: 2^k words of w bits. 'rv32' addresses bytes like a PC (addr = 4·word). */
  | { rom: { k: number; w: 8 | 12 | 16 | 24 | 32; addr: 'word' | 'rv32'; lang: 'asm' | 'hex' | 'rv16' | 'cpu4' | 'dsp24' | 'isa' | '6502'; src: string;
      /** lang 'isa': the instruction set, a copy of the workspace's table (so the ROM builds on its own, in a share link too). */
      isa?: IsaDoc;
      /** lang 'asm': the CPU's custom instructions (riscv/custom.ts), a copy of its core's rows, so the program assembles. */
      custom?: CustomRow[];
      /** lang 'rv16': the RV16 core's own instructions (riscv/rv16/custom16.ts), a copy of its core's rows, so the program assembles. */
      custom16?: Custom16Row[];
      /** lang 'asm' / 'hex': the MAC core's mac, mac2, clracc and racc assemble and disassemble (riscv/isa.ts MAC_INSTRS). */
      mac?: true;
      /** lang 'asm' (or hex), byte addressed: the C extension. The ROM answers at any even address with the 32 bits starting there (lib/rvc.ts cWindowRom); `.option rvc` needs it. */
      c?: boolean;
      /** lang 'asm': assembled for RV64 (ld, sd, the W instructions, li of any 64-bit constant); the words stay 32-bit instructions. */
      xlen?: 64 } }
  /** The memory-port RV32I core (rv32i_core) with custom instructions: its control unit gains a class per row. */
  | { core: { custom: CustomRow[]; /** The pipelined core (rv32i_pipe_core) instead of the single-cycle one. */ pipe?: true;
      /** Pipelined only: the M extension inside (rv32im_pipe_core). */ m?: true;
      /** Pipelined only: a write-through data cache in M in front of the memory port (rv32i_pipe_dc_core; not with m). */ dcache?: true } }
  /** The campaign's RV16 reference core (rv16_cpu) or its pipeline (rv16_pipe_111) with custom instructions: rows in OPX's free funct3 values. */
  | { core16: { custom: Custom16Row[]; /** The five-stage pipeline instead of the single-cycle core. */ pipe?: true } }
  /** The multicycle CPU's microprogrammed controller (mc_micro) with edited microcode: its ROMs hold this program (lib/ucode.ts). */
  | { ucode: Microprogram }
  /** Read-write memory: 2^k words of w bits; `init`: the words it holds at power-on ('to 0' mode). */
  /** ports: a read and a write port per lane (2 … 8; lib/portmem.ts: addr<i>, wd<i>, we, clk → rd<i>), up to 1K words. */
  | { ram: { k: number; w: number; init?: number[]; ports?: number } };

/** Where a wire ends. A branch ends on another wire at a point of its polyline. */
export type EndRef =
  | { part: string; port: string }
  | { pin: string }
  | { label: string }
  | { wire: string; at: Vec };

/** A net's chosen colour (editor/wirehue.ts): an OKLCH hue, or 'auto' for its colour-per-net hue. */
export type NetHue = number | 'auto';

export interface WireDoc {
  id: string;
  a: EndRef;
  b: EndRef;
  /** Interior corners, from a to b (a straight wire's breakpoints). */
  pts: Vec[];
  /** Simple connection: straight segments between the points, at any angle (absent: horizontal and vertical legs). */
  straight?: true;
  /** Optional net name (shown in the inside view, used by `init`). */
  name?: string;
  /** Switch level: the net keeps its charge when undriven (DRAM node, bit line). */
  cap?: boolean;
  /** Power-on value of the net in 'zero' reset mode (a latch's stored bit). */
  init?: 0 | 1;
  /** Colour of its net (the whole net shows the colour most of its wires and pointers carry). */
  hue?: NetHue;
}

/**
 * A pointer (net label): every label with the same name is the same net, with no wire between
 * them, like the tags on the site's large schematics. `at` is where wires attach; the flag
 * points away from it in direction `face`.
 */
export interface LabelDoc {
  id: string;
  name: string;
  at: Vec;
  face?: ExitDir;
  /** Colour of its net, as on a wire. */
  hue?: NetHue;
}

/** A comment on the canvas, as in Turing Complete: `at` is its top-left corner, `text` may span lines. */
export interface CommentDoc {
  id: string;
  at: Vec;
  text: string;
}

/** Comment text size and line height (grid units; monospace, so the box is known without a DOM). */
export const COMMENT_FONT = 1.1;
export const COMMENT_LINE = 1.5;
const COMMENT_PAD = 0.6;

/** A comment's lines and its box (hit testing, rubber band, drawing). */
export function commentBox(c: CommentDoc): { lines: string[]; x: number; y: number; w: number; h: number } {
  const lines = c.text.split('\n');
  const cols = Math.max(1, ...lines.map((l) => l.length));
  return { lines, x: c.at[0], y: c.at[1], w: cols * COMMENT_FONT * 0.6 + 2 * COMMENT_PAD, h: lines.length * COMMENT_LINE + COMMENT_PAD };
}

/**
 * A section: a titled, dashed frame drawn under the circuit around a group of parts. It owns nothing: dragging it
 * moves what lies fully inside it at that moment, deleting it leaves its contents. `at` is the top-left corner.
 */
export interface SectionDoc {
  id: string;
  at: Vec;
  size: Vec;
  title: string;
  /** Hue of the frame and its title (0–359; absent: the theme's neutral colour). */
  hue?: number;
}

/** The smallest section, and how far inside its border a click still takes it (grid units). */
export const SECTION_MIN = 4;
export const SECTION_EDGE = 0.6;

/** The title's box: comment-sized text inside the frame's top-left corner (an empty title keeps a short box to grab). */
export function sectionTitleBox(s: SectionDoc): { x: number; y: number; w: number; h: number } {
  const cols = Math.max(4, s.title.length);
  return { x: s.at[0] + 0.3, y: s.at[1] + 0.2, w: Math.min(s.size[0] - 0.6, cols * COMMENT_FONT * 0.6 + 2 * COMMENT_PAD), h: COMMENT_LINE };
}

/** The section's four corners, top-left first, clockwise (the resize handles). */
export function sectionCorners(s: SectionDoc): Vec[] {
  const [x, y] = s.at, [w, h] = s.size;
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

// ---------------------------------------------------------------------------------------------
// Helpers shared by compile, ops and the view.

export const emptyChip = (id: string, name: string): ChipDoc => ({ id, name, pins: [], parts: [], wires: [], labels: [] });

export const emptyWorkspace = (): Workspace => {
  const c = emptyChip('u_main', 'Main');
  return { schema: SCHEMA, chips: { [c.id]: c }, open: [c.id] };
};

/** An identifier-safe slug: letters, digits and '_', not starting with a digit. */
export function slug(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return !s ? 'chip' : /^\d/.test(s) ? `_${s}` : s;
}

/** prefix, prefix_2, prefix_3, ... : the first not in `taken`. */
export function uniqueName(prefix: string, taken: Iterable<string>): string {
  const t = new Set(taken);
  if (!t.has(prefix)) return prefix;
  for (let i = 2; ; i++) if (!t.has(`${prefix}_${i}`)) return `${prefix}_${i}`;
}

/** Next free id with a short prefix: g1, g2, ... */
export function nextId(prefix: string, taken: Iterable<string>): string {
  const t = new Set(taken);
  for (let i = 1; ; i++) if (!t.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

export const isIdent = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

/** Stable string key of an endpoint (union-find, maps). */
export function endKey(e: EndRef): string {
  if ('part' in e) return `p:${e.part}.${e.port}`;
  if ('pin' in e) return `pin:${e.pin}`;
  if ('label' in e) return `lbl:${e.label}`;
  return `w:${e.wire}@${e.at[0]},${e.at[1]}`;
}

/** Inputs and inouts sit on the left of a chip's box (geometry.ts), so their pins face right. */
export const defaultFace = (p: PinDoc): ExitDir => p.face ?? (p.dir === 'out' ? 'left' : 'right');

/** Resolves a part to its definition (compile supplies it; undefined = unresolved part). */
export type DefOf = (part: PartDoc) => ComponentDef | undefined;

/** Position and exit direction of an endpoint, or null if it does not resolve. */
export function endGeom(doc: ChipDoc, e: EndRef, defOf: DefOf): { pos: Vec; exit: ExitDir | null } | null {
  if ('part' in e) {
    const p = doc.parts.find((q) => q.id === e.part);
    const d = p && defOf(p);
    if (!p || !d || !d.ports.some((q) => q.name === e.port)) return null;
    return instPort(d, p.at, p.flip, e.port, p.rot);
  }
  if ('pin' in e) {
    const p = doc.pins.find((q) => q.id === e.pin);
    return p ? { pos: p.at, exit: defaultFace(p) } : null;
  }
  if ('label' in e) {
    const l = doc.labels.find((q) => q.id === e.label);
    // A wire enters a label opposite to where its flag points.
    return l ? { pos: l.at, exit: OPP[l.face ?? 'right'] } : null;
  }
  return { pos: e.at, exit: null };
}

const OPP: Record<ExitDir, ExitDir> = { left: 'right', right: 'left', up: 'down', down: 'up' };

/**
 * The full drawn polyline of a wire: a's position, the corners, b's position. A diagonal step
 * gets an L corner (leaving the previous point horizontally) unless the wire is straight;
 * duplicates and collinear middle points are dropped. Null when an end does not resolve.
 */
export function polyline(doc: ChipDoc, w: WireDoc, defOf: DefOf): Vec[] | null {
  const a = endGeom(doc, w.a, defOf);
  const b = endGeom(doc, w.b, defOf);
  if (!a || !b) return null;
  return (w.straight ? straightLine : orthogonal)([a.pos, ...w.pts, b.pos]);
}

/** A straight wire's points: duplicates and middle points lying on the line through their neighbours dropped. */
export function straightLine(pts: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push([p[0], p[1]]);
  }
  for (let i = out.length - 2; i >= 1; i--) if (between(out[i - 1], out[i + 1], out[i])) out.splice(i, 1);
  return out;
}

/** p lies on segment a–b, exactly (a straight wire's redundant breakpoint). */
function between(a: Vec, b: Vec, p: Vec): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  return cross === 0 && (p[0] - a[0]) * (p[0] - b[0]) <= 0 && (p[1] - a[1]) * (p[1] - b[1]) <= 0;
}

export function orthogonal(pts: Vec[]): Vec[] {
  const out: Vec[] = [];
  const push = (p: Vec) => {
    const l = out[out.length - 1];
    if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push([p[0], p[1]]);
  };
  for (const p of pts) {
    const l = out[out.length - 1];
    if (l && l[0] !== p[0] && l[1] !== p[1]) push([p[0], l[1]]);
    push(p);
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]];
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) out.splice(i, 1);
  }
  return out;
}

/**
 * How far off a slanted segment a point may be and still lie on it: a branch point on a straight
 * wire's diagonal is a projection, stored rounded (roundPt).
 */
export const ON_EPS = 1e-3;

/** A point rounded to ON_EPS / 10 (what a branch point on a diagonal stores). */
export const roundPt = (p: Vec): Vec => [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4];

/** True if p lies on segment a–b: exactly on a horizontal or vertical one, within ON_EPS on a slanted one. */
export function onSegment(a: Vec, b: Vec, p: Vec): boolean {
  if (a[0] === b[0]) return p[0] === a[0] && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
  if (a[1] === b[1]) return p[1] === a[1] && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]);
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  if (t < -ON_EPS || t > 1 + ON_EPS) return false;
  return Math.abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / Math.hypot(dx, dy) <= ON_EPS;
}

/** True if p lies on the polyline. */
export function onPolyline(pts: Vec[], p: Vec): boolean {
  for (let i = 1; i < pts.length; i++) if (onSegment(pts[i - 1], pts[i], p)) return true;
  return false;
}

/** Chips this chip places directly. */
export function chipDeps(doc: ChipDoc): string[] {
  return [...new Set(doc.parts.flatMap((p) => ('chip' in p.ref ? [p.ref.chip] : [])))];
}

/** The pipelined port cores by library id: rv32i_pipe_core, rv32im_pipe_core (M), rv32i_pipe_dc_core (a data cache). */
export const PIPE_CORE_LIB = /^rv32i(m)?_pipe(_dc)?_core$/;

/** What a placed RV32I port core is (null: not the single-cycle or pipelined RV32I port core): pipelined or not, M, data cache, custom rows. */
export function portCoreOf(ref: PartRef): { pipe: boolean; m: boolean; dcache: boolean; custom: CustomRow[] } | null {
  if ('core' in ref) return { pipe: !!ref.core.pipe, m: !!ref.core.m, dcache: !!ref.core.dcache, custom: ref.core.custom };
  if (!('lib' in ref)) return null;
  if (ref.lib === 'rv32i_core') return { pipe: false, m: false, dcache: false, custom: [] };
  const p = PIPE_CORE_LIB.exec(ref.lib);
  return p ? { pipe: true, m: !!p[1], dcache: !!p[2], custom: [] } : null;
}

/** The RV16 cores that take custom rows: the reference single-cycle core and the five-stage pipeline (no traps: their illegal-instruction detector would refuse a row). */
export const RV16_CUSTOM_LIBS = { single: 'rv16_cpu', pipe: 'rv16_pipe_111' } as const;

/** What a placed RV16 core that takes custom rows is (null: another part), with its rows. */
export function rv16CoreOf(ref: PartRef): { pipe: boolean; custom: Custom16Row[] } | null {
  if ('core16' in ref) return { pipe: !!ref.core16.pipe, custom: ref.core16.custom };
  if (!('lib' in ref)) return null;
  return ref.lib === RV16_CUSTOM_LIBS.single ? { pipe: false, custom: [] } : ref.lib === RV16_CUSTOM_LIBS.pipe ? { pipe: true, custom: [] } : null;
}

/** The part for an RV16 core: its library id without rows, else { core16 }. */
export function rv16CoreRef(o: { pipe: boolean; custom: Custom16Row[] }): PartRef {
  return o.custom.length ? { core16: { custom: o.custom, ...(o.pipe ? { pipe: true as const } : {}) } } : { lib: o.pipe ? RV16_CUSTOM_LIBS.pipe : RV16_CUSTOM_LIBS.single };
}

/** The part for a port core: a library id while it has no custom rows, else { core } (m and dcache only on the pipelined one, not together). */
export function portCoreRef(o: { pipe: boolean; m?: boolean; dcache?: boolean; custom: CustomRow[] }): PartRef {
  const m = o.pipe && !!o.m, dcache = o.pipe && !!o.dcache && !m;
  if (o.custom.length) return { core: { custom: o.custom, ...(o.pipe ? { pipe: true as const } : {}), ...(m ? { m: true as const } : {}), ...(dcache ? { dcache: true as const } : {}) } };
  return { lib: !o.pipe ? 'rv32i_core' : `rv32i${m ? 'm' : ''}_pipe${dcache ? '_dc' : ''}_core` };
}
