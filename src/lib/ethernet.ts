// Chapter 48's Ethernet in gates: the MAC transmitter (preamble, SFD, pad, FCS, the gap, and CSMA/CD: carrier sense,
// collision, jam, truncated binary exponential backoff), the receiver (SFD hunt, byte stream, FCS check, address filter),
// the shared wire, a station that puts frame buffers (lib/bigmem.ts) around the two MACs, and a segment of four stations
// on one cable. Everything but the wire is NAND gates and the library's flip-flops in boxes of their own (lib/rtl.ts);
// comm/mac.ts holds the models the tests compare them with after every clock.
//
// Link speed: a bit is 4 clocks. Interfaces: the byte stream of comm/ethframe.ts on the host side; on the line side a
// serial pair, (txd, txen) out and (rxd, crs) in, with `col` into the transmitter: the MII's shape with one bit instead of
// four. For a full-duplex link the pairs of two MACs are crossed and crs = the peer's txen, col = 0.

import { CRC32_REFLECTED } from '../comm/crc';
import {
  LFSR_BITS, RX_BITS, wireHistory, wireOutputs, wirePush,
} from '../comm/mac';
import { MAX_FRAME } from '../comm/ethframe';
import type { ComponentDef, PortDef } from '../sim/types';
import { crcUnit } from './crc';
import { define } from './define';
import { Rtl, type Sig } from './rtl';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

// ---- small helpers on the kit ------------------------------------------------------------------------------------------

/** bits (LSB first) ≥ the constant c. */
function geConst(m: Rtl, bits: Sig[], c: number): Sig {
  let ge = m.const(1);
  bits.forEach((b, i) => { ge = (c >> i) & 1 ? m.and(b, ge) : m.or(b, ge); });
  return ge;
}
const constBit = (m: Rtl, v: number, i: number): Sig => m.const(((v >> i) & 1) as 0 | 1);
/** s ? b : a, bitwise. */
const mux = (m: Rtl, s: Sig, a: Sig[], b: Sig[]): Sig[] => a.map((x, i) => m.mux(s, x, b[i]));
const gate = (m: Rtl, en: Sig, bits: Sig[]): Sig[] => bits.map((x) => m.and(en, x));
const regs = (m: Rtl, clk: Sig, name: string, n: number): Sig[] => Array.from({ length: n }, (_, i) => m.reg(clk, n === 1 ? name : `${name}${i}`));
const dec = (m: Rtl, a: Sig[]): Sig[] => m.inc(a.map((x) => m.not(x))).map((x) => m.not(x));

// ---- the transmitter ---------------------------------------------------------------------------------------------------

let txDef: ComponentDef | undefined;

/**
 * Takes a frame from the byte stream (data, valid, last; `ready` says when a byte moves) and sends it LSB first, a bit every
 * four clocks: 7 bytes of 0x55, the SFD 0xD5, the bytes (zero pad up to 60), the four FCS bytes from the CRC unit. It starts
 * when valid, the cable has been quiet for 96 bit times (gap counter) and crs is low; a collision (col while sending) cuts the
 * frame into a 32-bit jam, then waits r slots of 512 bit times, r the low min(n, 10) bits of a free-running LFSR for the n-th
 * collision, and starts over (restart: the source rewinds); the 16th collision drops the frame (drop). A byte that is not valid when the MAC needs it (an underrun) ends the frame, padded, with its FCS complemented so that every receiver rejects it.
 */
export function macTx(): ComponentDef {
  if (txDef) return txDef;
  const m = new Rtl({
    id: 'eth_mac_tx', name: 'Ethernet MAC transmitter', category: 'sequential', label: 'MAC TX', columnHeight: 60,
    summary: 'Preamble, SFD, frame bytes from a stream, pad to 64, FCS from a CRC-32 unit, then the gap; half duplex adds carrier sense, collision detect, jam and truncated binary exponential backoff. One bit every four clocks, least significant bit first.',
  });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst');
  const data = m.inputBus('data', 8), valid = m.input('valid'), last = m.input('last'), crs = m.input('crs'), col = m.input('col');
  const seed = m.inputBus('seed', LFSR_BITS);
  const rstn = m.not(rst);
  const gapok = m.fwd('f_gapok'), back = m.fwd('f_back'), bonz = m.fwd('f_bonz');
  const fbyte = Array.from({ length: 8 }, (_, i) => m.fwd(`f_fbyte${i}`));
  const nm = (s: Sig, n: string) => m.name(s, n);

  const c = m.scope('ctl', 'state machine, counters', () => {
    const pre = m.reg(clk, 'pre'), dat = m.reg(clk, 'dat'), fcs = m.reg(clk, 'fcs'), jam = m.reg(clk, 'jam');
    const ph = regs(m, clk, 'ph', 2), bt = regs(m, clk, 'bit', 3), pc = regs(m, clk, 'pc', 3), nb = regs(m, clk, 'nb', 6);
    const eof = m.reg(clk, 'eof'), under = m.reg(clk, 'under'), fc = regs(m, clk, 'fc', 2), att = regs(m, clk, 'att', 4);
    const rs = m.reg(clk, 'restart_q'), dr = m.reg(clk, 'drop_q'), sn = m.reg(clk, 'sent_q');
    const act = nm(m.orN([pre, dat, fcs, jam]), 'act');
    const idle = m.nor(act, back);
    const tick = nm(m.and(act, m.and(ph[0], ph[1])), 'tick');
    const bb = nm(m.and(tick, m.andN(bt)), 'bb');
    const pc7 = nm(m.andN(pc), 'pc7'), pc6 = nm(m.eqConst(pc, 6), 'pc6'), pc3 = nm(m.eqConst(pc, 3), 'pc3');
    const nb60 = m.eqConst(nb, 60), eof60 = nm(m.and(eof, nb60), 'eof60');
    const att15 = nm(m.andN(att), 'att15');
    const start = nm(m.andN([idle, valid, gapok, m.not(crs)]), 'start');
    const colhit = nm(m.and(col, m.orN([pre, dat, fcs])), 'colhit');
    const nc = m.not(colhit);
    const preEnd = m.andN([pre, bb, pc7]), datEnd = nm(m.andN([dat, bb, eof60]), 'datend');
    const fcsEnd = m.andN([fcs, bb, m.andN(fc)]), jamEnd = nm(m.andN([jam, bb, pc3]), 'jamend');
    const firstOrData = m.or(m.and(pre, pc7), m.and(dat, m.not(eof)));
    const ready = nm(m.and(bb, firstOrData), 'ready');
    const load = nm(m.and(bb, m.or(m.and(pre, pc7), m.and(dat, m.not(eof60)))), 'load');
    const ncs = m.not(m.or(colhit, start));
    const run = m.and(rstn, ncs);
    m.setD(pre, m.and(rstn, m.or(start, m.andN([pre, m.not(preEnd), nc]))));
    m.setD(dat, m.and(rstn, m.or(m.and(preEnd, nc), m.andN([dat, m.not(datEnd), nc]))));
    m.setD(fcs, m.and(rstn, m.or(m.and(datEnd, nc), m.andN([fcs, m.not(fcsEnd), nc]))));
    m.setD(jam, m.and(rstn, m.or(colhit, m.and(jam, m.not(jamEnd)))));
    const phi = m.inc(ph);
    ph.forEach((q, i) => m.setD(q, m.and(m.and(run, act), phi[i])));
    const bti = m.inc(bt);
    bt.forEach((q, i) => m.setD(q, m.and(run, m.mux(tick, q, bti[i]))));
    const clr = m.orN([preEnd, jamEnd, dat, fcs]), pci = m.inc(pc);
    pc.forEach((q, i) => m.setD(q, m.and(run, m.mux(bb, q, m.and(m.not(clr), pci[i])))));
    const nbi = m.inc(nb);
    nb.forEach((q, i) => m.setD(q, m.and(m.and(rstn, m.not(start)), m.mux(load, q, m.mux(nb60, nbi[i], q)))));
    m.setD(eof, m.andN([rstn, m.not(start), m.mux(ready, eof, m.or(m.not(valid), last))]));
    m.setD(under, m.andN([rstn, m.not(start), m.or(under, m.and(ready, m.not(valid)))]));
    const fci = m.inc(fc);
    fc.forEach((q, i) => m.setD(q, m.andN([rstn, m.not(start), m.not(datEnd), m.mux(m.and(fcs, bb), q, fci[i])])));
    const ati = m.inc(att);
    att.forEach((q, i) => m.setD(q, m.andN([rstn, m.not(fcsEnd), m.mux(jamEnd, q, ati[i])])));
    m.setD(rs, m.andN([rstn, jamEnd, m.not(att15)]));
    m.setD(dr, m.andN([rstn, jamEnd, att15]));
    m.setD(sn, m.and(rstn, fcsEnd));
    return { under, pre, dat, fcs, jam, act, tick, bb, pc6, pc7, pc3, eof, eof60, start, colhit, load, ready, att, fc, rs, dr, sn, jamEnd, att15, datEnd };
  });

  const cs = m.scope('csma', 'gap counter, backoff, LFSR', () => {
    const gap = regs(m, clk, 'gap', 9), lf = regs(m, clk, 'lfsr', LFSR_BITS), bo = regs(m, clk, 'bo', 10), slot = regs(m, clk, 'slot', 11);
    const bk = m.reg(clk, 'back_q');
    const gapS = nm(m.and(gap[8], gap[7]), 'gapok_s');
    m.drive(gapok, nm(gapS, 'gapok'));
    const gi = m.inc(gap), quiet = m.nor(crs, c.act);
    gap.forEach((q, i) => m.setD(q, m.andN([rstn, quiet, m.mux(gapS, gi[i], q)])));
    const fb = m.xnor(lf[9], lf[6]);
    lf.forEach((q, i) => m.setD(q, m.mux(rst, i === 0 ? fb : lf[i - 1], seed[i])));
    const bonzS = m.orN(bo);
    m.drive(bonz, nm(bonzS, 'bonz'));
    m.drive(back, nm(bk, 'back'));
    const wait = m.and(bk, bonzS), wrap = m.andN(slot);
    const enter = nm(m.and(c.jamEnd, m.not(c.att15)), 'enter');
    // the draw: the low min(n, 10) bits, n the collisions counting this one: bit i is kept when att >= i
    const draw = lf.map((q, i) => (i === 0 ? q : m.and(q, geConst(m, c.att, i))));
    const bd = dec(m, bo);
    bo.forEach((q, i) => m.setD(q, m.and(rstn, m.mux(enter, m.mux(m.and(wait, wrap), q, bd[i]), draw[i]))));
    const si = m.inc(slot);
    slot.forEach((q, i) => m.setD(q, m.and(rstn, m.mux(wait, q, si[i]))));
    m.setD(bk, m.and(rstn, m.or(enter, wait)));
    return { bo, gap };
  });

  const sh = m.scope('shift', 'shift register, byte select', () => {
    const s = regs(m, clk, 'sh', 8);
    const dbyte = data.map((d) => m.and(d, valid)), dd = gate(m, m.not(c.eof), dbyte);
    // what is loaded at a byte boundary, by state
    const Lp = s.map((_, i) => m.mux(c.pc7, i === 7 ? c.pc6 : constBit(m, 0x55, i), dbyte[i]));
    const Ld = mux(m, c.eof60, dd, fbyte);
    const Lj = s.map((_, i) => ((JAM >> i) & 1 ? m.not(c.pc3) : m.const(0)));
    const L = s.map((_, i) => m.orN([m.and(c.pre, Lp[i]), m.and(c.dat, Ld[i]), m.and(c.fcs, fbyte[i]), m.and(c.jam, Lj[i])]));
    const shiftSel = m.and(c.tick, m.not(c.bb));
    s.forEach((q, i) => {
      const a = m.mux(c.bb, q, L[i]);
      const b = m.mux(shiftSel, a, i < 7 ? s[i + 1] : m.const(0));
      const cc = m.mux(c.start, b, constBit(m, 0x55, i));
      m.setD(q, m.and(rstn, m.mux(c.colhit, cc, constBit(m, JAM, i))));
    });
    return { s, dd };
  });

  m.scope('crc', 'CRC-32 unit, FCS byte select', () => {
    const [, fv] = m.part(crcUnit(32, CRC32_REFLECTED, 8), [m.bus(sh.dd), c.load, c.start, clk], 'CRC-32', 'crc');
    const f = m.unbus(fv, 32);
    const fci = m.inc(c.fc), i0 = m.and(c.fcs, fci[0]), i1 = m.and(c.fcs, fci[1]);
    for (let k = 0; k < 8; k++) {
      const lo = m.mux(i0, f[k], f[8 + k]), hi = m.mux(i0, f[16 + k], f[24 + k]);
      m.drive(fbyte[k], nm(m.xor(m.mux(i1, lo, hi), c.under), `fbyte_${k}`));
    }
  });

  m.output('ready', c.ready);
  m.output('txd', m.and(sh.s[0], c.act));
  m.output('txen', c.act);
  m.output('restart', c.rs); m.output('drop', c.dr); m.output('sent', c.sn);
  m.outputBus('state', [m.orN([c.pre, c.fcs, back]), m.or(c.dat, c.fcs), m.or(c.jam, back)]);
  m.outputBus('att', c.att);
  m.outputBus('backoff', cs.bo);
  m.outputBus('gap', cs.gap);
  txDef = m.build();
  return txDef;
}
const JAM = 0xaa;

// ---- the receiver ------------------------------------------------------------------------------------------------------

let rxDef: ComponentDef | undefined;

/**
 * Serial in, byte stream out. While crs is high it aligns its four-clock bit to the preamble's edges, samples the third clock
 * of each bit, and looks for the SFD in the last eight bits; then counts bytes, feeds them to the CRC unit, compares the first
 * six with the address (or accepts any group address, or everything with `promisc`) and passes them on four bytes late. When
 * the carrier falls the last data byte leaves with `last`, and err says the frame is to be thrown away: why names the
 * reasons (FCS, runt, too long, not for me, overrun). The consumer must take every byte: there is no way to stall a wire, so a
 * byte offered while ready is 0 is lost and the frame is marked.
 */
export function macRx(): ComponentDef {
  if (rxDef) return rxDef;
  const m = new Rtl({
    id: 'eth_mac_rx', name: 'Ethernet MAC receiver', category: 'sequential', label: 'MAC RX', columnHeight: 60,
    summary: 'Finds the SFD in the bit stream, delivers the frame as bytes without preamble and FCS, checks the FCS and the length, filters by destination address; err at last says the consumer must discard the frame.',
  });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst'), rxd = m.input('rxd'), crs = m.input('crs'), ready = m.input('ready'), promisc = m.input('promisc');
  const addr = m.inputBus('addr', 48);
  const rstn = m.not(rst);
  const nm = (s: Sig, n: string) => m.name(s, n);
  const hunt = m.reg(clk, 'hunt'), body = m.reg(clk, 'body'), rq = m.reg(clk, 'rq');
  const ph = regs(m, clk, 'ph', 2), bt = regs(m, clk, 'bit', 3), sh = regs(m, clk, 'sh', 8);

  const f = m.scope('align', 'bit alignment, SFD hunt', () => {
    const idle = nm(m.nor(hunt, body), 'idle'), nidle = m.not(idle);
    const edge = m.xor(rxd, rq);
    const zero = m.and(m.not(body), m.or(edge, idle));
    const pe = ph.map((q) => m.and(q, m.not(zero)));
    const smp = nm(m.andN([nidle, crs, pe[1], m.not(pe[0])]), 'smp');
    const fall = nm(m.and(nidle, m.not(crs)), 'fall');
    const nsh = sh.map((_, i) => (i === 7 ? rxd : sh[i + 1]));
    const sfd = nm(m.andN([smp, hunt, m.eqConst(nsh, 0xd5)]), 'sfd');
    m.setD(rq, m.and(rstn, rxd));
    m.setD(ph[0], m.and(rstn, m.mux(idle, m.and(m.not(fall), m.not(pe[0])), crs)));
    m.setD(ph[1], m.andN([rstn, nidle, m.not(fall), m.xor(pe[1], pe[0])]));
    m.setD(hunt, m.and(rstn, m.mux(idle, m.and(m.not(fall), m.and(hunt, m.not(sfd))), crs)));
    m.setD(body, m.andN([rstn, nidle, m.not(fall), m.or(body, sfd)]));
    const bi = m.inc(bt), start = m.or(m.and(idle, crs), sfd);
    const bsmp = m.and(smp, body);
    bt.forEach((q, i) => m.setD(q, m.andN([rstn, m.not(start), m.mux(bsmp, q, bi[i])])));
    sh.forEach((q, i) => m.setD(q, m.and(rstn, m.mux(smp, q, nsh[i]))));
    return { smp, fall, sfd, nsh, bsmp, complete: nm(m.and(bsmp, m.andN(bt)), 'complete') };
  });

  const k = m.scope('count', 'byte counter, length checks', () => {
    const rn = regs(m, clk, 'rn', RX_BITS);
    const ri = m.inc(rn), full = m.andN(rn);
    rn.forEach((q, i) => m.setD(q, m.andN([rstn, m.not(f.sfd), m.mux(f.complete, q, m.mux(full, ri[i], q))])));
    const ge5 = nm(geConst(m, rn, 5), 'ge5');
    const long = m.reg(clk, 'long');
    m.setD(long, m.andN([rstn, m.not(f.sfd), m.or(long, m.and(f.complete, geConst(m, rn, MAX_FRAME)))]));
    const lt64 = nm(m.nor(m.or(m.or(rn[6], rn[7]), m.or(rn[8], rn[9])), rn[10]), 'lt64');
    return { rn, ge5, long, lt64 };
  });

  const p = m.scope('pipe', 'four-byte delay, CRC', () => {
    const d = Array.from({ length: 5 }, (_, j) => regs(m, clk, `d${j}_`, 8));
    d.forEach((r, j) => r.forEach((q, i) => m.setD(q, m.mux(f.complete, q, j === 0 ? f.nsh[i] : d[j - 1][i]))));
    const [q] = m.part(crcUnit(32, CRC32_REFLECTED, 8), [m.bus(f.nsh), f.complete, f.sfd, clk], 'CRC-32', 'crc');
    const good = nm(m.eqConst(m.unbus(q, 32), 0xdebb20e3), 'crc_ok');
    return { d4: d[4], good };
  });

  const a = m.scope('filter', 'address filter', () => {
    const rn = k.rn;
    const inAddr = m.and(m.not(m.orN(rn.slice(3))), m.not(m.and(rn[2], rn[1])));
    const ab = addr.reduce<Sig[][]>((acc, s, i) => { if (i % 8 === 0) acc.push([]); acc[acc.length - 1].push(s); return acc; }, []);
    const pick = (bits: Sig[][]): Sig[] => bits[0].map((_, i) => {
      const lo = m.mux(rn[0], bits[0][i], bits[1][i]), mid = m.mux(rn[0], bits[2][i], bits[3][i]), hi = m.mux(rn[0], bits[4][i], bits[5][i]);
      return m.mux(rn[2], m.mux(rn[1], lo, mid), m.mux(rn[1], hi, hi));
    });
    const cmp = m.eq(f.nsh, pick(ab));
    const match = m.reg(clk, 'match'), grp = m.reg(clk, 'grp');
    m.setD(match, m.and(rstn, m.mux(f.sfd, m.mux(m.and(f.complete, inAddr), match, m.and(match, cmp)), m.const(1))));
    m.setD(grp, m.and(rstn, m.mux(f.sfd, m.mux(m.and(f.complete, m.eqConst(rn, 0)), grp, f.nsh[0]), m.const(0))));
    return { accept: nm(m.orN([promisc, grp, match]), 'accept') };
  });

  const o_ = m.scope('out', 'output register, verdict', () => {
    const lost = m.reg(clk, 'lost');
    const emitMid = nm(m.andN([f.complete, k.ge5, m.not(k.long)]), 'emit_mid');
    const emitLast = nm(m.andN([f.fall, body, k.ge5]), 'emit_last');
    m.setD(lost, m.andN([rstn, m.not(f.sfd), m.or(lost, m.and(emitMid, m.not(ready)))]));
    const why = [m.not(p.good), k.lt64, k.long, m.not(a.accept), m.or(lost, m.not(ready))];
    const v = m.reg(clk, 'v_q'), l = m.reg(clk, 'l_q'), e = m.reg(clk, 'e_q'), dr = m.reg(clk, 'drop_q');
    const w = regs(m, clk, 'w', 5), o = regs(m, clk, 'o', 8);
    m.setD(v, m.and(rstn, m.or(emitMid, emitLast)));
    m.setD(l, m.and(rstn, emitLast));
    m.setD(e, m.and(m.and(rstn, emitLast), m.orN(why)));
    w.forEach((q, i) => m.setD(q, m.and(m.and(rstn, emitLast), why[i])));
    o.forEach((q, i) => m.setD(q, m.mux(m.or(emitMid, emitLast), q, p.d4[i])));
    m.setD(dr, m.andN([rstn, f.fall, body, m.not(k.ge5)]));
    return { v, l, e, w, o, dr };
  });
  m.outputBus('data', o_.o);
  m.output('valid', o_.v); m.output('last', o_.l); m.output('err', o_.e); m.outputBus('why', o_.w); m.output('drop', o_.dr);
  m.outputBus('state', [hunt, body]);
  rxDef = m.build();
  return rxDef;
}
// ---- the shared wire ---------------------------------------------------------------------------------------------------

interface WireState { hist: number[][]; clk: number; txd: number; txen: number }
const wires = new Map<string, ComponentDef>();

/**
 * The cable: stations at positions x (in clocks of propagation) along it. Each hears the OR of the others' signals, delayed
 * by the distance; two senders at once superpose into garbage. One box, like chapter 43's LINE: a transmission line is
 * chapter 41's model (phys/line.ts), not a circuit, so this is the part of the book that does not end in transistors.
 * clash is the cable's own view of two drivers on at once.
 */
export function sharedWire(x: readonly number[]): ComponentDef {
  const n = x.length, key = x.join('_');
  const hit = wires.get(key);
  if (hit) return hit;
  const mask = 2 ** n - 1;
  const unpack = (v: number): number[] => Array.from({ length: n }, (_, i) => Math.floor(v / 2 ** i) & 1);
  const pack = (a: number[]): number => a.reduce((v, b, i) => v + b * 2 ** i, 0);
  const d = define({
    id: `eth_wire_${key}`, name: `Shared wire (${n} stations)`, category: 'memory',
    summary: `One cable with ${n} stations at ${x.join(', ')} clocks along it. Each station hears the OR of the others' signals (txd while txen), delayed by the distance, and a carrier (crs) while any other is sending. A station's own signal is not here: it is at its own end of the wire at once. clash is 1 while two drivers are on at the same instant. A transmission line is not a circuit, so this one box does not open into transistors.`,
    ports: [bus('txd', n, 'in'), bus('txen', n, 'in'), bit('clk', 'in', 'bottom', true), bus('rxd', n, 'out'), bus('crs', n, 'out'), bit('clash', 'out')],
    symbol: { kind: 'box', label: 'WIRE' },
    behavior: {
      delay: 1,
      seq: { clk: 'clk', comb: [] },
      init: (): WireState => ({ hist: wireHistory(x), clk: 0, txd: 0, txen: 0 }),
      eval: ([txd, txen, clk], st) => {
        const s = st as WireState;
        const k = clk < 0 ? 2 : clk;
        if (k !== 1) { s.txd = txd < 0 ? 0 : txd & mask; s.txen = txen < 0 ? 0 : txen & mask; }
        if (s.clk === 0 && k === 1) wirePush(s.hist, unpack(s.txd), unpack(s.txen));
        s.clk = k;
        const o = wireOutputs(x, s.hist);
        return [pack(o.rxd), pack(o.crs), o.clash];
      },
      carry: (prev) => prev,
    },
  });
  wires.set(key, d);
  return d;
}

