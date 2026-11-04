// Reference answers of Act 12's Ethernet levels (campaign/buildcomm.ts), built lazily like the chapters' MACs: a full-duplex MAC (chapter 48's
// transmitter and receiver with the carrier and collision pins tied off) and the learning decision of a four-port switch on station numbers
// (chapter 49's table and flood rule at a size a level can ask for: the model of the real 48-bit hashed table is comm/ethswitch.ts).

import type { ComponentDef } from '../sim/types';
import { macRx, macTx } from './ethernet';
import { Rtl, type Sig } from './rtl';

/** Pins of the MAC level. */
export const MAC_SEED = 0x155;

let macDef: ComponentDef | undefined;

/**
 * A full-duplex MAC: the byte stream (data, valid, last, ready) out as preamble, SFD, frame, pad and FCS on a serial line (txd, txen; a bit
 * every four clocks, least significant bit first), and the line in (rxd, crs) back to the byte stream (rdata, rvalid, rlast, rerr: err on the last
 * byte says the frame is to be thrown away). Carrier sense and collisions are off (a full-duplex link has neither), every address is accepted.
 */
export function ethMacFd(): ComponentDef {
  if (macDef) return macDef;
  const m = new Rtl({
    id: 'eth_mac_fd', name: 'Ethernet MAC (full duplex)', category: 'sequential', label: 'MAC', columnHeight: 40,
    summary: 'Frames out with preamble, SFD, pad and FCS; frames in with the FCS checked (err on the last byte: discard). One serial bit every four clocks each way, no carrier sense or collisions.',
  });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst');
  const data = m.inputBus('data', 8), valid = m.input('valid'), last = m.input('last'), rxd = m.input('rxd'), crs = m.input('crs');
  const zero = m.const(0), one = m.const(1);
  const seed = Array.from({ length: 10 }, (_, i) => ((MAC_SEED >> i) & 1 ? one : zero));
  const [ready, txd, txen] = m.part(macTx(), [clk, rst, m.bus(data), valid, last, zero, zero, m.bus(seed)], 'transmitter', 'tx');
  const rx = m.part(macRx(), [clk, rst, rxd, crs, one, one, m.bus(Array.from({ length: 48 }, () => zero))], 'receiver', 'rx');
  m.output('ready', ready); m.output('txd', txd); m.output('txen', txen);
  // rx outputs: data(8) valid last err why(5) drop state(2)
  m.outputBus('rdata', m.unbus(rx[0], 8)); m.output('rvalid', rx[1]); m.output('rlast', rx[2]); m.output('rerr', rx[3]);
  macDef = m.build();
  return macDef;
}

let swDef: ComponentDef | undefined;

/** Entries in the table of the switch level. */
export const SW_ENTRIES = 4;
/** The station number that means every station. */
export const SW_BROADCAST = 0xff;

/**
 * Four ports and a table of four (station number, port) pairs. When a frame's header has arrived (go for one clock, with the port it came in on, the
 * source and destination station numbers and bad = 1 if the MAC found its FCS bad), mask says in the next clock which outputs get the frame (ovalid
 * is 1 then): none for a bad frame, every port but the input for a broadcast or an unknown destination, the destination's port alone, and nothing at
 * all if that is the port it came in on. A good frame teaches the table where its source is; a full table overwrites in turn.
 */
export function swBrain(): ComponentDef {
  if (swDef) return swDef;
  const m = new Rtl({
    id: 'sw_brain', name: 'Learning switch table', category: 'sequential', label: 'SWITCH', columnHeight: 40,
    summary: 'A four-entry table of (station, port): learns the source of every good frame, looks the destination up, and answers with the set of output ports.',
  });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst');
  const go = m.input('go'), inport = m.inputBus('inport', 2), src = m.inputBus('src', 8), dst = m.inputBus('dst', 8), bad = m.input('bad');
  const rstn = m.not(rst);
  const v: Sig[] = [], k: Sig[][] = [], p: Sig[][] = [];
  for (let i = 0; i < SW_ENTRIES; i++) {
    v.push(m.reg(clk, `v${i}`, [`e${i}`, `entry ${i}`]));
    k.push(Array.from({ length: 8 }, (_, b) => m.reg(clk, `k${i}_${b}`, [`e${i}`, `entry ${i}`])));
    p.push(Array.from({ length: 2 }, (_, b) => m.reg(clk, `p${i}_${b}`, [`e${i}`, `entry ${i}`])));
  }
  const w = [m.reg(clk, 'w0'), m.reg(clk, 'w1')];
  const look = m.scope('look', 'destination lookup', () => {
    const hit = v.map((vi, i) => m.and(vi, m.eq(k[i], dst)));
    const known = m.orN(hit);
    const bc = m.eqConst(dst, SW_BROADCAST);
    const port = [0, 1].map((b) => m.orN(hit.map((h, i) => m.and(h, p[i][b]))));
    const flood = m.name(m.or(bc, m.not(known)), 'flood');
    return { known, port, flood };
  });
  const dec = m.scope('mask', 'output set', () => {
    const inDec = [0, 1, 2, 3].map((j) => m.eqConst(inport, j));
    const outDec = [0, 1, 2, 3].map((j) => m.eqConst(look.port, j));
    const mask = [0, 1, 2, 3].map((j) => m.and(m.not(bad), m.mux(look.flood, m.and(outDec[j], m.not(inDec[j])), m.not(inDec[j]))));
    return { mask };
  });
  const ov = m.reg(clk, 'ovalid');
  const mq = [0, 1, 2, 3].map((j) => m.reg(clk, `mask${j}`));
  m.setD(ov, m.and(rstn, go));
  mq.forEach((q, j) => m.setD(q, m.and(rstn, m.and(go, dec.mask[j]))));
  m.scope('learn', 'learning', () => {
    const act = m.andN([go, m.not(bad), m.not(m.eqConst(src, SW_BROADCAST))]);
    const same = v.map((vi, i) => m.and(vi, m.eq(k[i], src)));
    const have = m.orN(same);
    const ins = m.and(act, m.not(have));
    const wi = m.inc(w);
    w.forEach((q, b) => m.setD(q, m.and(rstn, m.mux(ins, q, wi[b]))));
    for (let i = 0; i < SW_ENTRIES; i++) {
      const sel = m.and(ins, m.eqConst(w, i)), upd = m.or(sel, m.and(act, same[i]));
      m.setD(v[i], m.and(rstn, m.or(v[i], sel)));
      k[i].forEach((q, b) => m.setD(q, m.mux(sel, q, src[b])));
      p[i].forEach((q, b) => m.setD(q, m.mux(upd, q, inport[b])));
    }
  });
  m.outputBus('mask', mq); m.output('ovalid', ov);
  swDef = m.build();
  return swDef;
}
