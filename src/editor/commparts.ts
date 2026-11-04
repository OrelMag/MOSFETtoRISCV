// The sandbox's communication parts (Phase 21, "Communication"): the UART core, the UART slave on a bus and the line.
// All three are library parts a document names by id (`line<delay>` and `axi_uart_b` resolve from the name alone in
// lib/resolve.ts, so they survive save, reload, share links and Open in Sandbox with no sanitizer of their own); this
// file is what the editor knows about them, DOM-free (commui.ts draws the palette group and the property sections).
// The NIC and the switch of chapters 48–50 join the same table when those chapters land: a CommPart is a palette item,
// a test for "is this placed part one of mine", and a note on what its box stands for.

import { isLineDef, lineDef, type LineState, MAX_LINE_DELAY } from '../lib/uart';
import { UART_DIV_BITS } from '../comm/uart';
import type { ComponentDef } from '../sim/types';
import type { PartRef } from './model';

export interface CommPart {
  id: string;
  name: string;
  title: string;
  tag?: string;
  ref: PartRef;
  /** Does this placed part belong to the entry (a line of any delay)? */
  owns(ref: PartRef): boolean;
  /** What the box stands for, when it is a model and not transistors (the properties and the exports say so). */
  model?: string;
}

export const LINE_DEFAULT = 2;
export const LINE_MODEL = 'A model of a cable (chapter 41), the one box here that does not end in transistors: opening it shows its panel, not a circuit. It costs nothing, and the exports say so: Verilog leaves it as a comment, and the FPGA export turns d into an output and q into an input of the top module (join them with a wire on the board).';

const isLib = (ref: PartRef, f: (id: string) => boolean) => 'lib' in ref && f(ref.lib);

/** The reference of a line of this delay (cycles of the sender's clock), 1 … MAX_LINE_DELAY. */
export const lineRef = (delay: number): PartRef => ({ lib: `line${delay}` });

/** The delay a line reference names (null for any other part). */
export function lineDelayOf(ref: PartRef): number | null {
  const m = 'lib' in ref ? ref.lib.match(/^line(\d+)$/) : null;
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= MAX_LINE_DELAY && String(n) === m![1] ? n : null;
}

export const COMM_PARTS: CommPart[] = [
  {
    id: 'line', name: 'Line', ref: lineRef(LINE_DEFAULT), owns: (r) => lineDelayOf(r) !== null, model: LINE_MODEL,
    title: 'A wire between two machines as one box: q is what d was a few sender clock cycles ago (the delay is in the properties), noise = 1 at an edge flips the level for a cycle. Idle is 1, like a pulled-up line. A model of a cable: costs nothing',
  },
  {
    id: 'uart', name: 'UART', ref: { lib: 'uart_full' }, owns: (r) => isLib(r, (id) => id === 'uart_full'),
    title: 'Chapter 43\'s UART core in gates: baud generator, transmitter, receiver, a 16-byte FIFO each way. push + data queue a byte to send, pop takes the oldest received; wval with divWe / ieWe / clrWe writes the divisor, interrupt enables and clears the sticky errors. tx and rx are the line pins',
  },
  {
    id: 'uart_bus', name: 'UART slave', tag: 'bus', ref: { lib: 'axi_uart_b' }, owns: (r) => isLib(r, (id) => id === 'axi_uart_b' || id === 'axi_uart'),
    title: 'The UART core behind chapter 38\'s bus, its bus ports packed into a request and a response bus: +0 data, +4 status, +8 divisor, +12 interrupt enables. Give it a slave code on the interconnect (0x3 in Examples ▸ Two computers)',
  },
];

export const commPartOf = (ref: PartRef): CommPart | undefined => COMM_PARTS.find((c) => c.owns(ref));

// ---- reading them ------------------------------------------------------------------------------

/** The UART status register (core output `status`): bit 0 rx not empty, 1 tx full, 2 tx idle, 3 framing error, 4 overrun. */
export const UART_FLAGS = ['rx not empty', 'tx full', 'tx idle', 'framing error', 'overrun'] as const;

export function uartFlags(status: number): { name: string; on: boolean }[] {
  return UART_FLAGS.map((name, i) => ({ name, on: ((status >> i) & 1) === 1 }));
}

/** Clock cycles one bit lasts at divisor `div`: a baud tick every div cycles (every cycle for 0 or 1), 16 ticks a bit. */
export const bitCycles = (div: number): number => 16 * Math.max(1, div);

export const UART_MAX_DIV = 2 ** UART_DIV_BITS - 1;

/** The line part's state (null if the leaf state is something else). */
export const lineStateOf = (s: unknown): LineState | null => (s && typeof s === 'object' && Array.isArray((s as LineState).buf) ? (s as LineState) : null);

/** Is the def a model leaf the exports must call a model (a line)? */
export const isModelDef = (d: ComponentDef | undefined): boolean => isLineDef(d);

export { lineDef };
