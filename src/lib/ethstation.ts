// Chapter 48's station and segment: the frame source and receive buffer (lib/bigmem.ts RAMs behind the pointers of the buffer
// policy), a station that wraps the two MACs with the carrier / collision glue and is hand-placed so that it reads at fit, and
// a segment of four stations on one shared wire. comm/mac.ts's Station and Segment are the models the tests compare them with.

import { LFSR_BITS, RX_BITS, SRC_BITS } from '../comm/mac';
import { instPort, orientGeom, symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { bigRam } from './bigmem';
import { decoder } from './combinational';
import { define, merger, ones, splitter } from './define';
import { ETH_SEG, ETH_SEG_POSITIONS, macRx, macTx, sharedWire } from './ethernet';
import { AND, NOT, OR } from './gates';
import { Rtl, type Sig } from './rtl';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
// the segment's drawing (ethernet.ts ETH_SEG): a station's bus-tap pins on its bottom to the cable, its counters on top
const top = (name: string, width: number): PortDef => ({ name, width, dir: 'out', side: 'top' });
const TOP_X = { ev: 3, stat: 9.5, counts: 16, rd: 22.5, cp: 29 };
const regs = (m: Rtl, clk: Sig, name: string, n: number): Sig[] => Array.from({ length: n }, (_, i) => m.reg(clk, `${name}${i}`));

// ---- the frame source and the receive buffer ---------------------------------------------------------------------------

let srcDef: ComponentDef | undefined;

/**
 * Feeds the byte stream from a RAM: the host writes a frame through wa / wd / we at addresses from 0, puts its length on len and
 * pulses go; valid stays up until the last byte has moved, restart (a collision) rewinds to byte 0, sent or drop lets go.
 * `me` gates the host strobes, so that several stations can share one host port.
 */
export function ethSrc(): ComponentDef {
  if (srcDef) return srcDef;
  const m = new Rtl({
    id: 'eth_src', name: 'Ethernet frame source', category: 'memory', label: 'FRAME SOURCE', columnHeight: 60,
    summary: 'A frame buffer (2048 bytes) with a read pointer: the host writes a frame and its length and pulses go; the byte stream (data, valid, last) follows ready, rewinds when the transmitter reports a collision (restart) and finishes on sent or drop.',
  });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst'), me = m.input('me');
  const wa = m.inputBus('wa', SRC_BITS), wd = m.inputBus('wd', 8), we0 = m.input('we'), lenIn = m.inputBus('len', SRC_BITS), go0 = m.input('go');
  const ready = m.input('ready'), restart = m.input('restart'), drop = m.input('drop'), sent = m.input('sent');
  const rstn = m.not(rst);
  const busy = m.reg(clk, 'busy'), tail = m.reg(clk, 'tail'), len = regs(m, clk, 'len', SRC_BITS), rp = regs(m, clk, 'rp', SRC_BITS);
  const we = m.name(m.and(we0, me), 'we_me'), go = m.name(m.and(go0, me), 'go_me');
  const { valid, lastS, data } = m.scope('ctl', 'read pointer, valid, last', () => {
    const valid = m.name(m.and(busy, m.not(tail)), 'valid_s');
    const take = m.and(ready, valid), rp1 = m.inc(rp), lastS = m.eq(rp1, len);
    const goS = m.and(go, m.not(busy));
    m.setD(busy, m.and(rstn, m.or(goS, m.and(busy, m.nor(sent, drop)))));
    len.forEach((q, i) => m.setD(q, m.and(rstn, m.mux(goS, q, lenIn[i]))));
    const hold = m.andN([rstn, m.not(goS), m.not(restart)]);
    rp.forEach((q, i) => m.setD(q, m.and(hold, m.mux(take, q, rp1[i]))));
    m.setD(tail, m.and(hold, m.or(tail, m.and(take, lastS))));
    const addr = rp.map((q, i) => m.mux(we, q, wa[i]));
    const [dout] = m.part(bigRam(SRC_BITS, 8), [m.bus(addr), m.bus(wd), we, clk], 'frame buffer', 'txmem');
    return { valid, lastS: m.name(lastS, 'last_s'), data: m.unbus(dout, 8) };
  });
  m.outputBus('data', data); m.output('valid', valid); m.output('last', lastS); m.output('busy', busy);
  srcDef = m.build();
  return srcDef;
}

let rxbDef: ComponentDef | undefined;

/**
 * The receive side of the buffer policy: every byte the receiver delivers is written at wp; at last, err = 0 moves the commit
 * pointer cp up to wp (the frame is kept, good pulses), err = 1 moves wp back to cp (the frame is gone, bad pulses). Counters of
 * frames kept, thrown away and collisions (restart or drop), 8 bits each in `counts`. hrd (with me) reads the buffer at ra on rd.
 */
export function ethRxBuf(): ComponentDef {
  if (rxbDef) return rxbDef;
  const m = new Rtl({
    id: 'eth_rxbuf', name: 'Ethernet receive buffer', category: 'memory', label: 'RX BUFFER', columnHeight: 60,
    summary: 'A 2048-byte buffer written at a write pointer and a commit pointer that only moves past a frame whose FCS was good: a frame the receiver already passed on but reported bad is thrown away by moving the write pointer back. Counters for frames kept, thrown away and collisions.',
  });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst'), me = m.input('me');
  const rv = m.input('rv'), rl = m.input('rl'), re = m.input('re'), od = m.inputBus('od', 8), restart = m.input('restart'), drop = m.input('drop');
  const ra = m.inputBus('ra', RX_BITS), hrd0 = m.input('hrd');
  const rstn = m.not(rst), hrd = m.name(m.and(hrd0, me), 'hrd_me');
  const wp = regs(m, clk, 'wp', RX_BITS), cp = regs(m, clk, 'cp', RX_BITS);
  const ng = regs(m, clk, 'ngood', 8), nbd = regs(m, clk, 'nbad', 8), nc = regs(m, clk, 'ncol', 8);
  const good = m.name(m.andN([rv, rl, m.not(re)]), 'good'), bad = m.name(m.andN([rv, rl, re]), 'bad');
  const wp1 = m.inc(wp);
  wp.forEach((q, i) => m.setD(q, m.and(rstn, m.mux(rv, q, m.mux(bad, wp1[i], cp[i])))));
  cp.forEach((q, i) => m.setD(q, m.and(rstn, m.mux(good, q, wp1[i]))));
  const count = (r: Sig[], en: Sig) => { const inc = m.inc(r); r.forEach((q, i) => m.setD(q, m.and(rstn, m.mux(en, q, inc[i])))); };
  count(ng, good); count(nbd, bad); count(nc, m.or(restart, drop));
  const rd = m.scope('ram', 'receive RAM', () => {
    const addr = wp.map((q, i) => m.mux(hrd, q, ra[i]));
    const [dout] = m.part(bigRam(RX_BITS, 8), [m.bus(addr), m.bus(od), m.and(rv, m.not(hrd)), clk], 'receive buffer', 'rxmem');
    return m.unbus(dout, 8);
  });
  m.outputBus('wp', wp); m.outputBus('cp', cp); m.outputBus('counts', [...ng, ...nbd, ...nc]); m.outputBus('rd', rd); m.output('good', good); m.output('bad', bad);
  rxbDef = m.build();
  return rxbDef;
}

// ---- a station ---------------------------------------------------------------------------------------------------------

/** Stations on the segment: addresses and LFSR seeds (positions along the cable: ETH_SEG_POSITIONS). */
export const ethStationMac = (i: number): number[] => [0x02, 0, 0, 0, 0, i + 1];
export const ETH_STATION_SEEDS = [0x155, 0x2b7, 0x0c3, 0x1e9];
export const ethMacWord = (a: readonly number[]): number => a.reduce((v, b, j) => v + b * 2 ** (8 * j), 0);

/** The bits of a station's `ev` output: what happened this clock. */
export const ETH_EV = { sent: 0, drop: 1, restart: 2, rxgood: 3, rxbad: 4, rxv: 5, rxl: 6, rxe: 7 } as const;
/** `stat`: transmitter state (3 bits), attempts (4), receiver state (2). */
export const ethStateOf = (stat: number) => ({ tx: stat & 7, att: (stat >> 3) & 15, rx: (stat >> 7) & 3 });
/** `counts`: frames kept, thrown away, collisions: 8 bits each. */
export const ethCountsOf = (c: number) => ({ good: c & 255, bad: Math.floor(c / 256) & 255, col: Math.floor(c / 65536) & 255 });

const stations = new Map<number, ComponentDef>();

/**
 * A MAC transmitter fed from a frame source and a MAC receiver writing a receive buffer, with the carrier and collision glue
 * between them and the wire: carrier = txen or crs, collision = txen and crs (the other stations' carrier heard while sending),
 * and the receiver ignores the carrier while this station sends. Station i has address 02:00:00:00:00:(i+1) and LFSR seed
 * ETH_STATION_SEEDS[i]. Outputs are packed: ev (ETH_EV), stat (ethStateOf), counts (ethCountsOf). me = 0 deafens the host port.
 */
export function ethStation(i = 0): ComponentDef {
  const hit = stations.get(i);
  if (hit) return hit;
  const TX = macTx(), RXM = macRx(), SRC = ethSrc(), RXB = ethRxBuf();
  const MACC = constWord(48, ethMacWord(ethStationMac(i))), SEEDC = constWord(LFSR_BITS, ETH_STATION_SEEDS[i]), ONE = constWord(1, 1);
  const EVM = merger(ones(8)), STM = merger([3, 4, 2]);
  const [gs, gt, gr, gb] = [SRC, TX, RXM, RXB].map((d) => symbolGeom(d));
  const gAnd = symbolGeom(AND), gOr = symbolGeom(OR);
  // two rows: frame source and transmitter above, receiver and receive buffer below; the glue gates between
  const xs = 16, xt = xs + gs.w + 26, xr = xs + gs.w + 14, xb = xr + gr.w + 24;
  const y0 = 4, yr = y0 + Math.max(gs.h, gt.h) + 12;
  const xg = xt + gt.w + 12;
  const W = Math.max(xb + gb.w + 44, xg + 22) + 8, H = Math.max(yr + Math.max(gr.h, gb.h), y0 + gt.h + 30) + 12;
  const gy = y0 + 2;
  const instances: InstanceDef[] = [
    { name: 'src', def: SRC, at: [xs, y0], label: 'frame source' },
    { name: 'tx', def: TX, at: [xt, y0], label: 'MAC TX' },
    { name: 'rx', def: RXM, at: [xr, yr], label: 'MAC RX' },
    { name: 'rxb', def: RXB, at: [xb, yr], label: 'receive buffer' },
    { name: 'macc', def: MACC, at: [xr - 10, yr + gr.h + 6] },
    { name: 'seedc', def: SEEDC, at: [xt - 10, y0 + gt.h + 6] },
    { name: 'one', def: ONE, at: [xr - 10, yr - 7] },
    { name: 'or1', def: OR, at: [xg, gy], label: 'carrier' },
    { name: 'and1', def: AND, at: [xg, gy + gOr.h + 3], label: 'collision' },
    { name: 'not1', def: NOT, at: [xg, gy + gOr.h + gAnd.h + 8] },
    { name: 'and2', def: AND, at: [xg + 6, gy + gOr.h + gAnd.h + 8 + 8], label: 'rx carrier' },
    { name: 'evm', def: EVM, at: [xb + gb.w + 30, yr + 2] },
    { name: 'stm', def: STM, at: [xb + gb.w + 30, yr + 24] },
  ];
  const N = (name: string, ends: string[], tags = true): NetDef => (tags ? { name, ends, tags } : { name, ends });
  const nets: NetDef[] = [
    N('clk', ['clk', 'src.clk', 'tx.clk', 'rx.clk', 'rxb.clk']), N('rst', ['rst', 'src.rst', 'tx.rst', 'rx.rst', 'rxb.rst']), N('me', ['me', 'src.me', 'rxb.me']),
    N('promisc', ['promisc', 'rx.promisc']), N('wa', ['wa', 'src.wa']), N('wd', ['wd', 'src.wd']), N('we', ['we', 'src.we']), N('len', ['len', 'src.len']), N('go', ['go', 'src.go']),
    N('ra', ['ra', 'rxb.ra']), N('hrd', ['hrd', 'rxb.hrd']), N('rxd', ['rxd', 'rx.rxd']),
    N('data', ['src.data', 'tx.data'], false), N('valid', ['src.valid', 'tx.valid'], false), N('last', ['src.last', 'tx.last'], false), N('ready', ['tx.ready', 'src.ready'], false),
    N('restart', ['tx.restart', 'src.restart', 'rxb.restart', 'evm.i2']), N('drop', ['tx.drop', 'src.drop', 'rxb.drop', 'evm.i1']), N('sent', ['tx.sent', 'src.sent', 'evm.i0']),
    N('seed', ['seedc.y', 'tx.seed']), N('addr', ['macc.y', 'rx.addr']), N('one', ['one.y', 'rx.ready']),
    N('txen', ['tx.txen', 'txen', 'or1.a', 'and1.a', 'not1.a']), N('txd', ['tx.txd', 'txd']),
    N('crs', ['crs', 'or1.b', 'and1.b', 'and2.a']), N('carrier', ['or1.y', 'tx.crs']), N('collision', ['and1.y', 'tx.col']), N('nottx', ['not1.y', 'and2.b'], false), N('rxcr', ['and2.y', 'rx.crs']),
    N('rxbyte', ['rx.data', 'rxb.od', 'rxbyte']), N('rxv', ['rx.valid', 'rxb.rv', 'evm.i5']), N('rxl', ['rx.last', 'rxb.rl', 'evm.i6']), N('rxe', ['rx.err', 'rxb.re', 'evm.i7']), N('why', ['rx.why', 'why']),
    N('good', ['rxb.good', 'evm.i3']), N('bad', ['rxb.bad', 'evm.i4']),
    N('busy', ['src.busy', 'busy']), N('rd', ['rxb.rd', 'rd']), N('counts', ['rxb.counts', 'counts']), N('cp', ['rxb.cp', 'cp']), N('wp', ['rxb.wp', 'wp']),
    N('txstate', ['tx.state', 'stm.i0']), N('att', ['tx.att', 'stm.i1']), N('rxstate', ['rx.state', 'stm.i2']), N('backoff', ['tx.backoff', 'backoff']), N('gap', ['tx.gap', 'gap']),
    N('ev', ['evm.out', 'ev']), N('stat', ['stm.out', 'stat']),
  ];
  const ports: PortDef[] = [
    bit('clk', 'in', 'bottom', true), bit('rst', 'in'), bit('me', 'in'), bit('promisc', 'in'), bus('wa', SRC_BITS, 'in'), bus('wd', 8, 'in'), bit('we', 'in'), bus('len', SRC_BITS, 'in'), bit('go', 'in'),
    bus('ra', RX_BITS, 'in'), bit('hrd', 'in'), bit('rxd', 'in', 'bottom'), bit('crs', 'in', 'bottom'),
    bit('txd', 'out', 'bottom'), bit('txen', 'out', 'bottom'), bit('busy', 'out'), top('ev', 8), bus('rxbyte', 8, 'out'), bus('why', 5, 'out'), top('rd', 8), top('counts', 24),
    top('cp', RX_BITS), bus('wp', RX_BITS, 'out'), top('stat', 9), bus('backoff', 10, 'out'), bus('gap', 9, 'out'),
  ];
  const pins: Record<string, [number, number]> = {};
  let yl = 4, yo = 4;
  for (const p of ports) {
    if (p.name === 'clk') pins.clk = [xs + 4, H];
    else if (p.dir === 'in') { pins[p.name] = [0, yl]; yl += 3; } else { pins[p.name] = [W, yo]; yo += 3; }
  }
  const d = define({
    id: `eth_station${i}`, name: `Ethernet station ${i + 1}`, category: 'sequential',
    summary: `A MAC transmitter with a frame source and a MAC receiver with a receive buffer, at address 02:00:00:00:00:0${i + 1}. The host writes a frame and pulses go; frames that arrive with a good FCS for this address (or any, with promisc) are kept in the receive buffer. txd / txen leave for the wire, rxd / crs come from it (what the others send). ev, stat and counts pack the events, states and counters.`,
    ports, symbol: { kind: 'box', label: `STATION ${i + 1}`, w: ETH_SEG.STATION_W, portPos: { ...TOP_X, rxd: ETH_SEG.RXD, crs: ETH_SEG.CRS, txd: ETH_SEG.TXD, txen: ETH_SEG.TXEN, clk: ETH_SEG.CLK } },
    netlist: () => ({ pins, pinDirs: { clk: 'up' }, instances, nets }),
  });
  stations.set(i, d);
  return d;
}

// ---- a segment ---------------------------------------------------------------------------------------------------------

const segs = new Map<number, ComponentDef>();

/**
 * Four stations on one cable (sharedWire), one host port with a station select: sel picks the station whose host strobes
 * (we, go, hrd) are heard; every station has its own ev, stat, counts, rd and cp outputs.
 */
export function ethSegment(n = 4): ComponentDef {
  const hit = segs.get(n);
  if (hit) return hit;
  const x = ETH_SEG_POSITIONS.slice(0, n), W = sharedWire(x), ST = Array.from({ length: n }, (_, i) => ethStation(i));
  const P = ETH_SEG.PITCH, X0 = 46, Y0 = 16;
  const DEC = decoder(2), SPP = splitter(ones(n)), MGB = merger(ones(n));
  // the four buses under the stations: a bar per signal, its taps a station pitch apart, so each station drops straight onto it
  const MG = merger(ones(n), P), SPL = splitter(ones(n), P);
  const gst = symbolGeom(ST[0]), gd = symbolGeom(DEC), gw = symbolGeom(W);
  const stAt = (k: number): [number, number] => [X0 + k * P, Y0];
  const tapX = (off: number) => X0 + off;                         // station 0's pin of that tap
  const yBar = (d: number) => Y0 + gst.h + 6 + 4 * d;
  const yw = yBar(3) + 8;
  const bars: { name: string; def: ComponentDef; rot: 1 | 3; flip?: boolean; off: number; d: number; first: string }[] = [
    { name: 'mgd', def: MG, rot: 3, flip: true, off: ETH_SEG.TXD, d: 0, first: 'i0' }, { name: 'mge', def: MG, rot: 3, flip: true, off: ETH_SEG.TXEN, d: 1, first: 'i0' },
    { name: 'spc', def: SPL, rot: 3, off: ETH_SEG.CRS, d: 2, first: 'o0' }, { name: 'spr', def: SPL, rot: 3, off: ETH_SEG.RXD, d: 3, first: 'o0' },
  ];
  const barInst = bars.map((b): InstanceDef => {
    const g = orientGeom(b.def, b.flip, b.rot).ports[b.first].pos;
    return { name: b.name, def: b.def, at: [tapX(b.off) - g[0], yBar(b.d) - g[1]], flip: b.flip, rot: b.rot };
  });
  const yDec = 46, ySp = yDec + gd.h + 6, XR = X0 + (n - 1) * P + ETH_SEG.STATION_W + 24;
  const instances: InstanceDef[] = [
    ...ST.map((d, i): InstanceDef => ({ name: `st${i}`, def: d, at: stAt(i), label: `station ${i + 1}` })),
    ...barInst,
    { name: 'wire', def: W, at: [X0, yw], label: 'shared wire' },
    { name: 'dec', def: DEC, at: [8, yDec], label: 'station select' }, { name: 'spp', def: SPP, at: [8, ySp] },
    { name: 'mgb', def: MGB, at: [XR, Y0 + 8] },
  ];
  const T = (name: string, ends: string[], tags: NetDef['tags'] = true): NetDef => ({ name, ends, tags });
  const W_ = (name: string, ends: string[]): NetDef => ({ name, ends });
  const nets: NetDef[] = [
    T('clk', ['clk', 'wire.clk', ...ST.map((_, i) => `st${i}.clk`)]), T('rst', ['rst', ...ST.map((_, i) => `st${i}.rst`)]),
    ...['wa', 'wd', 'we', 'len', 'go', 'ra', 'hrd'].map((p) => T(p, [p, ...ST.map((_, i) => `st${i}.${p}`)])),
    W_('sel', ['sel', 'dec.a']), W_('promisc', ['promisc', 'spp.in']),
  ];
  ST.forEach((_, i) => {
    nets.push(T(`me${i}`, [`dec.y${i}`, `st${i}.me`]), T(`promisc${i}`, [`spp.o${i}`, `st${i}.promisc`]), W_(`txd${i}`, [`st${i}.txd`, `mgd.i${i}`]), W_(`txen${i}`, [`st${i}.txen`, `mge.i${i}`]), T(`busy${i}`, [`st${i}.busy`, `mgb.i${i}`]),
      W_(`rxd${i}`, [`spr.o${i}`, `st${i}.rxd`]), W_(`crs${i}`, [`spc.o${i}`, `st${i}.crs`]));
    for (const p of ['ev', 'stat', 'counts', 'rd', 'cp']) nets.push(W_(`${p}${i}`, [`st${i}.${p}`, `${p}${i}`]));
  });
  nets.push(W_('txds', ['mgd.out', 'wire.txd']), T('txens', ['mge.out', 'wire.txen', 'txen'], ['txen']), W_('busys', ['mgb.out', 'busy']), W_('rxds', ['wire.rxd', 'spr.in']), W_('crss', ['wire.crs', 'spc.in']), W_('clash', ['wire.clash', 'clash']));
  const ports: PortDef[] = [
    bit('clk', 'in', 'bottom', true), bit('rst', 'in'), bus('sel', 2, 'in'), bus('wa', SRC_BITS, 'in'), bus('wd', 8, 'in'), bit('we', 'in'), bus('len', SRC_BITS, 'in'), bit('go', 'in'),
    bus('ra', RX_BITS, 'in'), bit('hrd', 'in'), bus('promisc', n, 'in'),
    bus('txen', n, 'out'), bus('busy', n, 'out'), bit('clash', 'out'),
    ...ST.flatMap((_, i): PortDef[] => [bus(`ev${i}`, 8, 'out'), bus(`stat${i}`, 9, 'out'), bus(`counts${i}`, 24, 'out'), bus(`rd${i}`, 8, 'out'), bus(`cp${i}`, RX_BITS, 'out')]),
  ];
  const H = yw + gw.h + 10;
  const pins: Record<string, [number, number]> = {};
  const pinDirs: Record<string, 'up' | 'down'> = { clk: 'up' };
  const decA = instPort(DEC, [8, yDec], undefined, 'a').pos, sppIn = instPort(SPP, [8, ySp], undefined, 'in').pos;
  let yl = 4;
  for (const p of ports) {
    if (p.name === 'clk') pins.clk = [X0 + 4, H];
    else if (p.name === 'sel') pins.sel = [0, decA[1]];
    else if (p.name === 'promisc') pins.promisc = [0, sppIn[1]];
    else if (p.name === 'busy') pins.busy = [XR + 8, instPort(MGB, [XR, Y0 + 8], undefined, 'out').pos[1]];
    else if (p.name === 'clash') pins.clash = [XR + 8, yw + 3];
    else if (p.name === 'txen') pins.txen = [XR + 8, yw - 4];
    else if (p.dir === 'in') { pins[p.name] = [0, yl]; yl += 3; }
  }
  const TOPX: Record<string, number> = TOP_X;
  ST.forEach((_, i) => { for (const p of ['ev', 'stat', 'counts', 'rd', 'cp']) { pins[`${p}${i}`] = [X0 + i * P + TOPX[p], Y0 - 10]; pinDirs[`${p}${i}`] = 'down'; } });
  const d = define({
    id: n === 4 ? 'eth_segment' : `eth_segment${n}`, name: `Ethernet segment (${n} stations)`, category: 'routing',
    summary: `${n} Ethernet stations on one shared cable. The host port reaches one station at a time (sel); every station sends, defers, collides, backs off and receives by itself, in gates.`,
    ports, symbol: { kind: 'box', label: 'SEGMENT' },
    netlist: () => ({ pins, pinDirs, instances, nets }),
  });
  segs.set(n, d);
  return d;
}
