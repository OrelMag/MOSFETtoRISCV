// Chapter 35's bus, in gates: AXI-lite-shaped channels with valid / ready, one transaction at a time.
// A write is an address (AW) and its data (W), here always handshaken together, then a response (B); a
// read is an address (AR), then data (R). A transfer happens on the rising edge where valid and ready
// are both 1. The interconnect grants the bus to one master (round robin, arbiterN), decodes the address
// to a slave, and holds both until the response completes. Slaves answer the cycle after the address at
// the earliest, so a transfer takes at least two cycles; a slow slave adds wait states.

import { MAP } from '../bus/model';
import type { DramConfig } from '../dram/controller';
import { FlashDevice, FLASH_TIMES, type FlashGeometry } from '../flash/model';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord, isZero } from './alu';
import { bigRam } from './bigmem';
import { Builder } from './builder';
import { andN, busMux2, decoder, equal, incrementer, muxTree } from './combinational';
import { define, merger, ones, splitter } from './define';
import { cfgKey, dramCtrl, dramDevice } from './dramctrl';
import { AND, MUX2, NOT, OR } from './gates';
import { arbiterN } from './mpdecode';
import { DFF, register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { bitwise, orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

/** A master's channel signals (driven by the master), and what comes back. */
export const M_OUT = ['awvalid', 'awaddr', 'wvalid', 'wdata', 'wstrb', 'bready', 'arvalid', 'araddr', 'rready'] as const;
export const M_IN = ['awready', 'wready', 'bvalid', 'arready', 'rvalid', 'rdata'] as const;
const WIDTH: Record<string, number> = { awaddr: 32, wdata: 32, wstrb: 4, araddr: 32, rdata: 32 };
const wOf = (s: string) => WIDTH[s] ?? 1;
/** A master's side of the bus (what it drives is 'out'). */
export const masterPorts = (prefix = ''): PortDef[] => [...M_OUT.map((s) => ({ name: prefix + s, width: wOf(s), dir: 'out' as const })), ...M_IN.map((s) => ({ name: prefix + s, width: wOf(s), dir: 'in' as const }))];
/** A slave's side (the same signals, the other way round). */
export const slavePorts = (prefix = ''): PortDef[] => [...M_OUT.map((s) => ({ name: prefix + s, width: wOf(s), dir: 'in' as const })), ...M_IN.map((s) => ({ name: prefix + s, width: wOf(s), dir: 'out' as const }))];

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** A bus ANDed with one bit (en fans out inside the box, not across the drawing that uses it). */
export function andBus(w: number): ComponentDef {
  return memo(`andbus${w}`, () => {
    const P = 4;
    const instances = [
      { name: 'sa', def: splitter(ones(w), P), at: [4, 0] as [number, number] },
      ...Array.from({ length: w }, (_, i) => ({ name: `g${i}`, def: AND, at: [9, P * i] as [number, number] })),
      { name: 'my', def: merger(ones(w), P), at: [17, 1] as [number, number] },
    ];
    const nets = [
      { name: 'a', ends: ['a', 'sa.in'] },
      { name: 'en', ends: ['en', ...Array.from({ length: w }, (_, i) => `g${i}.b`)], trunk: 7 },
      ...Array.from({ length: w }, (_, i) => ({ ends: [`sa.o${i}`, `g${i}.a`] })),
      ...Array.from({ length: w }, (_, i) => ({ ends: [`g${i}.y`, `my.i${i}`] })),
      { name: 'y', ends: ['my.out', 'y'] },
    ];
    return define({
      id: `andbus${w}`, name: `${w}-bit AND with one bit`, category: 'gate',
      summary: `Each bit of a ANDed with en: the bus when en = 1, all zeros when en = 0 (${w} ANDs).`,
      ports: [bus('a', w, 'in'), bit('en', 'in'), bus('y', w, 'out')],
      symbol: { kind: 'box', label: 'AND', w: 6, h: 4 },
      spec: ([a, en]) => [en ? a : 0],
      netlist: () => ({ pins: { a: [0, P * w / 2], en: [0, P * w / 2 + 3], y: [22, P * w / 2] }, instances, nets }),
    });
  });
}

/** Small helpers over a Builder: gates of any arity, buses of any width (1 included). */
function kit(b: Builder) {
  const and = (...xs: string[]) => (xs.length === 1 ? xs[0] : xs.length === 2 ? b.op1(AND, xs) : b.op1(andN(xs.length), xs));
  const or = (...xs: string[]) => (xs.length === 1 ? xs[0] : xs.length === 2 ? b.op1(OR, xs) : b.op1(orN(xs.length), xs));
  const not = (x: string) => b.op1(NOT, [x]);
  const mux = (wd: number, a: string, c: string, s: string, label?: string) => b.op1(wd === 1 ? MUX2 : busMux2(wd), [a, c, s], label);
  const merge = (xs: string[], ws?: number[]) => (xs.length === 1 ? xs[0] : b.op1(merger(ws ?? ones(xs.length)), xs));
  const split = (x: string, ws: number[]) => { const s = b.op(splitter(ws), [x]); return ws.map((_, i) => `${s}.o${i}`); };
  const rep = (x: string, n: number) => merge(Array.from({ length: n }, () => x));
  /** A bus ANDed with a bit. */
  const gate = (x: string, wd: number, en: string) => (wd === 1 ? b.op1(AND, [x, en]) : b.op1(andBus(wd), [x, en]));
  /** OR of buses of one width. */
  const orBus = (xs: string[], wd: number) => xs.reduce((acc, x) => b.op1(wd === 1 ? OR : bitwise('or', wd), [acc, x]));
  const konst = (wd: number, v: number) => b.op1(wd === 1 ? (v ? TIE1 : TIE0) : constWord(wd, v), []);
  return { and, or, not, mux, merge, split, rep, gate, orBus, konst };
}

/** Pins down the left (inputs) and right (outputs), two units apart. */
function sidePins(ports: PortDef[], right: number): Record<string, [number, number]> {
  const pins: Record<string, [number, number]> = {};
  let yl = 2, yr = 2;
  for (const p of ports) if (p.dir === 'in') { pins[p.name] = [0, yl]; yl += 3; } else { pins[p.name] = [right, yr]; yr += 3; }
  return pins;
}

/**
 * The CPU's side of the bus (one master port): req (a load or store wanted), we, addr, wdata, be (byte
 * enables). It raises AW + W or AR until the slave takes the address, then waits for the response; done
 * is 1 in the cycle the response arrives (the CPU finishes the instruction at that edge).
 */
export const AXI_PORT: ComponentDef = (() => {
  const b = new Builder(14, 14);
  const g = kit(b);
  b.pins('req', 'we', 'addr', 'data', 'be', 'clk', 'awready', 'wready', 'bvalid', 'arready', 'rvalid', 'rdata');
  const sent = b.op(DFF, ['', 'clk'], 'address taken', 'sent');
  const want = b.name(g.and('req', g.not(`${sent}.q`)), 'issue', true);
  const wr = b.name(g.and(want, 'we'), 'write', true);
  const rd = b.name(g.and(want, g.not('we')), 'read', true);
  b.next();
  const taken = g.or(g.and(wr, 'awready', 'wready'), g.and(rd, 'arready'));
  const done = b.name(g.and(`${sent}.q`, g.mux(1, 'rvalid', 'bvalid', 'we')), 'done', true);
  b.wire(g.and('req', g.not(done), g.or(`${sent}.q`, taken)), `${sent}.d`);
  b.next();
  b.wire(wr, 'awvalid'); b.wire('addr', 'awaddr'); b.wire(wr, 'wvalid'); b.wire('data', 'wdata'); b.wire('be', 'wstrb');
  b.wire(rd, 'arvalid'); b.wire('addr', 'araddr');
  const one = g.konst(1, 1);
  b.wire(one, 'bready'); b.wire(one, 'rready');
  b.wire(done, 'done'); b.wire('rdata', 'rdataOut');
  const ports: PortDef[] = [bit('req', 'in'), bit('we', 'in'), bus('addr', 32, 'in'), bus('data', 32, 'in'), bus('be', 4, 'in'), bit('clk', 'in', 'bottom', true),
    ...M_IN.map((s) => ({ name: s, width: wOf(s), dir: 'in' as const })), bit('done', 'out'), bus('rdataOut', 32, 'out'), ...M_OUT.map((s) => ({ name: s, width: wOf(s), dir: 'out' as const }))];
  return define({
    id: 'axiport', name: 'Bus master port', category: 'memory',
    summary: 'Turns a load or a store into a bus transaction: AW and W (a store) or AR (a load) held valid until the slave takes them, then the response; done in the cycle it arrives. Two cycles at the least.',
    ports, symbol: { kind: 'box', label: 'BUS PORT' },
    netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * Who holds the bus: a one-hot grant register (all 0: free) and the round-robin arbiter. While free the
 * arbiter's choice is the grant at once (no cycle lost); it is held from the next edge until the
 * response handshake (respDone).
 */
function axiGrant(M: number): ComponentDef {
  return memo(`axigrant${M}`, () => {
    const b = new Builder(14, 14);
    const g = kit(b);
    const held = b.op(register(M), ['', g.konst(1, 1), 'clk'], 'held grant', 'held');
    const heldBits = g.split(`${held}.q`, ones(M));
    const active = b.name(g.or(...heldBits), 'busy', true);
    const arb = b.op(arbiterN(M), [...Array.from({ length: M }, (_, m) => `req${m}`), 'clk'], 'arbiter', 'arb');
    b.next();
    const cur = Array.from({ length: M }, (_, m) => g.mux(1, `${arb}.g${m}`, heldBits[m], active));
    const keep = g.and(active, g.not('respDone')), take = g.and(g.not(active), g.or(...Array.from({ length: M }, (_, m) => `req${m}`)));
    b.wire(g.merge(Array.from({ length: M }, (_, m) => g.or(g.and(keep, heldBits[m]), g.and(take, `${arb}.g${m}`)))), `${held}.d`);
    cur.forEach((c, m) => b.wire(c, `grant${m}`));
    b.wire(active, 'busy');
    const ports: PortDef[] = [...Array.from({ length: M }, (_, m) => bit(`req${m}`, 'in')), bit('respDone', 'in'), bit('clk', 'in', 'bottom', true), ...Array.from({ length: M }, (_, m) => bit(`grant${m}`, 'out')), bit('busy', 'out')];
    return define({
      id: `axigrant${M}`, name: `Bus grant (${M} masters)`, category: 'memory',
      summary: 'Round-robin arbitration (arbiterN): while the bus is free the winner is granted at once; the grant is then held until the response handshake.',
      ports, symbol: { kind: 'box', label: 'GRANT' },
      netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The granted master's signals: an AND-OR over the one-hot grant, per channel signal. */
function axiMasterMux(M: number): ComponentDef {
  return memo(`aximmux${M}`, () => {
    const b = new Builder(14, 14);
    const g = kit(b);
    for (const s of M_OUT) b.wire(g.orBus(Array.from({ length: M }, (_, m) => g.gate(`m${m}_${s}`, wOf(s), `grant${m}`)), wOf(s)), s);
    const ports: PortDef[] = [...Array.from({ length: M }, (_, m) => M_OUT.map((s) => ({ name: `m${m}_${s}`, width: wOf(s), dir: 'in' as const }))).flat(), ...Array.from({ length: M }, (_, m) => bit(`grant${m}`, 'in')),
      ...M_OUT.map((s) => ({ name: s, width: wOf(s), dir: 'out' as const }))];
    return define({
      id: `aximmux${M}`, name: `Bus master multiplexer (${M})`, category: 'memory',
      summary: 'The granted master\'s address, data, valids and readies, chosen by the one-hot grant (an AND-OR per signal).',
      ports, symbol: { kind: 'box', label: 'MASTER MUX' },
      netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The address decoder: the top nibble of the address presented (AW when writing, else AR); held with the grant. */
function axiDecoder(codes: number[]): ComponentDef {
  const S = codes.length;
  return memo(`axidec${codes.join('_')}`, () => {
    const b = new Builder(14, 14);
    const g = kit(b);
    const addr = g.mux(32, 'araddr', 'awaddr', 'awvalid', 'address');
    const nib = g.split(addr, [28, 4])[1];
    b.next();
    const match = codes.slice(0, S - 1).map((c) => b.op1(equal(4), [nib, g.konst(4, c)], `= ${c.toString(16)}`));
    const dec = [...match, g.not(g.or(...match))];
    b.next();
    const selHeld = b.op(register(S), [g.merge(dec), g.not('busy'), 'clk'], 'addressed slave', 'selh');
    const sh = g.split(`${selHeld}.q`, ones(S));
    dec.forEach((d, k) => b.wire(g.mux(1, d, sh[k], 'busy'), `sel${k}`));
    const ports: PortDef[] = [bus('awaddr', 32, 'in'), bus('araddr', 32, 'in'), bit('awvalid', 'in'), bit('busy', 'in'), bit('clk', 'in', 'bottom', true), ...Array.from({ length: S }, (_, k) => bit(`sel${k}`, 'out'))];
    return define({
      id: `axidec${codes.join('_')}`, name: `Bus address decoder (${S} slaves)`, category: 'memory',
      summary: `Slave k answers addresses whose top four bits are ${codes.slice(0, S - 1).map((c) => c.toString(16)).join(', ')}; any other goes to the last (default) slave. The choice is held while the bus is busy.`,
      ports, symbol: { kind: 'box', label: 'DECODE' },
      netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The addressed slave's answer back to the granted master, and the response handshake that frees the bus. */
function axiAnswer(M: number, S: number): ComponentDef {
  return memo(`axians${M}_${S}`, () => {
    const b = new Builder(14, 14);
    const g = kit(b);
    const ans: Record<string, string> = {};
    for (const s of M_IN) ans[s] = g.orBus(Array.from({ length: S }, (_, k) => g.gate(`s${k}_${s}`, wOf(s), `sel${k}`)), wOf(s));
    b.next();
    for (let m = 0; m < M; m++) for (const s of M_IN) b.wire(s === 'rdata' ? ans.rdata : g.and(ans[s], `grant${m}`), `m${m}_${s}`);
    b.wire(g.or(g.and(ans.bvalid, 'bready'), g.and(ans.rvalid, 'rready')), 'respDone');
    const ports: PortDef[] = [...Array.from({ length: S }, (_, k) => M_IN.map((s) => ({ name: `s${k}_${s}`, width: wOf(s), dir: 'in' as const }))).flat(),
      ...Array.from({ length: S }, (_, k) => bit(`sel${k}`, 'in')), ...Array.from({ length: M }, (_, m) => bit(`grant${m}`, 'in')), bit('bready', 'in'), bit('rready', 'in'),
      ...Array.from({ length: M }, (_, m) => M_IN.map((s) => ({ name: `m${m}_${s}`, width: wOf(s), dir: 'out' as const }))).flat(), bit('respDone', 'out')];
    return define({
      id: `axians${M}_${S}`, name: `Bus answer routing (${M} masters, ${S} slaves)`, category: 'memory',
      summary: 'The addressed slave\'s readies, valids and read data, to the granted master only; respDone when B or R is taken (the bus is then free).',
      ports, symbol: { kind: 'box', label: 'ANSWER' },
      netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * The interconnect for M masters and S slaves: slave s answers addresses whose top nibble is codes[s];
 * any other address goes to the last slave (a default slave). Requests are arbitrated round robin; the
 * winner and its slave are held until the response handshake. Four blocks: grant, master multiplexer,
 * decoder, answer routing; the slaves' valids are the granted master's gated by the decoder.
 */
export function axiBus(M: number, codes: number[]): ComponentDef {
  const S = codes.length;
  const id = `axibus${M}_${codes.join('_')}`;
  return memo(id, () => {
    const b = new Builder(18, 20);
    const g = kit(b);
    const mp = (m: number, s: string) => `m${m}_${s}`, sp = (k: number, s: string) => `s${k}_${s}`;
    const gr = b.op(axiGrant(M), [...Array.from({ length: M }, (_, m) => g.or(mp(m, 'awvalid'), mp(m, 'arvalid'))), '', 'clk'], 'grant', 'grant');
    const mx = b.op(axiMasterMux(M), [...Array.from({ length: M }, (_, m) => M_OUT.map((s) => mp(m, s))).flat(), ...Array.from({ length: M }, (_, m) => `${gr}.grant${m}`)], 'master mux', 'mmux');
    b.next();
    const dc = b.op(axiDecoder(codes), [`${mx}.awaddr`, `${mx}.araddr`, `${mx}.awvalid`, `${gr}.busy`, 'clk'], 'decoder', 'dec');
    b.next();
    for (let k = 0; k < S; k++) {
      for (const s of ['awaddr', 'wdata', 'wstrb', 'araddr'] as const) b.wire(`${mx}.${s}`, sp(k, s));
      for (const s of ['awvalid', 'wvalid', 'arvalid', 'bready', 'rready'] as const) b.wire(g.and(`${mx}.${s}`, `${dc}.sel${k}`), sp(k, s));
    }
    b.next();
    const an = b.op(axiAnswer(M, S), [...Array.from({ length: S }, (_, k) => M_IN.map((s) => sp(k, s))).flat(), ...Array.from({ length: S }, (_, k) => `${dc}.sel${k}`), ...Array.from({ length: M }, (_, m) => `${gr}.grant${m}`), `${mx}.bready`, `${mx}.rready`], 'answer', 'ans');
    b.wire(`${an}.respDone`, `${gr}.respDone`);
    for (let m = 0; m < M; m++) for (const s of M_IN) b.wire(`${an}.m${m}_${s}`, mp(m, s));
    const ports: PortDef[] = [];
    for (let m = 0; m < M; m++) ports.push(...slavePorts(`m${m}_`));
    for (let k = 0; k < S; k++) ports.push(...masterPorts(`s${k}_`));
    ports.push(bit('clk', 'in', 'bottom', true));
    return define({
      id, name: `Bus interconnect (${M} masters, ${S} slaves)`, category: 'memory',
      summary: `Round-robin arbitration between ${M} masters, an address decoder on the top four address bits (${codes.slice(0, S - 1).map((c) => `0x${c.toString(16)}…`).join(', ')}; anything else to the last slave), one transaction at a time: the granted master and its slave are held until the response handshake.`,
      ports, symbol: { kind: 'box', label: 'BUS' },
      netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * A slave's handshake: ready while idle; the response valid `wait` + 1 cycles after the address (wait
 * states), until the master takes it. Returns the handshake strobes and the response valids.
 */
function slaveFsm(b: Builder, g: ReturnType<typeof kit>, wait: number) {
  const bq = b.op(DFF, ['', 'clk'], 'bvalid', 'bq'), rq = b.op(DFF, ['', 'clk'], 'rvalid', 'rq');
  let pend = '', pendWr = '', cnt = '', cw = 0;
  if (wait > 0) {
    cw = Math.max(1, Math.ceil(Math.log2(wait + 1)));
    pend = b.op(DFF, ['', 'clk'], 'waiting', 'pend');
    pendWr = b.op(DFF, ['', 'clk'], 'a write', 'pwr');
    cnt = b.op(register(cw), ['', g.konst(1, 1), 'clk'], 'wait states', 'cnt');
  }
  const busy = g.or(`${bq}.q`, `${rq}.q`, ...(wait > 0 ? [`${pend}.q`] : []));
  const idle = b.name(g.not(busy), 'idle', true);
  const wrHs = b.name(g.and('awvalid', 'wvalid', idle), 'write', true);
  const rdHs = b.name(g.and('arvalid', idle), 'read', true);
  let wrDone = wrHs, rdDone = rdHs;
  if (wait > 0) {
    const z = b.op1(isZero(cw), [`${cnt}.q`]);
    const fire = g.and(`${pend}.q`, z);
    wrDone = g.and(fire, `${pendWr}.q`);
    rdDone = g.and(fire, g.not(`${pendWr}.q`));
    b.wire(g.or(wrHs, rdHs, g.and(`${pend}.q`, g.not(z))), `${pend}.d`);
    b.wire(g.mux(1, `${pendWr}.q`, wrHs, g.or(wrHs, rdHs)), `${pendWr}.d`);
    const allOnes = g.konst(cw, 2 ** cw - 1);
    const dec = b.op1(bitwise('xor', cw), [b.op1(incrementer(cw), [b.op1(bitwise('xor', cw), [`${cnt}.q`, allOnes])]), allOnes]);
    b.wire(g.mux(cw, g.gate(dec, cw, g.not(z)), g.konst(cw, wait - 1), g.or(wrHs, rdHs)), `${cnt}.d`);
  }
  b.wire(g.or(wrDone, g.and(`${bq}.q`, g.not('bready'))), `${bq}.d`);
  b.wire(g.or(rdDone, g.and(`${rq}.q`, g.not('rready'))), `${rq}.d`);
  b.wire(idle, 'awready'); b.wire(idle, 'wready'); b.wire(idle, 'arready');
  b.wire(`${bq}.q`, 'bvalid'); b.wire(`${rq}.q`, 'rvalid');
  return { wrHs, rdHs, rdDone };
}

/**
 * A RAM slave of 2^k words in four byte lanes (bigRam each): a write lands at its handshake, a read is
 * captured then; the response comes after `wait` wait states.
 */
export function axiRam(k: number, wait = 0): ComponentDef {
  const id = `axiram${k}_${wait}`;
  return memo(id, () => ramSlave(id, k, wait, `RAM slave (${2 ** k} words${wait ? `, ${wait} wait states` : ''})`, wait ? 'SLOW RAM' : 'RAM',
    `${2 ** k} words in four byte lanes behind the bus: ready whenever idle, a store written at its address handshake (byte enables from wstrb), a load's word answered ${wait ? `${wait + 1} cycles` : 'one cycle'} later.`));
}

/**
 * A screen on the bus: an n × n frame buffer, a byte a pixel (RGB332: rrrgggbb), pixel (x, y) at byte n·y + x.
 * It is the RAM slave (four byte lanes, so sb writes one pixel); a display reads the lanes as chapter 30's
 * scan-out reads its frame (here the panel paints them).
 */
export function axiScreen(n = 64): ComponentDef {
  const k = Math.log2((n * n) / 4);
  if (!Number.isInteger(k)) throw new Error('axiScreen: n must be a power of two');
  const id = `axiscreen${n}`;
  return memo(id, () => ramSlave(id, k, 0, `Screen slave (${n} × ${n}, RGB332)`, 'SCREEN',
    `A frame buffer behind the bus: ${n} × ${n} pixels, one byte each (RGB332: rrrgggbb), pixel (x, y) at byte ${n}·y + x, in four byte lanes so that sb writes one pixel. The display reads it as the scan-out of chapter 30 reads its frame.`));
}

function ramSlave(id: string, k: number, wait: number, name: string, label: string, summary: string): ComponentDef {
  {
    const b = new Builder(14, 14);
    const g = kit(b);
    const { wrHs, rdHs, rdDone } = slaveFsm(b, g, wait);
    b.next();
    const a = g.mux(32, 'araddr', 'awaddr', 'awvalid', 'address');
    const wa = g.split(a, [2, k, 30 - k])[1];
    const strb = g.split('wstrb', ones(4)), bytes = g.split('wdata', [8, 8, 8, 8]);
    b.next();
    const lanes = [0, 1, 2, 3].map((i) => b.op(bigRam(k, 8), [wa, bytes[i], g.and(wrHs, strb[i]), 'clk'], `byte ${i}`, `lane${i}`));
    b.next();
    // the word read at the address handshake, held until the response
    const rd = b.op(register(32), [g.merge(lanes.map((l) => `${l}.dout`), [8, 8, 8, 8]), rdHs, 'clk'], 'read data', 'rdr');
    void rdDone;
    b.wire(`${rd}.q`, 'rdata');
    const ports: PortDef[] = [...slavePorts(), bit('clk', 'in', 'bottom', true)];
    return define({
      id, name, category: 'memory', summary,
      ports, symbol: { kind: 'box', label },
      netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
    });
  }
}

/** Chapter 35's DRAM: 2^12 words (16 KB), 2 banks of 16-word rows, open page (chapter 33's controller). */
export const BUS_DRAM: DramConfig = { k: 12, banks: 2, rowWords: 16, policy: 'open' };

/**
 * A DRAM behind the bus: chapter 33's controller and device, and an adapter. The bus moves a word with byte
 * strobes; the controller moves 4-word lines. A load reads the line and keeps its word; a store writes the
 * line with the device's data mask (DDR's DM pins) on the strobed bytes of its word only, so a byte store
 * needs no read first. The request is latched at the handshake; the response comes the cycle after the
 * controller's done.
 */
export function axiDram(c: DramConfig = BUS_DRAM): ComponentDef {
  const id = `axidram${cfgKey(c)}`;
  return memo(id, () => {
    const b = new Builder(14, 14);
    const g = kit(b);
    const act = b.op(DFF, ['', 'clk'], 'request open', 'act');
    const bq = b.op(DFF, ['', 'clk'], 'bvalid', 'bq'), rq = b.op(DFF, ['', 'clk'], 'rvalid', 'rq');
    const idle = b.name(g.not(g.or(`${act}.q`, `${bq}.q`, `${rq}.q`)), 'idle', true);
    const wrHs = b.name(g.and('awvalid', 'wvalid', idle), 'write', true);
    const rdHs = b.name(g.and('arvalid', idle), 'read', true);
    const hs = g.or(wrHs, rdHs);
    b.next();
    // the request, latched at its handshake: the word address, read or write, the data and its strobes
    const wa = g.split(g.mux(32, 'araddr', 'awaddr', 'awvalid', 'address'), [2, c.k, 30 - c.k])[1];
    const rqr = b.op(register(c.k + 1), [g.merge([wa, wrHs], [c.k, 1]), hs, 'clk'], 'request', 'req');
    const [lw, la, wr] = g.split(`${rqr}.q`, [2, c.k - 2, 1]);
    const wdr = b.op(register(36), [g.merge(['wdata', 'wstrb'], [32, 4]), wrHs, 'clk'], 'write data', 'wd');
    const [wdata, strb] = g.split(`${wdr}.q`, [32, 4]);
    b.next();
    const ctrl = b.op(dramCtrl(c), [`${act}.q`, wr, la, 'clk'], 'controller', 'ctrl');
    b.next();
    // the burst's word that is this request's: its strobes as the data mask, its read word kept
    const mine = b.name(b.op1(equal(2), [`${ctrl}.word`, lw], 'this word'), 'mine', true);
    const dm = g.gate(strb, 4, g.and(`${ctrl}.wv`, mine));
    const dev = b.op(dramDevice(c, undefined, true), [`${ctrl}.cmd`, `${ctrl}.ba`, `${ctrl}.ra`, `${ctrl}.ca`, wdata, dm, 'clk'], 'DRAM', 'dev');
    b.next();
    const rdr = b.op(register(32), [`${dev}.rd`, g.and(`${ctrl}.dv`, mine), 'clk'], 'read data', 'rdr');
    const done = `${ctrl}.done`;
    b.wire(g.or(hs, g.and(`${act}.q`, g.not(done))), `${act}.d`);
    b.wire(g.or(g.and(done, wr), g.and(`${bq}.q`, g.not('bready'))), `${bq}.d`);
    b.wire(g.or(g.and(done, g.not(wr)), g.and(`${rq}.q`, g.not('rready'))), `${rq}.d`);
    b.wire(idle, 'awready'); b.wire(idle, 'wready'); b.wire(idle, 'arready');
    b.wire(`${bq}.q`, 'bvalid'); b.wire(`${rq}.q`, 'rvalid');
    b.wire(`${rdr}.q`, 'rdata');
    const ports: PortDef[] = [...slavePorts(), bit('clk', 'in', 'bottom', true)];
    return define({
      id, name: `DRAM slave (${2 ** c.k} words, ${c.banks} banks)`, category: 'memory',
      summary: `Chapter 33's controller and a DRAM of ${2 ** c.k} words behind the bus. A load reads its word's 4-word line; a store writes the line with the data mask set on its own strobed bytes only, so a byte store needs no read first. The response comes the cycle after the controller's done: a row hit, a closed bank and another open row each cost more (chapter 33).`,
      ports, symbol: { kind: 'box', label: 'DRAM' },
      netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The keyboard's queue (KEY_QUEUE) as a simulation holds it: the waiting codes, oldest first. */
export interface KeyQueueState { q: number[]; clk: number; ack: number }
export const KEY_QUEUE_DEPTH = 16;
export const isKeyQueue = (s: unknown): s is KeyQueueState => !!s && typeof s === 'object' && Array.isArray((s as KeyQueueState).q) && 'ack' in s;

/**
 * A keyboard: keys typed wait in order (at most KEY_QUEUE_DEPTH); code is the oldest (0 when none), ready 1
 * while one waits, and ack = 1 at a rising clock edge removes it. The world outside the circuit: a
 * behaviour with no structure (sim/types isExternal) that a panel fills through Sim.poke, with the same
 * pins as the sandbox's keyboard part.
 */
export const KEY_QUEUE: ComponentDef = {
  id: 'keyqueue', name: 'Keyboard (queue of typed keys)', category: 'memory',
  summary: `Keys typed wait here in order, ${KEY_QUEUE_DEPTH} at most. code: the oldest (ASCII, 0 when none); ready: 1 while one waits; ack = 1 at a rising clock edge removes it. The world outside the circuit: no gates.`,
  ports: [bit('ack', 'in'), bit('clk', 'in', 'bottom', true), bus('code', 8, 'out'), bit('ready', 'out')],
  symbol: { kind: 'box', label: 'KEYBOARD' },
  behavior: {
    delay: 1,
    seq: { clk: 'clk', comb: [] },
    init: (): KeyQueueState => ({ q: [], clk: 0, ack: 0 }),
    eval: ([ack, clk], st) => {
      const s = st as KeyQueueState;
      const k = clk < 0 ? 2 : clk;
      if (k !== 1) s.ack = ack === 1 ? 1 : 0;
      if (s.clk === 0 && k === 1 && s.ack && s.q.length) s.q = s.q.slice(1);
      s.clk = k;
      return [s.q[0] ?? 0, s.q.length ? 1 : 0];
    },
    carry: (prev) => prev,
  },
};

/**
 * The keyboard's slave: two registers, 0 the oldest key (reading it takes it: ack at the read's handshake)
 * and 4 the status (bit 0: a key waits). Writes are answered and dropped. code / ready / ack are the
 * keyboard's pins (KEY_QUEUE, or the sandbox's keyboard part).
 */
export const AXI_KEYS: ComponentDef = axiReadPort('axikeys', 'Keyboard slave', 'KEYS',
  'Two registers behind the bus: +0 the oldest waiting key (0 when none; reading it takes it from the keyboard), +4 the status (bit 0: a key waits). Writes are dropped.', [['code', 'ready', 'ack']]);

/** The default slave: answers any address (reads 0, writes ignored), so a stray address never hangs the bus. */
export const AXI_DEFAULT: ComponentDef = (() => {
  const b = new Builder(14, 14);
  const g = kit(b);
  slaveFsm(b, g, 0);
  b.wire(g.konst(32, 0), 'rdata');
  const ports: PortDef[] = [...slavePorts(), bit('clk', 'in', 'bottom', true)];
  return define({
    id: 'axidefault', name: 'Default slave', category: 'memory',
    summary: 'Answers every address no other slave decodes: reads give 0, writes are dropped. A real bus would answer with an error (DECERR) and the CPU would trap.',
    ports, symbol: { kind: 'box', label: 'DEFAULT' },
    netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * The DMA engine: a slave for its four registers (0 source, 4 destination, 8 length in words, 12
 * control / status: write 1 to start, 2 to clear done; read busy (bit 0) and done (bit 1)) and a master
 * that copies: read a word at the source, write it at the destination, step both by 4, until the length
 * is 0. irq stays 1 from the end of the copy until done is cleared.
 */
export const DMA_ENGINE: ComponentDef = (() => {
  const b = new Builder(16, 14);
  const g = kit(b);
  // ---- the slave side: registers
  const { wrHs, rdHs } = slaveFsm(b, g, 0);
  b.next();
  const regSel = g.split(g.mux(32, 'araddr', 'awaddr', 'awvalid'), [2, 2, 28])[1];
  const dsel = b.op(decoder(2, true), [regSel, wrHs], 'register', 'rsel');
  const wsel = [0, 1, 2, 3].map((i) => `${dsel}.y${i}`);
  // ---- the master side: one-hot state (idle when none), the registers that count
  const st = b.op(register(5), ['', g.konst(1, 1), 'clk'], 'state RA RD WA WB DONE', 'st');
  const [RA, RD, WA, WB, DONE] = g.split(`${st}.q`, ones(5));
  b.next();
  const busy = b.name(g.or(RA, RD, WA, WB), 'busy', true);
  const src = b.op(register(32), ['', g.konst(1, 1), 'clk'], 'source', 'src');
  const dst = b.op(register(32), ['', g.konst(1, 1), 'clk'], 'destination', 'dst');
  const len = b.op(register(16), ['', g.konst(1, 1), 'clk'], 'length', 'len');
  const data = b.op(register(32), ['', '', 'clk'], 'data', 'data');
  b.next();
  const rTake = g.and(RA, 'm_arready'), rGot = g.and(RD, 'm_rvalid'), wTake = g.and(WA, 'm_awready', 'm_wready'), wGot = b.name(g.and(WB, 'm_bvalid'), 'stored', true);
  b.wire(rGot, `${data}.en`);
  b.wire('m_rdata', `${data}.d`);
  const lenZero = b.op1(isZero(16), [`${len}.q`], 'length = 0');
  const lenOne = b.op1(equal(16), [`${len}.q`, g.konst(16, 1)], 'length = 1');
  const ctlData = g.split('wdata', [1, 1, 30]);
  const go = b.name(g.and(wsel[3], ctlData[0], g.not(busy), g.not(lenZero)), 'go', true);
  const clr = g.and(wsel[3], ctlData[1]);
  const last = g.and(wGot, lenOne);
  b.next();
  const nx = [
    g.or(go, g.and(wGot, g.not(lenOne)), g.and(RA, g.not(rTake))),
    g.or(rTake, g.and(RD, g.not(rGot))),
    g.or(rGot, g.and(WA, g.not(wTake))),
    g.or(wTake, g.and(WB, g.not(wGot))),
    g.or(last, g.and(DONE, g.not(clr), g.not(go))),
  ];
  b.wire(g.merge(nx), `${st}.d`);
  // registers: a store from the CPU wins; else the copy steps them
  /** A register's value + 4 (an incrementer on bits 31:2). */
  const step = (r: string) => {
    const parts = g.split(`${r}.q`, [2, 30]);
    return g.merge([parts[0], b.op1(incrementer(30), [parts[1]])], [2, 30]);
  };
  b.wire(g.mux(32, g.mux(32, `${src}.q`, step(src), wGot), 'wdata', wsel[0]), `${src}.d`);
  b.wire(g.mux(32, g.mux(32, `${dst}.q`, step(dst), wGot), 'wdata', wsel[1]), `${dst}.d`);
  const ones16 = g.konst(16, 0xffff);
  const lenDec = b.op1(bitwise('xor', 16), [b.op1(incrementer(16), [b.op1(bitwise('xor', 16), [`${len}.q`, ones16])]), ones16], 'length − 1');
  b.wire(g.mux(16, g.mux(16, `${len}.q`, lenDec, wGot), g.split('wdata', [16, 16])[0], wsel[2]), `${len}.d`);
  b.next();
  // reads of the registers: the word answered one cycle later
  const status = g.merge([busy, DONE, g.konst(30, 0)], [1, 1, 30]);
  const rmux = b.op1(muxTree(2, 32), [`${src}.q`, `${dst}.q`, g.merge([`${len}.q`, g.konst(16, 0)], [16, 16]), status, regSel], 'register read');
  const rdr = b.op(register(32), [rmux, rdHs, 'clk'], 'read data', 'rdr');
  b.wire(`${rdr}.q`, 'rdata');
  // the master's channels
  b.wire(RA, 'm_arvalid'); b.wire(`${src}.q`, 'm_araddr'); b.wire(g.konst(1, 1), 'm_rready');
  b.wire(WA, 'm_awvalid'); b.wire(WA, 'm_wvalid'); b.wire(`${dst}.q`, 'm_awaddr'); b.wire(`${data}.q`, 'm_wdata'); b.wire(g.konst(4, 15), 'm_wstrb'); b.wire(g.konst(1, 1), 'm_bready');
  b.wire(DONE, 'irq'); b.wire(busy, 'busy');
  const ports: PortDef[] = [...slavePorts(), ...masterPorts('m_'), bit('clk', 'in', 'bottom', true), bit('irq', 'out'), bit('busy', 'out')];
  return define({
    id: 'dma', name: 'DMA engine', category: 'memory',
    summary: 'A bus slave with four registers (source, destination, length in words, control / status) and a bus master that copies: read a word, write it, step both addresses by 4, until the length is 0; then irq until done is cleared. Two bus transactions per word.',
    ports, symbol: { kind: 'box', label: 'DMA' },
    netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
  });
})();

/** The flash slave's state: the device, the page in its buffer, a read waiting for a page. */
interface FlashSlaveState {
  dev: FlashDevice;
  buf: number;
  clk: number;
  pend: { ar: number; arv: number; aw: number; awv: number; wv: number; br: number; rr: number };
  /** A read in progress: its word address and the cycles left. */
  read: { word: number; left: number } | null;
  bvalid: number; rvalid: number; rdata: number;
}

/**
 * A NAND flash as a bus slave (read only): the controller reads the page holding the word into its page
 * buffer (FLASH_TIMES.read cycles) unless it is there already, then answers from the buffer. Writes are
 * answered and dropped (programming goes through the controller's commands, not the window).
 */
export function axiFlash(image: ArrayLike<number>, g: FlashGeometry = { blocks: 16, pagesPerBlock: 16, wordsPerPage: 16 }): ComponentDef {
  const ports: PortDef[] = [...slavePorts(), bit('clk', 'in', 'bottom', true)];
  const words = g.blocks * g.pagesPerBlock * g.wordsPerPage;
  return {
    id: `axiflash_${image.length}_${hashWords(image)}`, name: `Flash slave (${words} words, ${g.wordsPerPage}-word pages)`, category: 'memory',
    summary: `A NAND flash behind the bus, read only: a word in the page buffer comes the next cycle; any other costs a page read into the buffer, ${FLASH_TIMES.read} cycles.`,
    ports, symbol: { kind: 'box', label: 'FLASH' },
    behavior: {
      delay: 4,
      seq: { clk: 'clk', comb: [] },
      init: () => {
        const dev = new FlashDevice(g);
        for (let p = 0; p * g.wordsPerPage < image.length && p < dev.pages; p++) dev.program(p, Array.from({ length: g.wordsPerPage }, (_, i) => image[p * g.wordsPerPage + i] ?? 0xffffffff));
        dev.cycles = 0; dev.log.length = 0;
        return { dev, buf: -1, clk: 0, pend: { ar: 0, arv: 0, aw: 0, awv: 0, wv: 0, br: 0, rr: 0 }, read: null, bvalid: 0, rvalid: 0, rdata: 0 } satisfies FlashSlaveState;
      },
      eval: (ins, st) => {
        const s = st as FlashSlaveState;
        const [awv, aw, wv, , , br, arv, ar, rr, clk] = ins;
        const k = clk < 0 ? 2 : clk;
        if (k !== 1) s.pend = { ar, arv: Math.max(0, arv), aw, awv: Math.max(0, awv), wv: Math.max(0, wv), br: Math.max(0, br), rr: Math.max(0, rr) };
        const idle = !s.bvalid && !s.rvalid && !s.read;
        if (s.clk === 0 && k === 1) {
          const p = s.pend;
          if (s.bvalid && p.br) s.bvalid = 0;
          if (s.rvalid && p.rr) s.rvalid = 0;
          if (idle && p.awv && p.wv) s.bvalid = 1;
          else if (idle && p.arv) {
            const word = ((p.ar >>> 2) & (words - 1)), page = Math.floor(word / g.wordsPerPage);
            s.read = { word, left: page === s.buf ? 0 : FLASH_TIMES.read };
          } else if (s.read) {
            if (s.read.left > 0) s.read.left--;
            if (s.read.left === 0) {
              const page = Math.floor(s.read.word / g.wordsPerPage);
              if (page !== s.buf) { s.dev.read(page); s.buf = page; }
              s.rdata = s.dev.data[s.read.word];
              s.rvalid = 1;
              s.read = null;
            }
          }
        }
        s.clk = k;
        const ready = !s.bvalid && !s.rvalid && !s.read ? 1 : 0;
        return [ready, ready, s.bvalid, ready, s.rvalid, s.rdata];
      },
    },
    hdl: { verilog: '// a NAND flash behind the bus: see flash/model.ts (not synthesizable)' },
  };
}

function hashWords(a: ArrayLike<number>): string {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) h = Math.imul(h ^ (a[i] >>> 0), 16777619) >>> 0;
  return h.toString(16);
}

/**
 * A bus bench (chapter 35's scenes, the tests): a request port standing in for the CPU (req, we, addr,
 * wdata, be → done, rdata), the DMA engine, the interconnect, a flash holding `image`, a RAM of 2^k
 * words with `wait` wait states, and the default slave. The computer's map (bus/model.ts MAP): RAM from
 * 0, flash at 0x1000_0000, the DMA's registers at 0x4000_0000.
 */
export function busBench(image: ArrayLike<number>, k = 10, wait = 0): ComponentDef {
  const FL = axiFlash(image);
  const id = `busbench_${FL.id}_${k}_${wait}`;
  return memo(id, () => {
    const b = new Builder(10, 20);
    b.pins('req', 'we', 'addr', 'wdata', 'be', 'clk');
    const cpu = b.op(AXI_PORT, ['req', 'we', 'addr', 'wdata', 'be', 'clk'], 'CPU port', 'cpu');
    const dma = b.op(DMA_ENGINE, [], 'DMA', 'dma');
    b.next();
    const BUS = axiBus(2, [MAP.ram, MAP.flash, MAP.dma, 0xf]);
    const bx = b.op(BUS, [], 'interconnect', 'bus');
    b.next();
    const slaves = [b.op(axiRam(k, wait), [], 'RAM', 'ram'), b.op(FL, [], 'flash', 'flash'), 'dma', b.op(AXI_DEFAULT, [], 'default', 'def')];
    // masters: 0 the CPU port, 1 the DMA's master side
    for (const s of M_OUT) { b.wire(`${cpu}.${s}`, `${bx}.m0_${s}`); b.wire(`${dma}.m_${s}`, `${bx}.m1_${s}`); }
    for (const s of M_IN) { b.wire(`${bx}.m0_${s}`, `${cpu}.${s}`); b.wire(`${bx}.m1_${s}`, `${dma}.m_${s}`); }
    slaves.forEach((sl, i) => {
      for (const s of M_OUT) b.wire(`${bx}.s${i}_${s}`, `${sl}.${s}`);
      for (const s of M_IN) b.wire(`${sl}.${s}`, `${bx}.s${i}_${s}`);
    });
    for (const x of [dma, bx, slaves[0], slaves[1], slaves[3]]) b.wire('clk', `${x}.clk`);
    b.wire(`${cpu}.done`, 'done'); b.wire(`${cpu}.rdataOut`, 'rdata'); b.wire(`${dma}.irq`, 'irq');
    const R = b.right;
    return define({
      id, name: 'Bus bench (a requester, DMA, flash, RAM)', category: 'memory',
      summary: 'A request port standing in for the CPU and the DMA engine share one bus to a RAM (from 0), a flash (0x1000_0000) and the DMA\'s registers (0x4000_0000).',
      ports: [bit('req', 'in'), bit('we', 'in'), bus('addr', 32, 'in'), bus('wdata', 32, 'in'), bus('be', 4, 'in'), bit('clk', 'in', 'bottom', true), bit('done', 'out'), bus('rdata', 32, 'out'), bit('irq', 'out')],
      symbol: { kind: 'box', label: 'BUS BENCH' },
      netlist: () => ({ pins: { req: [0, 4], we: [0, 8], addr: [0, 12], wdata: [0, 16], be: [0, 20], clk: [0, 26], done: [R, 4], rdata: [R, 8], irq: [R, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The instruction the decoder sees while an instruction is being fetched over the bus: addi x0, x0, 0. */
export const NOP_WORD = 0x00000013;

/**
 * The system CPU's memory over the bus (systemCpu({ bus })): in place of its data memory, with the same
 * ports (addr, wdata, be, we → rdata) plus the instruction side. An instruction below the boot ROM's
 * size comes from the ROM (romData); any other is fetched over the bus into an instruction register,
 * the decoder seeing a NOP meanwhile. Loads (re) and stores (we) go over the bus. stall holds the CPU
 * until the instruction is in and its access done; irqOk lets an interrupt in unless a fetch or an access is
 * under way since an earlier cycle (in an access's first cycle the trap takes its request back: we and re
 * fall with NoTrap). A flip-flop, not the request: the request depends on the trap, the trap on irqOk.
 */
export function busMemUnit(imemK: number): ComponentDef {
  return memo(`busmem${imemK}`, () => {
    const b = new Builder(14, 14);
    const g = kit(b);
    b.pins('addr', 'wdata', 'be', 'we', 're', 'pc', 'romData', 'clk');
    const hi = g.split('pc', [imemK + 2, 30 - imemK])[1];
    const inRom = b.name(b.op1(isZero(30 - imemK), [hi], 'in the boot ROM'), 'inRom', true);
    const irv = b.op(DFF, ['', 'clk'], 'instruction in', 'irv');
    const ir = b.op(register(32), ['', '', 'clk'], 'instruction register', 'ir');
    const fetch = b.name(g.and(g.not(inRom), g.not(`${irv}.q`)), 'fetch', true);
    b.next();
    const dataReq = b.name(g.and(g.not(fetch), g.or('we', 're')), 'access', true);
    const port = b.op(AXI_PORT, [g.or(fetch, dataReq), g.and(dataReq, 'we'), g.mux(32, 'addr', 'pc', fetch, 'fetch or data'), 'wdata', 'be', 'clk'], 'bus port', 'port');
    b.next();
    const done = `${port}.done`;
    const fetched = b.name(g.and(done, fetch), 'fetched', true);
    b.wire(fetched, `${ir}.en`);
    b.wire(`${port}.rdataOut`, `${ir}.d`);
    const stall = b.name(g.or(fetch, g.and(dataReq, g.not(done))), 'stall', true);
    b.wire(g.or(fetched, g.and(`${irv}.q`, stall)), `${irv}.d`);
    b.wire(g.mux(32, g.mux(32, g.konst(32, NOP_WORD), `${ir}.q`, `${irv}.q`, 'IR or NOP'), 'romData', inRom, 'instruction'), 'instr');
    b.wire(`${port}.rdataOut`, 'rdata');
    b.wire(stall, 'stall');
    // an access requested and not done: a flip-flop, so irqOk does not depend on this cycle's request
    const infl = b.op(DFF, ['', 'clk'], 'access under way', 'infl');
    b.wire(g.and(dataReq, g.not(done)), `${infl}.d`);
    b.wire(g.not(g.or(fetch, `${infl}.q`)), 'irqOk');
    for (const s of M_IN) b.wire(`bus_${s}`, `${port}.${s}`);
    for (const s of M_OUT) b.wire(`${port}.${s}`, `bus_${s}`);
    const ports: PortDef[] = [bus('addr', 32, 'in'), bus('wdata', 32, 'in'), bus('be', 4, 'in'), bit('we', 'in'), bit('clk', 'in', 'bottom', true), bit('re', 'in'), bus('pc', 32, 'in'), bus('romData', 32, 'in'),
      ...M_IN.map((s) => ({ name: `bus_${s}`, width: wOf(s), dir: 'in' as const })),
      bus('rdata', 32, 'out'), bus('instr', 32, 'out'), bit('stall', 'out'), bit('irqOk', 'out'), ...M_OUT.map((s) => ({ name: `bus_${s}`, width: wOf(s), dir: 'out' as const }))];
    return define({
      id: `busmem${imemK}`, name: 'Memory over the bus', category: 'memory',
      summary: `The CPU's memory side on a bus: instructions below ${4 * 2 ** imemK} bytes from the boot ROM, any other fetched over the bus into an instruction register (a NOP meanwhile); loads and stores over the bus. stall holds the CPU until both are done.`,
      ports, symbol: { kind: 'box', label: 'MEMORY BUS' },
      netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- the sandbox's system on a bus: ports for its parts, and bundled links -------------------------------

/**
 * A read-to-take port: per channel two registers behind the bus, at 8·i the data (reading it takes it: ack at
 * the read's handshake, if ready) and at 8·i + 4 the status (bit 0: ready). Writes are dropped. A channel is
 * [data, ready, ack] pin names: the keyboard's (code / ready / ack: KEY_QUEUE or the sandbox's keyboard part),
 * a timer's (its count's low byte, irq, ack).
 */
function axiReadPort(id: string, name: string, label: string, summary: string, chans: [string, string, string][]): ComponentDef {
  const b = new Builder(14, 14);
  const g = kit(b);
  const { rdHs } = slaveFsm(b, g, 0);
  b.next();
  const n = chans.length, cb = Math.ceil(Math.log2(n));
  const [, st, ch] = g.split('araddr', cb ? [2, 1, cb, 29 - cb] : [2, 1, 29]);
  const status = b.name(st, 'status', true);
  const which = cb ? b.op(decoder(cb, false), [ch], 'channel') : '';
  const words = chans.map(([data, ready, ack], i) => {
    const sel = cb ? `${which}.y${i}` : '';
    // ack from a flip-flop: the item goes at the edge after the read (the slave is busy answering meanwhile), and
    // a keyboard part with no clock of its own sees no path from its outputs back to its ack (the cycle engine)
    const ackq = b.op(DFF, [b.name(g.and(rdHs, g.not(status), ready, ...(sel ? [sel] : [])), `take ${data}`, true), 'clk'], `${ack} next cycle`, `${ack}q`);
    b.wire(`${ackq}.q`, ack);
    return g.mux(32, g.merge([data, g.konst(24, 0)], [8, 24]), g.merge([ready, g.konst(31, 0)], [1, 31]), status, `${data} or status`);
  });
  const word = n === 1 ? words[0] : b.op1(muxTree(cb, 32), [...words, ...(2 ** cb > n ? Array(2 ** cb - n).fill(g.konst(32, 0)) : []), ch], 'channel');
  const rdr = b.op(register(32), [word, rdHs, 'clk'], 'read data', 'rdr');
  b.wire(`${rdr}.q`, 'rdata');
  const ports: PortDef[] = [...slavePorts(), ...chans.flatMap(([data, ready]) => [bus(data, 8, 'in'), bit(ready, 'in')]), bit('clk', 'in', 'bottom', true), ...chans.map(([, , ack]) => bit(ack, 'out'))];
  return define({ id, name, category: 'memory', summary, ports, symbol: { kind: 'box', label }, netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }) });
}

/**
 * The sandbox system's I/O port: the keyboard at +0 (the oldest key, taken when read) and +4 (status), the timer
 * at +8 (the low byte of its count; reading it acknowledges its interrupt) and +12 (bit 0: irq).
 */
export const AXI_IO_PORT: ComponentDef = axiReadPort('axiio', 'I/O port (keyboard and timer)', 'I/O PORT',
  'Four registers behind the bus: +0 the oldest waiting key (reading it takes it: kack), +4 bit 0 a key waits; +8 the low byte of a timer\'s count (reading it acknowledges the timer\'s interrupt: tack), +12 bit 0 its irq. Writes are dropped.',
  [['code', 'ready', 'kack'], ['count', 'irq', 'tack']]);

/**
 * A screen's write port: a store to base + 256·y + 4·x sets pixel (x, y) of a 64 × 64 screen to the store's
 * low byte. x, y, color and we go to the sandbox's screen part (write mode), which takes them at the clock
 * edge of the write's handshake. Reads give 0.
 */
export const AXI_PIXEL: ComponentDef = (() => {
  const b = new Builder(14, 14);
  const g = kit(b);
  const { wrHs } = slaveFsm(b, g, 0);
  b.next();
  const [, x, y] = g.split('awaddr', [2, 6, 6, 18]);
  b.wire(x, 'x'); b.wire(y, 'y'); b.wire(g.split('wdata', [8, 24])[0], 'color'); b.wire(wrHs, 'we');
  b.wire(g.konst(32, 0), 'rdata');
  const ports: PortDef[] = [...slavePorts(), bit('clk', 'in', 'bottom', true), bus('x', 6, 'out'), bus('y', 6, 'out'), bus('color', 8, 'out'), bit('we', 'out')];
  return define({
    id: 'axipixel', name: 'Screen port (a pixel a store)', category: 'memory',
    summary: 'A store to base + 256·y + 4·x writes pixel (x, y) of a 64 × 64 screen, its colour the low byte: x, y, color and we for a screen part, taken at the edge of the write\'s handshake. Reads give 0.',
    ports, symbol: { kind: 'box', label: 'PIXEL PORT' },
    netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * A flash's read window over a ROM part of 2^k words (the ROM holds the contents; this is the timing): a
 * page buffer tag (16-word pages) and a counter. A word of the page in the buffer is answered 2 cycles after
 * its address, any other after a page read of `read` cycles, as chapter 34's flash (axiFlash). addr: the word
 * the ROM must show (held from the address handshake), data: what it shows. Writes are answered and dropped.
 */
export function axiFlashWindow(k: number, read = FLASH_TIMES.read): ComponentDef {
  const id = `axiflashwin${k}_${read}`;
  return memo(id, () => {
    if (k < 5) throw new Error('axiFlashWindow: at least two pages');
    const b = new Builder(14, 14);
    const g = kit(b);
    const cw = Math.max(1, Math.ceil(Math.log2(read)));
    const pend = b.op(DFF, ['', 'clk'], 'reading', 'pend');
    const bq = b.op(DFF, ['', 'clk'], 'bvalid', 'bq'), rq = b.op(DFF, ['', 'clk'], 'rvalid', 'rq');
    const idle = b.name(g.not(g.or(`${pend}.q`, `${bq}.q`, `${rq}.q`)), 'idle', true);
    const wrHs = b.name(g.and('awvalid', 'wvalid', idle), 'write', true);
    const rdHs = b.name(g.and('arvalid', idle), 'read', true);
    b.next();
    // the word asked for, held; its page against the page in the buffer
    const wa = g.split('araddr', [2, k, 30 - k])[1];
    const ra = b.op(register(k), [wa, rdHs, 'clk'], 'word', 'ra');
    const tag = b.op(register(k - 4), ['', '', 'clk'], 'page in the buffer', 'tag');
    const valid = b.op(DFF, ['', 'clk'], 'buffer valid', 'valid');
    const hit = b.name(g.and(`${valid}.q`, b.op1(equal(k - 4), [g.split(wa, [4, k - 4])[1], `${tag}.q`], 'same page')), 'hit', true);
    b.next();
    const cnt = b.op(register(cw), ['', g.konst(1, 1), 'clk'], 'page read', 'cnt');
    const z = b.op1(isZero(cw), [`${cnt}.q`], '= 0');
    const fire = b.name(g.and(`${pend}.q`, z), 'answer', true);
    const allOnes = g.konst(cw, 2 ** cw - 1);
    const dec = b.op1(bitwise('xor', cw), [b.op1(incrementer(cw), [b.op1(bitwise('xor', cw), [`${cnt}.q`, allOnes])]), allOnes], '− 1');
    b.wire(g.mux(cw, g.gate(dec, cw, g.not(z)), g.mux(cw, g.konst(cw, read - 1), g.konst(cw, 0), hit), rdHs, 'next count'), `${cnt}.d`);
    b.next();
    b.wire(g.or(rdHs, g.and(`${pend}.q`, g.not(z))), `${pend}.d`);
    b.wire(g.split(`${ra}.q`, [4, k - 4])[1], `${tag}.d`); b.wire(fire, `${tag}.en`);
    b.wire(g.or(`${valid}.q`, fire), `${valid}.d`);
    const rdr = b.op(register(32), ['data', fire, 'clk'], 'read data', 'rdr');
    b.wire(g.or(wrHs, g.and(`${bq}.q`, g.not('bready'))), `${bq}.d`);
    b.wire(g.or(fire, g.and(`${rq}.q`, g.not('rready'))), `${rq}.d`);
    b.wire(idle, 'awready'); b.wire(idle, 'wready'); b.wire(idle, 'arready');
    b.wire(`${bq}.q`, 'bvalid'); b.wire(`${rq}.q`, 'rvalid');
    b.wire(`${rdr}.q`, 'rdata');
    b.wire(`${ra}.q`, 'addr');
    const ports: PortDef[] = [...slavePorts(), bus('data', 32, 'in'), bit('clk', 'in', 'bottom', true), bus('addr', k, 'out')];
    return define({
      id, name: `Flash window (${2 ** k} words, 16-word pages)`, category: 'memory',
      summary: `A flash's timing over a ROM of ${2 ** k} words that holds its contents (addr out, data in): a word of the page in the buffer comes 2 cycles after its address, any other after a page read of ${read} cycles (chapter 34). Writes are dropped.`,
      ports, symbol: { kind: 'box', label: 'FLASH' },
      netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The channel signals a master drives, packed bit 0 first (M_OUT order): 105 bits. */
export const REQ_BITS = M_OUT.reduce((s, x) => s + wOf(x), 0);
/** What comes back (M_IN order): 37 bits. */
export const RSP_BITS = M_IN.reduce((s, x) => s + wOf(x), 0);

/**
 * A part with its bus ports packed: every group (a prefix, and whether the part is the master or the slave
 * of that link) becomes two buses, `<prefix>req` (the master's signals, REQ_BITS) and `<prefix>rsp` (the
 * slave's, RSP_BITS). A link is then two wires: the sandbox's System on a bus draws it so.
 */
export function bundled(def: ComponentDef, groups: [string, 'master' | 'slave'][], id: string): ComponentDef {
  return memo(id, () => {
    const b = new Builder(10, 14);
    const own = new Set(groups.flatMap(([p]) => [...M_OUT, ...M_IN].map((s) => p + s)));
    const other = def.ports.filter((p) => !own.has(p.name));
    const from = new Map<string, string>();
    for (const [p, side] of groups) {
      const sigs = side === 'master' ? M_IN : M_OUT;
      const s = b.op(splitter(sigs.map(wOf)), [side === 'master' ? `${p}rsp` : `${p}req`]);
      sigs.forEach((sg, i) => from.set(p + sg, `${s}.o${i}`));
    }
    b.next();
    const core = b.op(def, def.ports.filter((pt) => pt.dir === 'in').map((pt) => from.get(pt.name) ?? pt.name), def.name, 'core');
    b.next();
    for (const [p, side] of groups) {
      const sigs = side === 'master' ? M_OUT : M_IN;
      b.wire(b.op1(merger(sigs.map(wOf)), sigs.map((sg) => `${core}.${p}${sg}`)), side === 'master' ? `${p}req` : `${p}rsp`);
    }
    for (const pt of other) if (pt.dir === 'out') b.wire(`${core}.${pt.name}`, pt.name);
    const packIn = groups.map(([p, side]) => bus(side === 'master' ? `${p}rsp` : `${p}req`, side === 'master' ? RSP_BITS : REQ_BITS, 'in'));
    const packOut = groups.map(([p, side]) => bus(side === 'master' ? `${p}req` : `${p}rsp`, side === 'master' ? REQ_BITS : RSP_BITS, 'out'));
    const ports: PortDef[] = [...other.filter((p) => p.dir === 'in'), ...packIn, ...other.filter((p) => p.dir === 'out'), ...packOut];
    return define({
      id, name: `${def.name}, bus bundled`, category: def.category,
      summary: `${def.summary ?? def.name} Its bus ports packed: per link a request bus (the master's ${M_OUT.length} signals, ${REQ_BITS} bits) and a response bus (${M_IN.length} signals, ${RSP_BITS} bits).`,
      ports, symbol: { ...def.symbol, kind: 'box' },
      netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
    });
  });
}

/** One of each generated part, registered for the library-wide checks (and the workbench). */
export const BUS_PARTS = [axiBus(2, [0x0, 0x1, 0x4, 0xf]), axiRam(10), axiRam(10, 3), busMemUnit(7), busBench([1, 2, 3, 4]), axiDram(), axiScreen(64), AXI_KEYS, axiFlashWindow(8)];
