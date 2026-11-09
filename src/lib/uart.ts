// Chapter uart's UART in gates: a baud generator (a 16× tick), a transmitter and a receiver around the book's universal
// shift register, two 16-byte FIFOs (lib/storage.ts fifo), a status register, and the core as a slave on chapter bus's
// bus. comm/uart.ts is the same machine edge by edge (tests/comm-uart.test.ts compares every output every cycle).
//
// Reset is all zeros, so the polarities are chosen to make zero mean idle: the transmitter stores the inverse of its line
// (`ntx`), the receiver synchronizes the inverse of its input, and the baud counter's reset value (0) is a tick every cycle
// until the divisor is written.

import { UART_DIV_BITS } from '../comm/uart';
import type { ComponentDef, NetDef, PortDef } from '../sim/types';
import { isZero } from './alu';
import { andBus, bundled, kit, slaveFsm, slavePorts } from './axi';
import { Builder } from './builder';
import { decoder, incrementer, muxTree } from './combinational';
import { define } from './define';
import { DFF, DFFE, register } from './sequential';
import { shiftRegister } from './seqparts';
import { fifo } from './storage';
import { SYNC2 } from './sync';
import { bitwise } from './wide';

import { numOf } from '../chapters/order';
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

/**
 * Hand placement of a Builder-made level: instances by name at `at`, the nets drawn as wires except those whose driver end is in `ptr`
 * (long control lines, constants, the clock), `via` corners per net (keyed by the driver end, then the sink end). Connectivity is the
 * Builder's, untouched.
 */
function laid(b: Builder, at: Record<string, [number, number]>, ptr: Record<string, true | string[]> | string[], via: Record<string, NetDef['via']> = {}, trunks: Record<string, number> = {}): NetDef[] {
  for (const i of b.instances) { const p = at[i.name]; if (!p) throw new Error(`no place for ${i.name}`); i.at = p; }
  const tg = Array.isArray(ptr) ? Object.fromEntries(ptr.map((k) => [k, true as const])) : ptr;
  return b.nets().map((n): NetDef => {
    const { tags: _t, ...rest } = n;
    const t = tg[n.ends[0]];
    return { ...rest, ...(t ? { tags: t } : {}), ...(via[n.ends[0]] ? { via: via[n.ends[0]] } : {}), ...(trunks[n.ends[0]] !== undefined ? { trunk: trunks[n.ends[0]] } : {}) };
  });
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
  // Drawn by hand: control at the left (load, step), the tick counter and its last-tick detector on top, the bit counter and the end
  // chain to busy below, the frame (shift register, line flip-flop) at the bottom. Each counter is a loop (register, +1, clear
  // multiplexer) whose new value comes back over the top; load, step, the last tick, busy, the constants and the clock are labels.
  const nets = laid(b, {
    u2: [8, 6], u3: [14, 4], u4: [14, 14], u0: [22, 61], u1: [22, 57],
    u12: [20, 8], tc: [28, 6], u10: [44, 6], u11: [58, 6], u9: [80, 22], u5: [38, 16], u7: [46, 16],
    u15: [20, 34], bc: [28, 32], u13: [44, 32], u14: [58, 32], u6: [38, 38], u8: [54, 40], u16: [62, 42], u17: [70, 40], u18: [80, 39], busy: [90, 39],
    u19: [12, 51], u20: [28, 52], u21: [28, 57], sh: [34, 52], u22: [50, 55], u23: [55, 55], ntx: [62, 54], u24: [74, 56],
  }, ['clk', 'busy.q', 'u3.y', 'u4.y', 'u7.y', 'u9.y'], {
    'u0.y': { 'sh.sr': [[26, 62], [26, 66], [32, 66], [32, 56]] },
    'u1.y': { 'sh.sl': [[26, 58], [26, 56.5], [31, 56.5], [31, 58]] },
    'u11.y': { 'tc.d': [[64, 9], [64, 3], [26, 3], [26, 8]] },
    'u14.y': { 'bc.d': [[64, 35], [64, 29], [26, 29], [26, 34]] },
  });
  const pins: Record<string, [number, number]> = { tick: [0, 17], go: [0, 5], din: [0, 60], clk: [0, 70], tx: [100, 57], busy: [110, 44], taken: [110, 50] };
  return define({
    id: 'uart_tx', name: 'UART transmitter', category: 'sequential',
    summary: 'A byte in (go), a frame out: start (0), eight data bits LSB first, stop (1), each 16 ticks long, in a 10-bit shift register with a tick counter and a bit counter. The line moves only on a tick.',
    ports, symbol: { kind: 'box', label: 'UART TX' },
    netlist: () => ({ pins, instances: b.instances, nets }),
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
  const tc7 = b.name(g.and(g.not(tcb[3]), tcb[2], tcb[1], tcb[0]), 'tick count 7', true), tc15 = b.name(g.and(...tcb), 'tick count 15', true), bc7 = b.name(g.and(...bcb), 'bit count 7', true);
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
  // Drawn by hand: the synchronizer and the state register (with its decoder) on top, the event gates (one per state) in columns to the
  // right of the decoder, the two counters below with their compare detectors between them and the gates, the shift register at the
  // bottom right. The events (start edge, mid start, bit sample, stop sample, framing error) and lo / nlo are labels; the counters'
  // loops come back over their tops.
  const at = (o: Record<string, [number, number]>) => Object.fromEntries(Object.entries(o).map(([k, [x, y]]) => [k, [x + 8, y + 2] as [number, number]]));
  const v = (...p: [number, number][]) => p.map(([x, y]): [number, number] => [x + 8, y + 2]);
  const nets = laid(b, at({
    u1: [4, 3], sy: [12, 2], u5: [24, 3],
    u20: [6, 8], u21: [6, 13], u22: [20, 7], st: [30, 8], dec: [46, 2],
    u10: [66, 3], u11: [66, 11], u13: [66, 19], u15: [66, 27], u18: [66, 35],
    u12: [84, 11], u14: [84, 19], u16: [84, 27], u17: [84, 33], u19: [102, 8], u32: [110, 20],
    u24: [4, 25], u26: [12, 22], tc: [30, 23], u23: [44, 23], u25: [12, 32], u3: [41, 30], u6: [47, 36], u7: [52, 30], u8: [52, 40],
    u28: [4, 59], u29: [12, 56], u30: [12, 65], bc: [30, 57], u27: [44, 57], u4: [41, 64], u9: [52, 62],
    u31: [84, 52], u0: [76, 58], u2: [80, 63], sr: [92, 52],
  }), {
    clk: true, tick: true, 'sy.q': ['u10.i2', 'u12.b', 'u17.b'], 'u5.y': true, 'dec.y0': ['u32.a'], 'st.q': ['state'],
    'u10.y': true, 'u11.y': ['u19.i1'], 'u12.y': true, 'u13.y': ['u30.b', 'u31.i0'], 'u14.y': true, 'u15.y': ['u19.i3'], 'u17.y': true, 'u18.y': true, 'u19.y': true,
    'u0.y': true, 'u7.y': true, 'u8.y': true, 'u9.y': true,
  }, {
    'u23.y': { 'u26.a': v([54, 25], [54, 20], [11, 20], [11, 24]) },
    'u27.y': { 'u29.a': v([54, 59], [54, 54], [11, 54], [11, 58]) },
  }, { 'dec.y1': 71, 'dec.y2': 70, 'dec.y3': 69, 'dec.y4': 68 });
  const pins: Record<string, [number, number]> = { rx: [0, 5], tick: [0, 70], clk: [0, 74], data: [124, 61], push: [124, 33], ferr: [124, 38], state: [124, 6], busy: [124, 24] };
  return define({
    id: 'uart_rx', name: 'UART receiver', category: 'sequential',
    summary: 'rx through a 2-flop synchronizer; a low at a tick starts a count of ticks, the middle of the start bit confirms it (else a false start), then a sample every 16 ticks into an 8-bit shift register and a stop check: push on a 1, ferr on a 0.',
    ports, symbol: { kind: 'box', label: 'UART RX' },
    netlist: () => ({ pins, instances: b.instances, nets }),
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
  // Drawn by hand: the transmit path on top (FIFO, transmitter), the receive path below (receiver, FIFO), the divisor, baud
  // generator and interrupt enables underneath, the flag logic (framing error, overrun) and the status word at the right. What
  // reaches many places (clk, tick, the strobes, rx not empty, the empty flag) or runs back (taken, push, pop) is a label.
  const nets = laid(b, {
    divr: [10, 38], u0: [4, 49], ier: [10, 48], baud: [28, 38], u15: [24, 50], u18: [36, 49], u19: [36, 55], u20: [46, 52],
    txf: [50, 2], u1: [66, 5], xmit: [72, 2], u13: [90, 7], u14: [96, 5],
    recv: [50, 22], rxf: [72, 22], u2: [88, 25], u21: [114, 23],
    u3: [96, 44], u4: [104, 44], u5: [112, 45], u6: [118, 43], u7: [130, 44], fe: [142, 43],
    u8: [104, 56], u9: [112, 57], u10: [118, 55], u11: [118, 62], u12: [130, 58], ov: [142, 57],
    u16: [150, 68], u17: [168, 40],
  }, {
    wval: true, divWe: true, clk: true, ieWe: true, 'xmit.taken': true, 'recv.push': ['u11.a'], pop: true, 'txf.empty': ['u14.a', 'u19.b'], 'baud.tick': true, clrWe: true,
    'divr.q': ['div'], 'ier.q': ['ie'], 'u2.y': true, 'fe.q': true, 'ov.q': true, 'u14.y': true, 'recv.ferr': true,
  });
  const pins: Record<string, [number, number]> = { rx: [0, 27], push: [0, 4], data: [0, 8], pop: [0, 24], divWe: [0, 34], ieWe: [0, 56], clrWe: [0, 62], wval: [0, 40], clk: [0, 70], tx: [184, 4], rxData: [184, 25], status: [184, 46], div: [184, 38], ie: [184, 52], irq: [184, 55], tickOut: [184, 60] };
  return define({
    id: 'uart_full', name: 'UART core (FIFOs, status, divisor)', category: 'sequential',
    summary: 'Baud generator, transmitter, receiver, a 16-byte FIFO each way, the divisor and interrupt-enable registers, status bits (rx not empty, tx full, tx idle, framing error, overrun) and the interrupt. push writes a byte to the transmit FIFO, pop takes the oldest received byte; wval with divWe / ieWe / clrWe writes the registers.',
    ports, symbol: { kind: 'box', label: 'UART' },
    netlist: () => ({ pins, instances: b.instances, nets }),
  });
})();

// ---- the bus slave -----------------------------------------------------------------------------------------------------

/**
 * The core as a slave on chapter bus's bus (AXI-lite-shaped): +0 DATA (write: queue a byte to send; read: the oldest received
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

/** The slave with its bus ports packed into a request and a response bus: the sandbox's UART slave on a bus (id axi_uart_b). */
export const AXI_UART_B: ComponentDef = bundled(AXI_UART, [['', 'slave']], 'axi_uart_b');

// ---- the line ----------------------------------------------------------------------------------------------------------

/** The line part's state: the levels sampled at the last `delay` sender edges, the clock and the inputs as they were. */
export interface LineState { buf: number[]; clk: number; d: number; noise: number; delay: number }
/** The longest line the sandbox part offers (cycles of the sender's clock). */
export const MAX_LINE_DELAY = 64;
const lineDefs = new WeakSet<ComponentDef>();
/** Is this def a line part (the one box that does not end in transistors)? Any delay. */
export const isLineDef = (d: ComponentDef | undefined): boolean => !!d && lineDefs.has(d);
export const isLine = (s: unknown): s is LineState => !!s && typeof s === 'object' && Array.isArray((s as LineState).buf) && 'noise' in s;

/**
 * The wire between two computers as one box: q is what d was `delay - 1` sender clock edges ago (the delay in the
 * sender's clock, so propagation is part of the model), and noise = 1 at an edge flips the sampled level (a glitch). It
 * holds a level the way a pulled-up line does and starts idle (1). The one part of the book that does not end in
 * transistors: a transmission line is chapter wire's model (phys/line.ts), not a circuit.
 */
export function lineDef(delay = 2): ComponentDef {
  return memo(`line${delay}`, () => { const d: ComponentDef = {
    id: `line${delay}`, name: `Line (${delay} cycles)`, category: 'memory',
    summary: `A wire between two machines as one box: the level the sender drove, ${delay} sender clock cycles later, with an input that flips it for a cycle (noise). Pulled up: idle is 1. It stands for the cable and costs nothing; chapter ${numOf('wire')} models what is inside.`,
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
  }; lineDefs.add(d); return d; });
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
