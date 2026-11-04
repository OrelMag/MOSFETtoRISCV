// Chapter 43's UART in gates: a baud generator (a 16× tick), a transmitter and a receiver around the book's universal
// shift register, two 16-byte FIFOs (lib/storage.ts fifo), a status register, and the core as a slave on chapter 38's
// bus. comm/uart.ts is the same machine edge by edge (tests/comm-uart.test.ts compares every output every cycle).
//
// Reset is all zeros, so the polarities are chosen to make zero mean idle: the transmitter stores the inverse of its line
// (`ntx`), the receiver synchronizes the inverse of its input, and the baud counter's reset value (0) is a tick every cycle
// until the divisor is written.

import { UART_DIV_BITS } from '../comm/uart';
import type { ComponentDef, PortDef } from '../sim/types';
import { isZero } from './alu';
import { andBus, kit, slaveFsm, slavePorts } from './axi';
import { Builder } from './builder';
import { decoder, incrementer, muxTree } from './combinational';
import { define } from './define';
import { DFF, DFFE, register } from './sequential';
import { shiftRegister } from './seqparts';
import { fifo } from './storage';
import { SYNC2 } from './sync';
import { bitwise } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** Pins down the left (inputs) and right (outputs), three units apart. */
function sidePins(ports: PortDef[], right: number): Record<string, [number, number]> {
  const pins: Record<string, [number, number]> = {};
  let yl = 2, yr = 2;
  for (const p of ports) if (p.dir === 'in') { pins[p.name] = [0, yl]; yl += 3; } else { pins[p.name] = [right, yr]; yr += 3; }
  return pins;
}

/** n-bit decrement: ~(~x + 1). */
function decrement(b: Builder, g: ReturnType<typeof kit>, n: number, x: string): string {
  const ones = g.konst(n, 2 ** n - 1);
  return b.op1(bitwise('xor', n), [b.op1(incrementer(n), [b.op1(bitwise('xor', n), [x, ones])]), ones], 'x − 1');
}

// ---- the baud generator ------------------------------------------------------------------------------------------------

/**
 * A programmable divider: an n-bit down counter reloaded with div when it reaches 1 (or 0), so tick is high one cycle in
 * every `div` (every cycle for div = 0 or 1). Sixteen ticks make a bit.
 */
export function baudGen(n = UART_DIV_BITS): ComponentDef {
  return memo(`baud${n}`, () => {
    const b = new Builder(10, 12), g = kit(b);
    b.pins('div', 'clk');
    const cnt = b.op(register(n), ['', g.konst(1, 1), 'clk'], 'down counter', 'cnt');
    const [, hi] = g.split(`${cnt}.q`, [1, n - 1]);
    const tick = b.name(b.op1(isZero(n - 1), [hi], 'count ≤ 1'), 'tick', true);
    b.next();
    const dec = decrement(b, g, n, `${cnt}.q`);
    b.wire(g.mux(n, dec, 'div', tick), `${cnt}.d`);
    b.wire(tick, 'tick');
    b.wire(`${cnt}.q`, 'cnt');
    const ports: PortDef[] = [bus('div', n, 'in'), bit('clk', 'in', 'bottom', true), bit('tick', 'out'), bus('cnt', n, 'out')];
    return define({
      id: `baud${n}`, name: `Baud generator (${n}-bit divisor)`, category: 'sequential',
      summary: `A ${n}-bit down counter reloaded with the divisor when it reaches 1: tick is high one cycle in every div (every cycle for div 0 or 1). A UART bit is 16 ticks, so the bit rate is clock / (16 · div).`,
      ports, symbol: { kind: 'box', label: 'BAUD ÷N' },
      netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
      hdl: { verilog: `always_ff @(posedge clk) cnt <= tick ? div : cnt - 1;\nassign tick = cnt <= 1;` },
    });
  });
}

// ---- the transmitter ---------------------------------------------------------------------------------------------------

/**
 * Takes a byte (`go` with din valid; taken = 1 in the cycle it is accepted, when not busy), loads {stop, data, start}
 * into the 10-bit shift register and shows one bit per 16 ticks on tx, the line changing only on a tick so that every
 * bit is exactly 16 ticks long. Stored inverted (zero = idle high), so tx comes out of an inverter.
 */
export const UART_TX: ComponentDef = (() => {
  const b = new Builder(22, 18, 6), g = kit(b);
  b.maxH = 60;
  b.pins('tick', 'go', 'din', 'clk');
  const one = g.konst(1, 1), zero = g.konst(1, 0);
  const busy = b.op(DFF, ['', 'clk'], 'busy', 'busy');
  const load = b.name(g.and('go', g.not(`${busy}.q`)), 'load', true);
  const step = b.name(g.and(`${busy}.q`, 'tick'), 'step', true);
  const tc = b.op(register(4), ['', '', 'clk'], 'ticks in this bit', 'tc');
  const bc = b.op(register(4), ['', '', 'clk'], 'bits sent', 'bc');
  const sh = b.op(shiftRegister(10), ['', one, zero, '', 'clk'], 'frame', 'sh');
  const ntx = b.op(DFFE, ['', step, 'clk'], 'line, inverted', 'ntx');
  b.next();
  const tcBits = g.split(`${tc}.q`, [1, 1, 1, 1]), bcBits = g.split(`${bc}.q`, [1, 1, 1, 1]);
  const last = b.name(g.and(step, ...tcBits), 'last tick of the bit', true);
  const end = g.and(last, bcBits[3], bcBits[0]);
  const zero4 = g.konst(4, 0);
  b.wire(g.mux(4, b.op1(incrementer(4), [`${tc}.q`]), zero4, load), `${tc}.d`);
  b.wire(g.or(load, step), `${tc}.en`);
  b.wire(g.mux(4, b.op1(incrementer(4), [`${bc}.q`]), zero4, load), `${bc}.d`);
  b.wire(g.or(load, last), `${bc}.en`);
  b.wire(g.or(load, g.and(`${busy}.q`, g.not(end))), `${busy}.d`);
  b.wire(g.merge([g.or(load, last), load]), `${sh}.mode`);
  b.wire(g.merge([zero, 'din', one], [1, 8, 1]), `${sh}.d`);
  b.wire(g.not(g.split(`${sh}.q`, [1, 9])[0]), `${ntx}.d`);
  b.next();
  b.wire(g.not(`${ntx}.q`), 'tx');
  b.wire(`${busy}.q`, 'busy');
  b.wire(load, 'taken');
  const ports: PortDef[] = [bit('tick', 'in'), bit('go', 'in'), bus('din', 8, 'in'), bit('clk', 'in', 'bottom', true), bit('tx', 'out'), bit('busy', 'out'), bit('taken', 'out')];
  return define({
    id: 'uart_tx', name: 'UART transmitter', category: 'sequential',
    summary: 'A byte in (go), a frame out: start (0), eight data bits LSB first, stop (1), each 16 ticks long, in a 10-bit shift register with a tick counter and a bit counter. The line moves only on a tick.',
    ports, symbol: { kind: 'box', label: 'UART TX' },
    netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
  });
})();

// ---- the receiver ------------------------------------------------------------------------------------------------------

/**
 * Oversampling receiver. rx goes through SYNC2 (as its inverse, so reset is idle). Idle: a tick with the line low
 * starts the count; 8 ticks later (the middle of the start bit) the line must still be low, else it was a glitch and
 * the receiver goes back to idle; then every 16 ticks it samples a data bit into the shift register, and a 17th sample
 * is the stop bit: 1 pushes the byte (`push`, one cycle), 0 is a framing error (`ferr`), after which it waits for the
 * line to go high again (a break is not a stream of zero bytes). It is back in idle in the middle of the stop bit, so
 * a start edge from a slightly fast sender is never missed.
 */
export const UART_RX: ComponentDef = (() => {
  const b = new Builder(22, 18, 6), g = kit(b);
  b.maxH = 60;
  b.pins('rx', 'tick', 'clk');
  const zero = g.konst(1, 0);
  const sy = b.op(SYNC2, [g.not('rx'), 'clk'], 'line low?', 'sy');
  const lo = b.name(`${sy}.q`, 'lo', true);
  const st = b.op(register(3), ['', '', 'clk'], 'state', 'st');
  const tc = b.op(register(4), ['', 'tick', 'clk'], 'ticks', 'tc');
  const bc = b.op(register(3), ['', '', 'clk'], 'bits', 'bc');
  const sr = b.op(shiftRegister(8), ['', '', zero, g.konst(8, 0), 'clk'], 'received byte', 'sr');
  b.next();
  const d = b.op(decoder(3, false), [`${st}.q`], 'state one-hot', 'dec');
  const tcb = g.split(`${tc}.q`, [1, 1, 1, 1]), bcb = g.split(`${bc}.q`, [1, 1, 1]);
  const nlo = g.not(lo);
  const tc7 = g.and(g.not(tcb[3]), tcb[2], tcb[1], tcb[0]), tc15 = g.and(...tcb), bc7 = g.and(...bcb);
  const detect = b.name(g.and('tick', `${d}.y0`, lo), 'start edge', true);
  const mid = b.name(g.and('tick', `${d}.y1`, tc7), 'mid start', true);
  const midOk = g.and(mid, lo);
  const samp = b.name(g.and('tick', `${d}.y2`, tc15), 'bit sample', true);
  const lastd = g.and(samp, bc7);
  const stp = b.name(g.and('tick', `${d}.y3`, tc15), 'stop sample', true);
  const good = b.name(g.and(stp, nlo), 'good frame', true), bad = b.name(g.and(stp, lo), 'framing error', true);
  const brkEnd = g.and('tick', `${d}.y4`, nlo);
  b.next();
  const changed = g.or(detect, mid, lastd, stp, brkEnd);
  b.wire(g.merge([g.or(detect, lastd), g.or(midOk, lastd), bad]), `${st}.d`);
  b.wire(changed, `${st}.en`);
  b.wire(g.mux(4, b.op1(incrementer(4), [`${tc}.q`]), g.konst(4, 0), g.or(detect, midOk)), `${tc}.d`);
  b.wire(g.mux(3, b.op1(incrementer(3), [`${bc}.q`]), g.konst(3, 0), midOk), `${bc}.d`);
  b.wire(g.or(midOk, samp), `${bc}.en`);
  b.wire(g.merge([samp, zero]), `${sr}.mode`);
  b.wire(nlo, `${sr}.sr`);
  b.wire(`${sr}.q`, 'data');
  b.wire(good, 'push');
  b.wire(bad, 'ferr');
  b.wire(`${st}.q`, 'state');
  b.wire(g.not(`${d}.y0`), 'busy');
  const ports: PortDef[] = [bit('rx', 'in'), bit('tick', 'in'), bit('clk', 'in', 'bottom', true), bus('data', 8, 'out'), bit('push', 'out'), bit('ferr', 'out'), bus('state', 3, 'out'), bit('busy', 'out')];
  return define({
    id: 'uart_rx', name: 'UART receiver', category: 'sequential',
    summary: 'rx through a 2-flop synchronizer; a low at a tick starts a count of ticks, the middle of the start bit confirms it (else a false start), then a sample every 16 ticks into an 8-bit shift register and a stop check: push on a 1, ferr on a 0.',
    ports, symbol: { kind: 'box', label: 'UART RX' },
    netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
  });
})();

// ---- the core ----------------------------------------------------------------------------------------------------------

/**
 * Baud generator, transmitter and receiver, a 16-byte FIFO each way, the divisor and interrupt-enable registers, the
 * status bits (framing error and overrun sticky until a write of 1 to them) and the interrupt. The bus slave
 * (AXI_UART) only decodes addresses into these strobes.
 */
export const UART_CORE: ComponentDef = (() => {
  const b = new Builder(24, 20, 6), g = kit(b);
  b.maxH = 70;
  b.pins('rx', 'push', 'data', 'pop', 'divWe', 'ieWe', 'clrWe', 'wval', 'clk');
  const divr = b.op(register(UART_DIV_BITS), ['wval', 'divWe', 'clk'], 'divisor', 'divr');
  const ier = b.op(register(2), [g.split('wval', [2, UART_DIV_BITS - 2])[0], 'ieWe', 'clk'], 'interrupt enables', 'ier');
  const baud = b.op(baudGen(), [`${divr}.q`, 'clk'], 'baud ÷N', 'baud');
  const fe = b.op(DFF, ['', 'clk'], 'framing error', 'fe'), ov = b.op(DFF, ['', 'clk'], 'overrun', 'ov');
  b.next();
  const txf = b.op(fifo(4, 8), ['push', 'xmit.taken', 'data', 'clk'], 'TX FIFO', 'txf');
  const rxf = b.op(fifo(4, 8), ['recv.push', 'pop', 'recv.data', 'clk'], 'RX FIFO', 'rxf');
  b.next();
  const xmit = b.op(UART_TX, [`${baud}.tick`, g.not(`${txf}.empty`), `${txf}.dout`, 'clk'], 'transmitter', 'xmit');
  const recv = b.op(UART_RX, ['rx', `${baud}.tick`, 'clk'], 'receiver', 'recv');
  b.name(`${baud}.tick`, 'tick', true);
  b.next();
  const rxne = b.name(g.not(`${rxf}.empty`), 'rx not empty', true);
  const clr = g.split('wval', [3, 1, 1, UART_DIV_BITS - 5]);
  b.wire(g.or(g.and(`${fe}.q`, g.not(g.and('clrWe', clr[1]))), `${recv}.ferr`), `${fe}.d`);
  b.wire(g.or(g.and(`${ov}.q`, g.not(g.and('clrWe', clr[2]))), g.and(`${recv}.push`, `${rxf}.full`)), `${ov}.d`);
  const txIdle = g.and(`${txf}.empty`, g.not(`${xmit}.busy`));
  const ie = g.split(`${ier}.q`, [1, 1]);
  b.wire(g.merge([rxne, `${txf}.full`, txIdle, `${fe}.q`, `${ov}.q`, g.konst(3, 0)], [1, 1, 1, 1, 1, 3]), 'status');
  b.wire(g.or(g.and(ie[0], rxne), g.and(ie[1], `${txf}.empty`)), 'irq');
  b.wire(b.op1(andBus(8), [`${rxf}.dout`, rxne]), 'rxData');
  b.wire(`${xmit}.tx`, 'tx');
  b.wire(`${divr}.q`, 'div');
  b.wire(`${ier}.q`, 'ie');
  b.wire(`${baud}.tick`, 'tickOut');
  const ports: PortDef[] = [
    bit('rx', 'in'), bit('push', 'in'), bus('data', 8, 'in'), bit('pop', 'in'), bit('divWe', 'in'), bit('ieWe', 'in'), bit('clrWe', 'in'), bus('wval', UART_DIV_BITS, 'in'), bit('clk', 'in', 'bottom', true),
    bit('tx', 'out'), bus('rxData', 8, 'out'), bus('status', 8, 'out'), bus('div', UART_DIV_BITS, 'out'), bus('ie', 2, 'out'), bit('irq', 'out'), bit('tickOut', 'out'),
  ];
  return define({
    id: 'uart_full', name: 'UART core (FIFOs, status, divisor)', category: 'sequential',
    summary: 'Baud generator, transmitter, receiver, a 16-byte FIFO each way, the divisor and interrupt-enable registers, status bits (rx not empty, tx full, tx idle, framing error, overrun) and the interrupt. push writes a byte to the transmit FIFO, pop takes the oldest received byte; wval with divWe / ieWe / clrWe writes the registers.',
    ports, symbol: { kind: 'box', label: 'UART' },
    netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
  });
})();

// ---- the bus slave -----------------------------------------------------------------------------------------------------

/**
 * The core as a slave on chapter 38's bus (AXI-lite-shaped): +0 DATA (write: queue a byte to send; read: the oldest received
 * byte, taken from the FIFO the cycle after the read's handshake), +4 STATUS (bit 0 rx not empty, 1 tx full, 2 tx idle, 3 framing
 * error, 4 overrun; a write of 1 to bit 3 or 4 clears it), +8 DIVISOR, +12 interrupt enables (bit 0 rx not empty, bit 1 tx FIFO
 * empty). irq is the OR of the enabled conditions.
 */
export const AXI_UART: ComponentDef = (() => {
  const b = new Builder(24, 16, 6), g = kit(b);
  b.maxH = 60;
  const { wrHs, rdHs } = slaveFsm(b, g, 0);
  b.next();
  const wsel = b.op(decoder(2, false), [g.split('awaddr', [2, 2, 28])[1]], 'which register (write)', 'wdec');
  const rsplit = g.split('araddr', [2, 2, 28])[1];
  const rsel = b.op(decoder(2, false), [rsplit], 'which register (read)', 'rdec');
  b.next();
  const core = b.op(UART_CORE, [], 'UART core', 'core');
  const w = (i: number) => g.and(wrHs, `${wsel}.y${i}`);
  b.wire('rx', `${core}.rx`);
  b.wire(w(0), `${core}.push`); b.wire(g.split('wdata', [8, 24])[0], `${core}.data`);
  b.wire(w(1), `${core}.clrWe`); b.wire(w(2), `${core}.divWe`); b.wire(w(3), `${core}.ieWe`);
  b.wire(g.split('wdata', [UART_DIV_BITS, 32 - UART_DIV_BITS])[0], `${core}.wval`);
  b.wire('clk', `${core}.clk`);
  b.next();
  const status = g.split(`${core}.status`, [1, 7]);
  const zext = (x: string, wd: number) => g.merge([x, g.konst(32 - wd, 0)], [wd, 32 - wd]);
  const word = b.op1(muxTree(2, 32), [zext(`${core}.rxData`, 8), zext(`${core}.status`, 8), zext(`${core}.div`, UART_DIV_BITS), zext(`${core}.ie`, 2), rsplit], 'register');
  const rdr = b.op(register(32), [word, rdHs, 'clk'], 'read data', 'rdr');
  b.wire(`${rdr}.q`, 'rdata');
  const popq = b.op(DFF, [b.name(g.and(rdHs, `${rsel}.y0`, status[0]), 'take the byte', true), 'clk'], 'pop next cycle', 'popq');
  b.wire(`${popq}.q`, `${core}.pop`);
  b.wire(`${core}.tx`, 'tx');
  b.wire(`${core}.irq`, 'irq');
  const ports: PortDef[] = [...slavePorts(), bit('rx', 'in'), bit('clk', 'in', 'bottom', true), bit('tx', 'out'), bit('irq', 'out')];
  return define({
    id: 'axi_uart', name: 'UART slave', category: 'memory',
    summary: 'The UART core behind the bus: +0 data (store: send; load: the oldest received byte, taken the cycle after), +4 status (rx not empty, tx full, tx idle, framing error, overrun; write 1 to clear the last two), +8 divisor (bit rate = clock / (16 · divisor)), +12 interrupt enables.',
    ports, symbol: { kind: 'box', label: 'UART' },
    netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
  });
})();

// ---- the line ----------------------------------------------------------------------------------------------------------

/** The line part's state: the levels sampled at the last `delay` sender edges, the clock and the inputs as they were. */
export interface LineState { buf: number[]; clk: number; d: number; noise: number; delay: number }
export const isLine = (s: unknown): s is LineState => !!s && typeof s === 'object' && Array.isArray((s as LineState).buf) && 'noise' in s;

/**
 * The wire between two computers as one box: q is what d was `delay - 1` sender clock edges ago (the delay in the
 * sender's clock, so propagation is part of the model), and noise = 1 at an edge flips the sampled level (a glitch). It
 * holds a level the way a pulled-up line does and starts idle (1). The one part of the book that does not end in
 * transistors: a transmission line is chapter 41's model (phys/line.ts), not a circuit.
 */
export function lineDef(delay = 2): ComponentDef {
  return memo(`line${delay}`, () => ({
    id: `line${delay}`, name: `Line (${delay} cycles)`, category: 'memory',
    summary: `A wire between two machines as one box: the level the sender drove, ${delay} sender clock cycles later, with an input that flips it for a cycle (noise). Pulled up: idle is 1. It stands for the cable and costs nothing; chapter 41 models what is inside.`,
    ports: [bit('d', 'in'), bit('noise', 'in'), bit('clk', 'in', 'bottom', true), bit('q', 'out')],
    symbol: { kind: 'box', label: 'LINE' }, modelPanel: 'cable',
    behavior: {
      delay: 1,
      seq: { clk: 'clk', comb: [] },
      init: (): LineState => ({ buf: Array(delay).fill(1), clk: 0, d: 1, noise: 0, delay }),
      eval: ([d, noise, clk], st) => {
        const s = st as LineState;
        const k = clk < 0 ? 2 : clk;
        if (k !== 1) { s.d = d === 0 ? 0 : 1; s.noise = noise === 1 ? 1 : 0; }
        if (s.clk === 0 && k === 1) s.buf = [...s.buf.slice(1), s.d ^ s.noise];
        s.clk = k;
        return [s.buf[0]];
      },
      carry: (prev) => prev,
    },
  }));
}
export const LINE = lineDef(2);

// ---- benches for the chapter's scenes ----------------------------------------------------------------------------------

/** A transmitter with its baud generator: div, go, din, clk in; tx, busy, tick out. */
export const UART_TX_BENCH: ComponentDef = (() => {
  const b = new Builder(24, 20, 6);
  b.pins('div', 'go', 'din', 'clk');
  const baud = b.op(baudGen(), ['div', 'clk'], 'baud ÷N', 'baud');
  b.next();
  const tx = b.op(UART_TX, [`${baud}.tick`, 'go', 'din', 'clk'], 'transmitter', 'xmit');
  b.next();
  b.wire(`${tx}.tx`, 'tx'); b.wire(`${tx}.busy`, 'busy'); b.wire(`${baud}.tick`, 'tick'); b.wire(`${tx}.taken`, 'taken');
  const ports: PortDef[] = [bus('div', UART_DIV_BITS, 'in'), bit('go', 'in'), bus('din', 8, 'in'), bit('clk', 'in', 'bottom', true), bit('tx', 'out'), bit('busy', 'out'), bit('tick', 'out'), bit('taken', 'out')];
  return define({
    id: 'uart_tx_bench', name: 'UART transmitter on a bench', category: 'sequential',
    summary: 'The baud generator and the transmitter: set div, put a byte on din and raise go; tx carries the frame.',
    ports, symbol: { kind: 'box', label: 'TX BENCH' },
    netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
  });
})();

/** A receiver with its baud generator: div, rx, clk in; data, push, ferr, state, tick out. */
export const UART_RX_BENCH: ComponentDef = (() => {
  const b = new Builder(24, 20, 6);
  b.pins('div', 'rx', 'clk');
  const baud = b.op(baudGen(), ['div', 'clk'], 'baud ÷N', 'baud');
  b.next();
  const rx = b.op(UART_RX, ['rx', `${baud}.tick`, 'clk'], 'receiver', 'recv');
  b.next();
  b.wire(`${rx}.data`, 'data'); b.wire(`${rx}.push`, 'push'); b.wire(`${rx}.ferr`, 'ferr'); b.wire(`${rx}.state`, 'state'); b.wire(`${baud}.tick`, 'tick');
  const ports: PortDef[] = [bus('div', UART_DIV_BITS, 'in'), bit('rx', 'in'), bit('clk', 'in', 'bottom', true), bus('data', 8, 'out'), bit('push', 'out'), bit('ferr', 'out'), bus('state', 3, 'out'), bit('tick', 'out')];
  return define({
    id: 'uart_rx_bench', name: 'UART receiver on a bench', category: 'sequential',
    summary: 'The baud generator and the receiver: drive rx with a frame from a clock of your choice; data holds the byte, push pulses when a frame with a good stop bit arrives.',
    ports, symbol: { kind: 'box', label: 'RX BENCH' },
    netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
  });
})();
