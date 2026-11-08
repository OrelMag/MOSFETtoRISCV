// Reference answers of Act 12's Ethernet levels (campaign/buildcomm.ts), built lazily like the chapters' MACs: a full-duplex MAC (chapter 48's
// transmitter and receiver with the carrier and collision pins tied off) and the learning decision of a four-port switch on station numbers
// (chapter 49's table and flood rule at a size a level can ask for: the model of the real 48-bit hashed table is comm/ethswitch.ts).

import type { ComponentDef } from '../sim/types';
import { rca } from './combinational';
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
  const [ready, txd, txen] = m.part(macTx(), [clk, rst, m.bus(data), valid, last, zero, zero, m.constBus(MAC_SEED, 10)], 'transmitter', 'tx');
  const rx = m.part(macRx(), [clk, rst, rxd, crs, one, one, m.constBus(0, 48)], 'receiver', 'rx');
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

const fwdDefs = new Map<boolean, ComponentDef>();

/**
 * A router's forwarding decision at the size of a level: four routes (prefix, a length of 0 to 4 bytes, a port), written one at a time, and for a header's fields in parallel
 * the answer in the next clock: drop a bad header, send a TTL that has run out up to the slow path, else the longest prefix that matches: no route or port 3 goes up too.
 * Forwarded, the TTL is one lower and the checksum is updated as RFC 1624 says: complement it, add 0xFEFF with the carry brought round, complement it. Chapter 51's fast path does this on a stream, with a trie.
 */
export function fwdPath(shortcut = false): ComponentDef {
  const hit = fwdDefs.get(shortcut);
  if (hit) return hit;
  const m = new Rtl({
    noSplit: true, // the campaign's l_fwd answer: drawn as a learner would build it
    id: shortcut ? 'fwd_path_rfc1141' : 'fwd_path', name: shortcut ? 'Forwarding decision, the older checksum update' : 'Forwarding decision', category: 'sequential', label: 'FORWARD', columnHeight: 40,
    summary: 'Four routes matched at once, the longest prefix wins; a bad header is dropped, a TTL that has run out, no route or the router itself goes to the slow path; forwarded, TTL − 1 and the checksum updated from the old one.',
  });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst');
  const we = m.input('we'), slot = m.inputBus('slot', 2), prefix = m.inputBus('prefix', 32), bytes = m.inputBus('bytes', 3), portIn = m.inputBus('port_in', 2);
  const go = m.input('go'), dst = m.inputBus('dst', 32), ttl = m.inputBus('ttl', 8), check = m.inputBus('check', 16), bad = m.input('bad');
  const rstn = m.not(rst);
  const v: Sig[] = [], key: Sig[][] = [], len: Sig[][] = [], out: Sig[][] = [];
  for (let i = 0; i < 4; i++) {
    const home: [string, string] = [`r${i}`, `route ${i}`];
    v.push(m.reg(clk, `v${i}`, home));
    key.push(Array.from({ length: 32 }, (_, b) => m.reg(clk, `k${i}_${b}`, home)));
    len.push(Array.from({ length: 3 }, (_, b) => m.reg(clk, `l${i}_${b}`, home)));
    out.push(Array.from({ length: 2 }, (_, b) => m.reg(clk, `o${i}_${b}`, home)));
  }
  m.scope('write', 'writing a route', () => {
    for (let i = 0; i < 4; i++) {
      const sel = m.and(we, m.eqConst(slot, i));
      m.setD(v[i], m.and(rstn, m.or(v[i], sel)));
      key[i].forEach((q, b) => m.setD(q, m.mux(sel, q, prefix[b])));
      len[i].forEach((q, b) => m.setD(q, m.mux(sel, q, bytes[b])));
      out[i].forEach((q, b) => m.setD(q, m.mux(sel, q, portIn[b])));
    }
  });
  const look = m.scope('match', 'longest prefix', () => {
    // per route, per length: does it match, and is this its length. The first address byte is the top one
    const at = (i: number, L: number) => {
      const need = Array.from({ length: L }, (_, k) => m.eq(key[i].slice(24 - 8 * k, 32 - 8 * k), dst.slice(24 - 8 * k, 32 - 8 * k)));
      return m.andN([v[i], m.eqConst(len[i], L), ...need]);
    };
    const hit = [0, 1, 2, 3, 4].map((L) => [0, 1, 2, 3].map((i) => at(i, L)));
    const any = hit.map((h) => m.orN(h));
    // the longest length with a hit: 4 first
    const pick: Sig[] = [any[4]];
    for (let L = 3; L >= 0; L--) pick.unshift(m.name(m.and(any[L], m.not(m.orN(any.slice(L + 1)))), `long${L}`));
    const sel = [0, 1, 2, 3].map((i) => m.orN([0, 1, 2, 3, 4].map((L) => m.and(pick[L], hit[L][i]))));
    const port = [0, 1].map((b) => m.orN(sel.map((s, i) => m.and(s, out[i][b]))));
    return { port, found: m.name(m.orN(any), 'found') };
  });
  const dec = m.scope('act', 'what to do', () => {
    const expired = m.name(m.not(m.orN(ttl.slice(1))), 'expired');
    const local = m.name(m.andN(look.port), 'local');
    const up = m.name(m.and(m.not(bad), m.or(expired, m.or(m.not(look.found), local))), 'up');
    const fwd = m.name(m.and(m.not(bad), m.not(up)), 'fwd');
    return { up, fwd };
  });
  const upd = m.scope('update', 'TTL and checksum', () => {
    // TTL − 1: a bit flips when every bit below it is 0
    const t = ttl.map((q, i) => m.name(m.xor(q, m.not(m.orN([m.const(0), ...ttl.slice(0, i)]))), `t${i}`));
    // RFC 1624: ~(~HC + ~m + m'), and for {TTL, protocol} falling by 0x0100, ~m + m' is always 0xFEFF. Adding 0x0100 to HC itself is one case wrong: HC = 0xFEFF gives 0xFFFF, where the sum says 0
    const one = m.const(1), zero = m.const(0), K = Array.from({ length: 16 }, (_, i) => ((0xfeff >> i) & 1 ? one : zero));
    const [sum, cout] = m.part(rca(16), [m.bus(check.map((q) => m.not(q))), m.bus(K), zero], 'add 0xFEFF', 'add');
    const s = m.unbus(sum, 16), carry = m.name(cout, 'round'), sN = m.inc(s);
    if (shortcut) {
      // the older update, for the test that the bench rejects it: 0x0100 added to the field itself, the carry brought round
      const hi = check.slice(8), lo = check.slice(0, 8), c8 = m.andN(hi), hiN = m.inc(hi), loN = m.inc(lo);
      return { t, c: [...lo.map((q, i) => m.mux(c8, q, loN[i])), ...hiN] };
    }
    return { t, c: s.map((q, i) => m.not(m.mux(carry, q, sN[i]))) };
  });
  const ov = m.reg(clk, 'ovalid');
  m.setD(ov, m.and(rstn, go));
  const a = [m.reg(clk, 'act0'), m.reg(clk, 'act1')];
  m.setD(a[0], m.andN([rstn, go, dec.fwd]));
  m.setD(a[1], m.andN([rstn, go, dec.up]));
  const pq = [m.reg(clk, 'port0'), m.reg(clk, 'port1')];
  pq.forEach((q, b) => m.setD(q, m.andN([rstn, go, m.not(bad), m.or(dec.up, look.port[b])])));
  const tq = upd.t.map((d, i) => { const q = m.reg(clk, `ttlq${i}`); m.setD(q, m.andN([rstn, go, d])); return q; });
  const cq = upd.c.map((d, i) => { const q = m.reg(clk, `chkq${i}`); m.setD(q, m.andN([rstn, go, d])); return q; });
  m.output('ovalid', ov); m.outputBus('act', a); m.outputBus('port', pq); m.outputBus('ttl_o', tq); m.outputBus('check_o', cq);
  const def = m.build();
  fwdDefs.set(shortcut, def);
  return def;
}
