// The sandbox's communication parts (Phase 21, "Communication"): the line, the UART core and slave, chapter 50's NIC, the MACs and
// chapter 49's switch, and chapter 44's SPI controller and memory. All are library parts a document names by id (`line<delay>`, `axi_uart_b`,
// `nic_b`, `ethswitch_…` and the others resolve from the name alone in lib/resolve.ts, so they survive save, reload, share links and Open in
// Sandbox with no sanitizer of their own); this file is what the editor knows about them, DOM-free (commui.ts draws the palette group and
// the property sections). A CommPart is a palette item, a test for "is this placed part one of mine", and a note on what its box stands for.
// Only the line is a model; the rest end in NAND gates and flip-flops, and the exports treat them as any other circuit.

import { isLineDef, lineDef, type LineState, MAX_LINE_DELAY } from '../lib/uart';
import { UART_DIV_BITS } from '../comm/uart';
import { ramLeafState } from '../lib/bigmem';
import { switchId, switchOptsOf } from '../lib/ethswitch';
import { CTRL_EN, CTRL_PROMISC } from '../comm/nic';
import type { SwitchOpts } from '../comm/ethswitch';
import type { HierNode } from '../sim/flatten';
import { type ComponentDef, netlistOf } from '../sim/types';
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
/** The switch the palette places: chapter 50's (cells of 128 bytes, two a port: a frame up to 128 bytes, a small simulation); the properties change it. */
export const SANDBOX_SWITCH: Partial<SwitchOpts> = { cellK: 7, cells: 2 };
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
    title: "A wire between two machines as one box: q is what d was a few sender clock cycles ago (the delay is in the properties), noise = 1 at an edge flips the level for a cycle. Idle is 1, like a pulled-up line. A model of a cable: costs nothing",
  },
  {
    id: 'uart', name: 'UART', ref: { lib: 'uart_full' }, owns: (r) => isLib(r, (id) => id === 'uart_full'),
    title: "Chapter 43\'s UART core in gates: baud generator, transmitter, receiver, a 16-byte FIFO each way. push + data queue a byte to send, pop takes the oldest received; wval with divWe / ieWe / clrWe writes the divisor, interrupt enables and clears the sticky errors. tx and rx are the line pins",
  },
  {
    id: 'uart_bus', name: 'UART slave', tag: 'bus', ref: { lib: 'axi_uart_b' }, owns: (r) => isLib(r, (id) => id === 'axi_uart_b' || id === 'axi_uart'),
    title: "The UART core behind chapter 38\'s bus, its bus ports packed into a request and a response bus: +0 data, +4 status, +8 divisor, +12 interrupt enables. Give it a slave code on the interconnect (0x3 in Examples ▸ Two computers)",
  },
  {
    id: 'nic', name: 'NIC', tag: 'bus', ref: { lib: 'nic_b' }, owns: (r) => isLib(r, (id) => id === 'nic_b' || id === 'nic'),
    title: "Chapter 50's network interface card, both its bus links packed: as a slave eight registers at +0 … +28 (control, status, interrupt enable, receive and transmit ring bases, MAC address low and high, doorbell), as a master (put it on a master port of the interconnect) the descriptor and frame DMA. rxd and crs come in from the cable, txd and txen go out; the MACs are inside",
  },
  {
    id: 'mac_rx', name: 'MAC RX', ref: { lib: 'eth_mac_rx' }, owns: (r) => isLib(r, (id) => id === 'eth_mac_rx'),
    title: "Chapter 48's Ethernet receiver: the bit pair rxd / crs of a cable in, the frame's bytes out (data, valid, last, err), filtered by the address on addr. One end of a switch port: the switch takes the byte stream",
  },
  {
    id: 'mac_tx', name: 'MAC TX', ref: { lib: 'eth_mac_tx' }, owns: (r) => isLib(r, (id) => id === 'eth_mac_tx'),
    title: "Chapter 48's Ethernet transmitter: a frame's bytes in (data, valid, last, ready), preamble, padding and FCS added, one bit every four clocks out on txd / txen. The other end of a switch port",
  },
  {
    id: 'switch', name: 'Switch', ref: { lib: switchId(SANDBOX_SWITCH) }, owns: (r) => isLib(r, (id) => switchOptsOf(id) !== null),
    title: "Chapter 49's four-port learning switch: each port is a byte stream in and out (data, valid, last, err; ready for the transmit side), so join each port to a MAC RX and a MAC TX. It learns source addresses in a hashed table, forwards to the learned port and floods the rest. Cell size, cells and the forwarding style are in the properties",
  },
  {
    id: 'spi', name: 'SPI controller', tag: 'bus', ref: { lib: 'axi_spi_b' }, owns: (r) => isLib(r, (id) => id === 'axi_spi_b' || id === 'axi_spi'),
    title: "Chapter 44's SPI master behind the bus: +0 data (a store sends a byte, a load reads the byte that came in), +4 status (bit 0 busy, bit 1 done), +8 control (bit 0 CPOL, bit 1 CPHA, bit 2 hold CS low, bit 3 interrupt enable). Pins sclk, mosi, cs_n, miso. Give it a slave code on the interconnect",
  },
  {
    id: 'spi_mem', name: 'SPI memory', ref: { lib: 'spi_device' }, owns: (r) => isLib(r, (id) => id === 'spi_device'),
    title: "A 256-byte memory behind an SPI port, mode 0, the 25-series commands: 0x03 reads from an address on, 0x02 writes. Clocked by sclk alone",
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

// ---- reading the NIC and the switch ----------------------------------------------------------------------------------

const netIndex = new WeakMap<ComponentDef, Map<string, number>>();
/** The flat nets of the NetDef a node's netlist names `name` (null: none, or the node was not expanded). */
export function netOf(node: HierNode | undefined, name: string): number[] | null {
  if (!node?.nets) return null;
  let m = netIndex.get(node.def);
  if (!m) {
    m = new Map();
    netlistOf(node.def)?.nets.forEach((n, i) => { if (n.name && !m!.has(n.name)) m!.set(n.name, i); });
    netIndex.set(node.def, m);
  }
  const i = m.get(name);
  return i === undefined ? null : node.nets[i] ?? null;
}

/** The minimal reader: the bits of flat nets as 0 / 1 / 2 (X / Z). */
export interface BitReader { getBits(nets: number[]): ArrayLike<number> }

/** Bit i of the nets `<base>0 … <base>n-1` of a node as one number, -1 when a bit is X or a net is missing. */
export function bitsNamed(sim: BitReader, node: HierNode | undefined, base: string, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const nets = netOf(node, `${base}${i}`);
    if (!nets) return -1;
    const b = sim.getBits(nets)[0];
    if (b !== 0 && b !== 1) return -1;
    v += b * 2 ** i;
  }
  return v;
}

/** One bit by net name (-1: X, Z or missing). */
export const bitNamed = (sim: BitReader, node: HierNode | undefined, name: string): number => bitsNamed(sim, node, name, 1) < 0 ? -1 : bitsNamed(sim, node, name, 1);

/** The first net of a node whose name starts `<base><digit>`, per digit (the transmit head's names carry the signal's number: head0_1285). */
function headNets(node: HierNode | undefined): number[][] | null {
  const m = node?.nets ? netlistOf(node.def)?.nets : undefined;
  if (!m || !node?.nets) return null;
  const out: number[][] = [];
  for (let d = 0; d < 3; d++) {
    const i = m.findIndex((n) => n.name !== undefined && new RegExp(`^head${d}(_\d+)?$`).test(n.name));
    if (i < 0) return null;
    out.push(node.nets[i]);
  }
  return out;
}

export function headValue(sim: BitReader, node: HierNode | undefined): number {
  const h = headNets(node);
  if (!h) return -1;
  let v = 0;
  for (let i = 0; i < 3; i++) { const b = sim.getBits(h[i])[0]; if (b !== 0 && b !== 1) return -1; v += b << i; }
  return v;
}

export const TX_STAGES = [['s_d1', 'reading the descriptor'], ['s_d0', 'reading the buffer address'], ['s_word', 'fetching a word'], ['s_send', 'sending bytes'], ['s_wait', 'waiting for the frame to leave'], ['s_wb', 'writing the descriptor back']] as const;

export interface NicView {
  en: number; promisc: number; ie: number; status: number; rxbase: number; txbase: number; mac: string;
  rxHead: number; txHead: number; rxActive: number; txStage: string | null;
}

/** The NIC's registers and engines, read off the nets by name (node: the `nic` box). null when it was not expanded. */
export function nicView(sim: BitReader, nic: HierNode): NicView | null {
  const regs = nic.children?.get('regs'), rx = nic.children?.get('rx'), tx = nic.children?.get('tx');
  if (!regs?.nets || !rx?.nets || !tx?.nets) return null;
  const st = [bitNamed(sim, regs, 's_rx'), bitNamed(sim, regs, 's_tx'), bitNamed(sim, regs, 's_miss'), bitNamed(sim, regs, 's_bad')];
  const ie = [bitNamed(sim, regs, 'ie0'), bitNamed(sim, regs, 'ie1')];
  const lo = bitsNamed(sim, regs, 'macl', 32), hi = bitsNamed(sim, regs, 'mach', 16);
  const bytes = lo < 0 || hi < 0 ? null : [lo & 255, (lo >>> 8) & 255, (lo >>> 16) & 255, lo >>> 24, hi & 255, hi >> 8];
  const rb = bitsNamed(sim, regs, 'rxbase', 10), tb = bitsNamed(sim, regs, 'txbase', 10);
  const stage = TX_STAGES.find(([n]) => bitNamed(sim, tx, n) === 1);
  return {
    en: bitNamed(sim, regs, 'en'), promisc: bitNamed(sim, regs, 'promisc'), ie: ie.some((b) => b < 0) ? -1 : ie[0] + 2 * ie[1],
    status: st.some((b) => b < 0) ? -1 : st[0] + 2 * st[1] + 4 * st[2] + 8 * st[3],
    rxbase: rb < 0 ? -1 : rb * 64, txbase: tb < 0 ? -1 : tb * 64, mac: bytes ? bytes.map((b) => b.toString(16).padStart(2, '0')).join(':') : 'X',
    rxHead: headValue(sim, rx), txHead: headValue(sim, tx), rxActive: bitNamed(sim, rx, 'act'), txStage: stage ? stage[1] : null,
  };
}

export const NIC_FLAGS = ['frame received', 'frame sent', 'missed (no free descriptor)', 'bad frame'] as const;
export const nicFlags = (status: number): { name: string; on: boolean }[] => NIC_FLAGS.map((name, i) => ({ name, on: ((status >> i) & 1) === 1 }));
void CTRL_EN; void CTRL_PROMISC;

/** Frames the head moved by since `prev` (the ring holds eight descriptors, so one step of 0 … 7 is exact when read every edge). */
export const headSteps = (prev: number, now: number): number => (prev < 0 || now < 0 ? 0 : (now - prev + 8) % 8);

export interface TableRow { mac: string; port: number; age: number; live: boolean; slot: number }

/** Age ticks an entry stays live (comm/ethswitch.ts AGE_TICKS). */
export const TABLE_LIVE = 64;

export const macText = (key: number): string => {
  const hex = key.toString(16).padStart(12, '0');
  return hex.match(/../g)!.join(':');
};

/** The switch's learned table, read from the two memories of its MAC table box (node: the switch). null when it was not built so. */
export function switchTable(sim: BitReader & { leafState(i: number): unknown }, sw: HierNode): TableRow[] | null {
  const tb = sw.children?.get('tb'), ram = tb?.children?.get('ram'), age = tb?.children?.get('age');
  const a = ramLeafState(sim, ram?.children?.get('ramA')), b = ramLeafState(sim, ram?.children?.get('ramB'));
  if (!a || !b) return null;
  const tick = bitsNamed(sim, age, 'tick', 8);
  const rows: TableRow[] = [];
  for (let i = 0; i < a.mem.length; i++) {
    if (a.x[i] || b.x[i]) continue;
    const wb = b.mem[i], valid = (wb >>> 16) & 1;
    if (!valid) continue;
    const key = (wb & 0xffff) * 2 ** 32 + a.mem[i], port = (wb >>> 17) & 3, stamp = (wb >>> 19) & 255;
    const age8 = tick < 0 ? -1 : (tick - stamp + 256) % 256;
    rows.push({ mac: macText(key), port, age: age8, live: age8 >= 0 && age8 < TABLE_LIVE, slot: i });
  }
  return rows;
}

/** A switch part's options, or null for another part. */
export const switchOptsOfRef = (ref: PartRef): SwitchOpts | null => ('lib' in ref ? switchOptsOf(ref.lib) : null);
export const switchRef = (o: SwitchOpts): PartRef => ({ lib: switchId(o) });
