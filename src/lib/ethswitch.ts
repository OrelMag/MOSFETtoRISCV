// Chapter 49's switch in gates: the address table (MAC_TABLE), a port's buffer with its queues (INPUT_BUFFER), the output port
// (an arbiter and the busy / source registers), the crossbar of multiplexers, the table's client port, and SWITCH4 with its four
// ports. Everything is written with lib/rtl.ts (NAND gates, the library's flip-flops, fifo, arbiterN and portMemory in boxes of their
// own); comm/ethswitch.ts is the golden model they are compared with every cycle.
//
// A port is the byte stream of comm/ethframe.ts (data[7:0], valid, last, ready) plus `err` on the last byte of a receive stream
// (the MAC saw a bad FCS). A receive stream is always ready: a wire cannot be stopped, so a frame that finds no free cell is dropped.

import { Arbiter, COUNT_BITS, PORTS, STAMP_BITS, withDefaults, type SwitchOpts } from '../comm/ethswitch';
import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { arbiterN } from './mpdecode';
import { define, merger, ones, splitter } from './define';
import { fifo } from './storage';
import { portMemory } from './portmem';
import { Rtl, type Sig } from './rtl';

void Arbiter;
const cache = new Map<string, ComponentDef>();
const memo = (key: string, make: () => ComponentDef): ComponentDef => { let d = cache.get(key); if (!d) { d = make(); cache.set(key, d); } return d; };

const log2 = (n: number): number => Math.ceil(Math.log2(n));

/** A counter of w bits that adds one at each edge where en is 1. */
function counter(m: Rtl, clk: Sig, en: Sig, name: string, w = COUNT_BITS): Sig[] {
  const q = Array.from({ length: w }, (_, i) => m.reg(clk, `${name}${i}`));
  const up = m.inc(q);
  q.forEach((x, i) => m.setD(x, m.mux(en, x, up[i])));
  return q;
}
/** A register of bits that load d when en is 1. */
function loadReg(m: Rtl, clk: Sig, en: Sig, d: Sig[], name: string): Sig[] {
  const q = d.map((_, i) => m.reg(clk, `${name}${i}`));
  q.forEach((x, i) => m.setD(x, m.mux(en, x, d[i])));
  return q;
}
const muxBus = (m: Rtl, s: Sig, a: Sig[], b: Sig[]): Sig[] => a.map((x, i) => m.mux(s, x, b[i]));
/** 4:1 per bit, select s1 s0 (index = 2·s1 + s0). */
/** n:1 per select bits (LSB first), one bit. */
const muxN = (m: Rtl, sel: Sig[], d: Sig[]): Sig => { let l = d; for (const s of sel) { const n: Sig[] = []; for (let i = 0; i < l.length; i += 2) n.push(i + 1 < l.length ? m.mux(s, l[i], l[i + 1]) : l[i]); l = n; } return l[0]; };
const mux4 = (m: Rtl, s0: Sig, s1: Sig, d: Sig[][]): Sig[] => d[0].map((_, i) => m.mux(s1, m.mux(s0, d[0][i], d[1][i]), m.mux(s0, d[2][i], d[3][i])));
const zeros = (m: Rtl, n: number): Sig[] => Array.from({ length: n }, () => m.const(0));

// ---- the address table -------------------------------------------------------------------------------------------------------

/** Bits of the first stored word: the low half of the key. The second holds the rest of the key, valid, port, stamp. */
const WORD_B = 16 + 1 + 2 + STAMP_BITS;

/**
 * The learning table: 2^t entries hashed in RAM (XOR-fold of the 48-bit address to t bits). One operation per frame, in one cycle: the
 * destination's slot is read (port 0) for the forwarding decision and the source's slot (port 1) for the learn, and the source's
 * entry is then written. An entry is key, valid, port and the tick it was last seen; it is live for 64 ticks. A sweeper visits one slot
 * a tick when no frame needs the table and clears the stale ones, so a stamp never wraps into looking young.
 */
export function macTable(t = 7, tl = 4): ComponentDef {
  if (t < 2 || t > 7) throw new Error('macTable: 2^2 … 2^7 entries');
  return memo(`mactable${t}_${tl}`, () => {
    const m = new Rtl({
      id: `mac_table${t}_${tl}`, name: `MAC table (${2 ** t} entries)`, category: 'memory', label: 'MAC TABLE', boxW: 14,
      summary: `A learning table of ${2 ** t} entries hashed in RAM: the destination address is looked up and the source learned in one cycle. `
        + `A hit sends the frame to one port; a miss or a group address floods every port but the source; a hit on the source's own port filters it. `
        + `Two addresses that hash alike share a slot and the newer evicts the older (counted). Entries age out after 64 ticks of 2^${tl} clocks.`,
      notes: 'The table is two memories of 2^t words: the low 32 bits of the key, and the high 16 bits with valid, port and the age stamp.',
    });
    const clk = m.input('clk', { clock: true }), op = m.input('op'), sport = m.inputBus('sport', 2), dst = m.inputBus('dst', 48), src = m.inputBus('src', 48);
    const tickF = Array.from({ length: STAMP_BITS }, () => m.fwd());
    const sidxF = Array.from({ length: t }, () => m.fwd());
    const pendF = m.fwd('pend');
    const hash = (a: Sig[]): Sig[] => Array.from({ length: t }, (_, i) => {
      const bits = a.filter((_x, j) => j % t === i);
      return bits.reduce((x, y) => m.xor(x, y));
    });
    const sweep = m.name(m.and(m.not(op), pendF), 'sweep');
    const ram = m.scope('ram', 'entries in RAM', () => {
      const hd = m.scope('hash', 'XOR-fold hash', () => ({ hd: hash(dst), hs: hash(src) }));
      const a1 = hd.hs.map((h, i) => m.mux(op, sidxF[i], h));
      const we1F = m.fwd('we1');
      const wdAF = Array.from({ length: 32 }, () => m.fwd()), wdBF = Array.from({ length: WORD_B }, () => m.fwd());
      const [rdA, rdA1] = m.part(portMemory(t, 32, 2), [m.bus(hd.hd), m.bus(a1), m.bus(zeros(m, 32)), m.bus(wdAF), m.bus([m.const(0), we1F]), clk], 'key, low 32 bits', 'ramA');
      const [rdB, rdB1] = m.part(portMemory(t, WORD_B, 2), [m.bus(hd.hd), m.bus(a1), m.bus(zeros(m, WORD_B)), m.bus(wdBF), m.bus([m.const(0), we1F]), clk], 'key, valid, port, stamp', 'ramB');
      return { a0: m.unbus(rdA, 32), a1: m.unbus(rdA1, 32), b0: m.unbus(rdB, WORD_B), b1: m.unbus(rdB1, WORD_B), we1F, wdAF, wdBF };
    });
    const field = (b: Sig[]) => ({ keyHi: b.slice(0, 16), v: b[16], port: b.slice(17, 19), stamp: b.slice(19, 19 + STAMP_BITS) });
    const D = field(ram.b0), S = field(ram.b1);
    /** fresh: (tick − stamp) mod 256 < 64, the top two bits of the difference are 0. */
    const fresh = (stamp: Sig[]): Sig => {
      let borrow = m.const(0), d6 = borrow, d7 = borrow;
      for (let i = 0; i < 8; i++) {
        const a = tickF[i], b = stamp[i], x = m.xor(a, b);
        if (i >= 6) { const d = m.xor(x, borrow); if (i === 6) d6 = d; else d7 = d; }
        if (i < 7) borrow = m.or(m.and(m.not(a), b), m.and(m.not(x), borrow));
      }
      return m.nor(d6, d7);
    };
    const look = m.scope('look', 'lookup and learn', () => {
      const frD = fresh(D.stamp), frS = fresh(S.stamp);
      const keyD = [...ram.a0, ...D.keyHi], keyS = [...ram.a1, ...S.keyHi];
      const hit = m.name(m.and(m.and(D.v, frD), m.eq(keyD, dst)), 'hit');
      const grp = dst[40], sgrp = src[40];
      const flood = m.name(m.or(grp, m.not(hit)), 'flood');
      const same0 = m.eq(D.port, sport);
      const filtered = m.name(m.and(m.not(flood), same0), 'filtered');
      const mask = [0, 1, 2, 3].map((k) => {
        const mine = m.eqConst(sport, k);
        return m.mux(flood, m.and(m.eqConst(D.port, k), m.not(same0)), m.not(mine));
      });
      const liveS = m.and(S.v, frS), sameKey = m.eq(keyS, src);
      const learnable = m.not(sgrp);
      const learned = m.name(m.and(m.and(op, learnable), m.not(m.and(liveS, sameKey))), 'learned');
      const evicted = m.name(m.and(m.and(op, learnable), m.and(liveS, m.not(sameKey))), 'evicted');
      const stale = m.and(S.v, m.not(frS));
      const we1 = m.or(m.and(op, learnable), m.and(sweep, stale));
      m.drive(ram.we1F, we1);
      // write data: the source's entry, or the entry read back with valid cleared
      ram.wdAF.forEach((f, i) => m.drive(f, m.mux(op, ram.a1[i], src[i])));
      const fresh1 = [...src.slice(32, 48), m.const(1), ...sport, ...tickF];
      const back = ram.b1.map((x, i) => (i === 16 ? m.const(0) : x));
      ram.wdBF.forEach((f, i) => m.drive(f, m.mux(op, back[i], fresh1[i])));
      return { mask, learned, evicted, floodEn: m.and(op, flood), filtEn: m.and(op, filtered) };
    });
    m.scope('age', 'tick, sweeper', () => {
      const ps = Array.from({ length: tl }, (_, i) => m.reg(clk, `ps${i}`));
      const up = m.inc(ps);
      ps.forEach((q, i) => m.setD(q, up[i]));
      const pulse = m.name(m.andN(ps), 'tick');
      const tk = tickF.map((f, i) => { const q = m.reg(clk, `tick${i}`); m.drive(f, q); return q; });
      const tu = m.inc(tk);
      tk.forEach((q, i) => m.setD(q, m.mux(pulse, q, tu[i])));
      const pend = m.reg(clk, 'pend');
      m.drive(pendF, pend);
      m.setD(pend, m.or(pulse, m.and(pend, op)));
      const sx = sidxF.map((f, i) => { const q = m.reg(clk, `sidx${i}`); m.drive(f, q); return q; });
      const su = m.inc(sx);
      sx.forEach((q, i) => m.setD(q, m.mux(sweep, q, su[i])));
    });
    const cn = m.scope('count', 'statistics', () => ({
      learned: counter(m, clk, look.learned, 'learned'), evicted: counter(m, clk, look.evicted, 'evicted'),
      flooded: counter(m, clk, look.floodEn, 'flooded'), filtered: counter(m, clk, look.filtEn, 'filtered'),
    }));
    m.outputBus('mask', look.mask);
    m.outputBus('learned', cn.learned); m.outputBus('evicted', cn.evicted); m.outputBus('flooded', cn.flooded); m.outputBus('filtered', cn.filtered);
    return m.build();
  });
}

// ---- a port's buffer and queues ----------------------------------------------------------------------------------------------------

/** The cells' RAM: 2^(cellK + 2) words of 9 bits (data, last), a read and a write port; above 1024 words, banks of 1024. */
function cellRam(m: Rtl, clk: Sig, k: number, waddr: Sig[], wd: Sig[], we: Sig, raddr: Sig[]): Sig[] {
  const bk = Math.min(k, 10), banks = 2 ** (k - bk);
  const outs: Sig[][] = [];
  for (let b = 0; b < banks; b++) {
    const hi = waddr.slice(bk);
    const weB = banks === 1 ? we : m.and(we, m.eqConst(hi, b));
    const [, rd1] = m.part(portMemory(bk, 9, 2), [m.bus(waddr.slice(0, bk)), m.bus(raddr.slice(0, bk)), m.bus(wd), m.bus(zeros(m, 9)), m.bus([weB, m.const(0)]), clk], banks === 1 ? 'cells' : `cells ${b}`, `cells${b}`);
    outs.push(m.unbus(rd1, 9));
  }
  if (banks === 1) return outs[0];
  const sel = raddr.slice(bk);
  let level = outs;
  for (const s of sel) { const nx: Sig[][] = []; for (let i = 0; i < level.length; i += 2) nx.push(muxBus(m, s, level[i], level[i + 1])); level = nx; }
  return level[0];
}

/**
 * One port's input side: the frame is written into one of four cells as it arrives; after the twelfth byte the table is asked once;
 * the cell number joins a queue (one for the port, or one per output) at the last byte (store-and-forward) or at the answer
 * (cut-through); a granted transfer reads the cell a byte at a time. A frame that finds no free cell is dropped and counted.
 */
export function inputBuffer(opts: Partial<SwitchOpts> = {}): ComponentDef {
  const o = withDefaults(opts), K = o.cellK;
  if (K < 5 || K > 11) throw new Error('inputBuffer: cells of 32 … 2048 bytes');
  const S = o.cells, sb = log2(S), id = `eth_in_${K}${S === 4 ? '' : `_${S}`}${o.voq ? 'v' : 'f'}${o.cut ? 'c' : 's'}`;
  return memo(id, () => {
    const m = new Rtl({
      id, name: `Input buffer (${o.voq ? 'virtual output queues' : 'one FIFO'}, ${o.cut ? 'cut-through' : 'store-and-forward'})`, category: 'memory', label: 'INPUT BUFFER', boxW: 14,
      summary: `${S} cells of ${2 ** K} bytes behind a receive stream that is always ready. The frame is written as it arrives; its first 12 bytes are kept to ask the address table, and the answer is an output mask. `
        + `${o.cut ? 'Cut-through: the cell is queued as soon as the table answers and an output may start reading it behind the writer.' : 'Store-and-forward: the cell is queued at the last byte, if the receiver found the FCS good.'} `
        + `${o.voq ? 'One queue of cell numbers per output, so a frame for a busy output does not hold back one for an idle output.' : 'One FIFO of cell numbers: only the oldest frame competes for an output.'} A frame that finds no free cell is dropped and counted.`,
    });
    const clk = m.input('clk', { clock: true });
    const rxData = m.inputBus('rxData', 8), rxValid = m.input('rxValid'), rxLast = m.input('rxLast'), rxErr = m.input('rxErr');
    const lgrant = m.input('lgrant'), tmask = m.inputBus('tmask', 4), outBusy = m.inputBus('outBusy', 4), gntB = m.inputBus('gnt', 4), adv = m.input('adv');
    const fw = (n: number) => Array.from({ length: n }, () => m.fwd());
    const txActive = m.fwd('txActive'), txSlot = fw(sb), freeF = fw(S), commitF = m.fwd('commit'), cmaskF = fw(4), curSlotF = fw(sb);
    const selF = fw(4), selSlotF = fw(sb), gnt = m.fwd('gnt');
    const widxF = fw(K), wslotF = fw(sb), inFrameF = m.fwd('inFrame'), dropF = m.fwd('drop');

    // ---- receive: cell choice, write, header capture, the table request
    const rx = m.scope('rx', 'receive, header capture', () => {
      const inFrame = m.reg(clk, 'inFrame'), drop = m.reg(clk, 'drop');
      const wslot = Array.from({ length: sb }, (_, i) => m.reg(clk, `wslot${i}`)), widx = Array.from({ length: K }, (_, i) => m.reg(clk, `widx${i}`));
      m.drive(inFrameF, inFrame); m.drive(dropF, drop); wslot.forEach((q, i) => m.drive(wslotF[i], q)); widx.forEach((q, i) => m.drive(widxF[i], q));
      const first = freeF.map((f, s) => (s === 0 ? f : m.and(f, m.not(m.orN(freeF.slice(0, s))))));
      const alloc = Array.from({ length: sb }, (_, b) => m.orN(first.filter((_f, s) => (s >> b) & 1)));
      const allocOk = m.name(m.orN(freeF), 'allocOk');
      const start = m.name(m.and(rxValid, m.not(inFrame)), 'start');
      const curDrop = m.name(m.mux(inFrame, m.not(allocOk), drop), 'curDrop');
      const wr = m.name(m.and(rxValid, m.not(curDrop)), 'wr');
      const curSlot = alloc.map((a, i) => m.mux(inFrame, a, wslot[i]));
      curSlot.forEach((s, i) => m.drive(curSlotF[i], s));
      const lastAcc = m.name(m.and(wr, rxLast), 'lastAcc');
      const up = m.inc(widx);
      widx.forEach((q, i) => m.setD(q, m.mux(rxValid, q, m.and(m.not(rxLast), up[i]))));
      wslot.forEach((q, i) => m.setD(q, m.mux(start, q, alloc[i])));
      m.setD(drop, m.mux(rxValid, drop, m.and(m.not(rxLast), curDrop)));
      m.setD(inFrame, m.mux(rxValid, inFrame, m.not(rxLast)));
      // header: byte n of the first twelve goes to the destination (0–5) or the source (6–11) register
      const lo = widx.slice(0, 4);
      const upperZero = K > 4 ? m.not(m.orN(widx.slice(4))) : m.const(1);
      const lt12 = m.and(upperZero, m.not(m.and(lo[3], lo[2])));
      const capture = Array.from({ length: 12 }, (_, n) => loadReg(m, clk, m.and(m.and(wr, lt12), m.eqConst(lo, n)), rxData, `h${n}_`));
      const dstBits: Sig[] = [], srcBits: Sig[] = [];
      for (let i = 0; i < 48; i++) { dstBits.push(capture[5 - Math.floor(i / 8)][i % 8]); srcBits.push(capture[11 - Math.floor(i / 8)][i % 8]); }
      const reqSet = m.and(wr, m.eqConst(widx, 11));
      const req = m.reg(clk, 'reqPending');
      m.setD(req, m.or(reqSet, m.and(req, m.not(lgrant))));
      // store-and-forward keeps the answer until the last byte; cut-through acts on it at once
      let maskReg: Sig[] = [], maskValid: Sig = lgrant;
      if (!o.cut) {
        maskReg = loadReg(m, clk, lgrant, tmask, 'mask');
        maskValid = m.reg(clk, 'maskValid');
        m.setD(maskValid, m.and(m.not(m.and(rxValid, rxLast)), m.or(lgrant, maskValid)));
      }
      const dropEn = m.and(start, m.not(allocOk)), badEn = m.and(lastAcc, rxErr);
      return { wr, lastAcc, curSlot, req, dstBits, srcBits, maskReg, maskValid, widx, dropEn, badEn, start };
    });

    // ---- packet memory
    const word = m.scope('mem', 'cells (RAM)', () => {
      const txIdxF = fw(K);
      const waddr = [...rx.widx, ...rx.curSlot];
      const raddr = [...txIdxF, ...txSlot];
      const w = cellRam(m, clk, K + sb, waddr, [...rxData, rxLast], rx.wr, raddr);
      return { w, txIdxF };
    });

    // ---- cells: which are free, which outputs still owe a copy of each
    const cells = m.scope('cells', 'cell state', () => {
      const commit = m.name(o.cut ? m.and(lgrant, m.orN(tmask)) : m.and(m.and(rx.lastAcc, m.not(rxErr)), m.and(rx.maskValid, m.orN(rx.maskReg))), 'commit');
      const cmask = o.cut ? tmask : rx.maskReg;
      m.drive(commitF, commit); cmask.forEach((c, i) => m.drive(cmaskF[i], c));
      const rem = Array.from({ length: S }, (_, s) => Array.from({ length: 4 }, (_x, j) => m.reg(clk, `rem${s}_${j}`)));
      const free = rem.map((r, s) => m.and(m.and(m.not(m.orN(r)), m.not(m.and(txActive, m.eqConst(txSlot, s)))), m.not(m.and(m.and(inFrameF, m.not(dropF)), m.eqConst(wslotF, s)))));
      free.forEach((f, s) => m.drive(freeF[s], f));
      rem.forEach((r, s) => {
        const here = m.and(commit, m.eqConst(rx.curSlot, s)), granted = m.and(gnt, m.eqConst(selSlotF, s));
        r.forEach((q, j) => m.setD(q, m.mux(here, m.mux(granted, q, m.and(q, m.not(selF[j]))), cmask[j])));
      });
      return { rem, commit, cmask };
    });

    // ---- queues of cell numbers
    const qs = m.scope('queue', o.voq ? 'queues, one per output' : 'queue', () => {
      const n = o.voq ? PORTS : 1;
      const pushes: Sig[] = [], pops: Sig[] = [];
      const heads: Sig[][] = [], empties: Sig[] = [];
      const popF = fw(n);
      for (let j = 0; j < n; j++) {
        const push = o.voq ? m.and(cells.commit, cells.cmask[j]) : cells.commit;
        pushes.push(push);
        const [dout, empty] = m.part(fifo(sb, sb), [push, popF[j], m.bus(rx.curSlot), clk], o.voq ? `to output ${j}` : 'cell numbers', `q${j}`);
        heads.push(m.unbus(dout, sb)); empties.push(empty);
      }
      return { n, heads, empties, popF, pops };
    });

    // ---- transmit: pick an output, read the cell
    const tx = m.scope('tx', 'pick an output, read the cell', () => {
      const idleOuts = outBusy.map((b) => m.not(b));
      let want: Sig[], head: Sig[], remHead: Sig[] | null = null;
      if (o.voq) { want = qs.empties.map((e) => m.not(e)); head = qs.heads[0]; }
      else {
        head = qs.heads[0];
        remHead = [0, 1, 2, 3].map((j) => muxN(m, head, cells.rem.map((r) => r[j])));
        want = remHead.map((r) => m.and(m.not(qs.empties[0]), r));
      }
      const cand = want.map((w, j) => m.and(m.and(w, idleOuts[j]), m.not(txActive)));
      const sel = cand.map((c, j) => (j === 0 ? c : m.and(c, m.not(m.orN(cand.slice(0, j))))));
      sel.forEach((s, j) => m.drive(selF[j], s));
      const selSlot = o.voq ? Array.from({ length: sb }, (_, b) => m.orN(sel.map((s, j) => m.and(s, qs.heads[j][b])))) : head;
      selSlot.forEach((s, b) => m.drive(selSlotF[b], s));
      m.drive(gnt, m.orN(gntB));
      // pops
      if (o.voq) qs.popF.forEach((f, j) => m.drive(f, m.and(gnt, sel[j])));
      else m.drive(qs.popF[0], m.and(gnt, m.not(m.orN(remHead!.map((r, j) => m.and(r, m.not(sel[j])))))));
      // the reader
      const slot = Array.from({ length: sb }, (_, i) => m.reg(clk, `txSlot${i}`)), idx = Array.from({ length: K }, (_, i) => m.reg(clk, `txIdx${i}`));
      const active = m.reg(clk, 'txActive');
      slot.forEach((q, i) => m.drive(txSlot[i], q)); idx.forEach((q, i) => m.drive(word.txIdxF[i], q));
      m.drive(txActive, active);
      const avail = o.cut ? m.or(m.not(m.and(m.and(inFrameF, m.not(dropF)), m.eq(wslotF, slot))), m.not(m.eq(idx, widxF))) : m.const(1);
      const valid = m.name(m.and(active, avail), 'txValid');
      const moved = m.name(m.and(valid, adv), 'moved');
      const last = word.w[8];
      const up = m.inc(idx);
      m.setD(active, m.mux(gnt, m.and(active, m.not(m.and(moved, last))), m.const(1)));
      slot.forEach((q, i) => m.setD(q, m.mux(gnt, q, selSlot[i])));
      idx.forEach((q, i) => m.setD(q, m.and(m.not(gnt), m.mux(moved, q, up[i]))));
      return { valid };
    });
    m.scope('count', 'statistics', () => {
      const drops = counter(m, clk, rx.dropEn, 'drops'), bad = counter(m, clk, rx.badEn, 'bad');
      m.outputBus('drops', drops); m.outputBus('bad', bad);
    });
    void tx; void selSlotF;
    m.output('req', rx.req); m.outputBus('dst', rx.dstBits); m.outputBus('src', rx.srcBits); m.outputBus('sel', selF);
    m.outputBus('txData', word.w.slice(0, 8)); m.output('txLast', word.w[8]); m.output('txValid', tx.valid); m.output('rxReady', m.const(1));
    return m.build();
  });
}

// ---- the output port and the crossbar -----------------------------------------------------------------------------------------------

/** An output port: a round-robin arbiter over the inputs that picked it, the busy flag and which input drives it, a frame counter. */
export function outputPort(): ComponentDef {
  return memo('eth_out', () => {
    const m = new Rtl({
      id: 'eth_out', name: 'Output port', category: 'sequential', label: 'OUTPUT',
      summary: 'Four inputs may ask for this output in a cycle; the round-robin arbiter of chapter 27 grants one. The grant sets busy and records which input drives the output; busy clears on the last byte that moves.',
    });
    const clk = m.input('clk', { clock: true }), r = m.inputBus('r', 4), end = m.input('end');
    const g = m.part(arbiterN(4), [...r, clk], 'who goes', 'arb');
    const busy = m.reg(clk, 'busy'), src = [0, 1].map((i) => m.reg(clk, `src${i}`));
    const any = m.orN(g);
    m.setD(busy, m.or(any, m.and(busy, m.not(end))));
    m.setD(src[0], m.mux(any, src[0], m.or(g[1], g[3])));
    m.setD(src[1], m.mux(any, src[1], m.or(g[2], g[3])));
    const frames = m.scope('count', 'frames sent', () => counter(m, clk, end, 'frames'));
    m.outputBus('g', g); m.output('busy', busy); m.outputBus('src', src); m.outputBus('frames', frames);
    return m.build();
  });
}

/** The crossbar: per output a 4:1 multiplexer of the four inputs' bytes (select: the output's source register), the byte moving back as `adv`. */
export function crossbar(): ComponentDef {
  return memo('eth_xbar', () => {
    const m = new Rtl({
      id: 'eth_xbar', name: 'Crossbar', category: 'routing', label: 'CROSSBAR', boxW: 12,
      summary: 'Four multiplexers of 4:1, one per output, 10 bits wide (data, last, valid) selected by the output\'s source register. A byte is shown only while the output is busy; the output\'s ready goes back through the same selection as `adv` to the input that owns the output.',
    });
    const D = [0, 1, 2, 3].map((i) => m.inputBus(`txData${i}`, 8)), L = [0, 1, 2, 3].map((i) => m.input(`txLast${i}`)), V = [0, 1, 2, 3].map((i) => m.input(`txValid${i}`));
    const S = [0, 1, 2, 3].map((j) => m.inputBus(`src${j}`, 2)), B = [0, 1, 2, 3].map((j) => m.input(`busy${j}`)), R = [0, 1, 2, 3].map((j) => m.input(`ready${j}`));
    const ends: Sig[] = [];
    [0, 1, 2, 3].forEach((j) => m.scope(`o${j}`, `output ${j}`, () => {
      const words = [0, 1, 2, 3].map((i) => [...D[i], L[i], V[i]]);
      const w = mux4(m, S[j][0], S[j][1], words);
      const valid = m.name(m.and(B[j], w[9]), `valid${j}`);
      const data = w.slice(0, 8).map((x) => m.and(x, valid)), last = m.and(w[8], valid);
      m.outputBus(`data${j}`, data); m.output(`last${j}`, last); m.output(`valid${j}`, valid);
      const end = m.and(m.and(valid, R[j]), last);
      m.output(`end${j}`, end); ends.push(end);
    }));
    [0, 1, 2, 3].forEach((i) => m.scope(`a${i}`, `advance of input ${i}`, () => {
      m.output(`adv${i}`, m.orN([0, 1, 2, 3].map((j) => m.and(m.and(B[j], R[j]), m.eqConst(S[j], i)))));
    }));
    return m.build();
  });
}

/** The table's client: a round-robin arbiter over the ports that have a request, and the multiplexers that put the winner's addresses on the table. */
export function tablePort(): ComponentDef {
  return memo('eth_tport', () => {
    const m = new Rtl({
      id: 'eth_tport', name: 'Table port', category: 'routing', label: 'TABLE PORT', boxW: 14,
      summary: 'One lookup a cycle for the whole switch: the ports with a request (twelve bytes in) go through a round-robin arbiter, and the winner\'s destination and source addresses and port number go to the table.',
    });
    const clk = m.input('clk', { clock: true }), req = m.inputBus('req', 4);
    const D = [0, 1, 2, 3].map((i) => m.inputBus(`dst${i}`, 48)), S = [0, 1, 2, 3].map((i) => m.inputBus(`src${i}`, 48));
    const g = m.part(arbiterN(4), [...req, clk], 'who is asked', 'arb');
    const s0 = m.or(g[1], g[3]), s1 = m.or(g[2], g[3]);
    const dst = mux4(m, s0, s1, D), src = mux4(m, s0, s1, S);
    m.outputBus('lgrant', g); m.output('op', m.orN(g)); m.outputBus('dst', dst); m.outputBus('src', src); m.outputBus('sport', [s0, s1]);
    return m.build();
  });
}

// ---- the switch -------------------------------------------------------------------------------------------------------------------------

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const I4 = [0, 1, 2, 3];

/** The four-port switch, hand placed: input buffers on the left, the table's port and the table, the crossbar, the output ports on the right. */
export function ethSwitch(opts: Partial<SwitchOpts> = {}): ComponentDef {
  const o = withDefaults(opts);
  const id = `ethswitch_${o.cellK}${o.cells === 4 ? '' : `_${o.cells}`}${o.voq ? 'v' : 'f'}${o.cut ? 'c' : 's'}_${o.tableK}_${o.tickLog2}`;
  return memo(id, () => {
    const IN = inputBuffer(o), OUT = outputPort(), XB = crossbar(), TP = tablePort(), TB = macTable(o.tableK, o.tickLog2);
    const gi = symbolGeom(IN), go = symbolGeom(OUT), gx = symbolGeom(XB), gt = symbolGeom(TP), gb = symbolGeom(TB);
    const sp4 = splitter(ones(4)), mg4 = merger(ones(4)), gs = symbolGeom(sp4), gm = symbolGeom(mg4);
    const gap = 24, rowH = gi.h + 8;
    const xi = 30, xt = xi + gi.w + gap, xx = xt + Math.max(gt.w, gb.w) + gap, xo = xx + gx.w + gap;
    const y0 = 4, R = xo + go.w + 30;
    const instances: InstanceDef[] = [];
    I4.forEach((i) => instances.push({ name: `in${i}`, def: IN, at: [xi, y0 + i * rowH], label: `Port ${i} input` }));
    instances.push({ name: 'tp', def: TP, at: [xt, y0], label: 'Table port' });
    instances.push({ name: 'tb', def: TB, at: [xt, y0 + gt.h + 10], label: 'MAC table' });
    instances.push({ name: 'xb', def: XB, at: [xx, y0], label: 'Crossbar' });
    const oy = (j: number) => y0 + j * (go.h + 8);
    I4.forEach((j) => instances.push({ name: `out${j}`, def: OUT, at: [xo, oy(j)], label: `Port ${j} output` }));
    // plumbing strip below the tallest column: splitters and mergers between buses and single wires
    const yb = Math.max(y0 + 4 * rowH, y0 + gt.h + 10 + gb.h) + 6;
    const cell = Math.max(gs.h, gm.h) + 4, sx = (k: number) => xt - 4 + k * (gs.w + gm.w + 12);
    let k = 0;
    const place = (name: string, def: ComponentDef, row: number, col: number) => instances.push({ name, def, at: [sx(col), yb + row * cell] });
    I4.forEach((i) => { place(`ss${i}`, sp4, 0, k); place(`rq${i}`, mg4, 1, k); place(`sg${i}`, sp4, 2, k); place(`gm${i}`, mg4, 3, k); k++; });
    place('bz', mg4, 0, k); place('rqt', mg4, 1, k); place('sl', sp4, 2, k);
    const nets: NetDef[] = [];
    const tag = (name: string, ends: string[]) => nets.push({ name, ends, tags: true });
    tag('clk', ['clk', ...I4.flatMap((i) => [`in${i}.clk`, `out${i}.clk`]), 'tp.clk', 'tb.clk']);
    I4.forEach((i) => {
      for (const p of ['rxData', 'rxValid', 'rxLast', 'rxErr']) tag(`${p}${i}`, [`${p}${i}`, `in${i}.${p}`]);
      tag(`rxReady${i}`, [`in${i}.rxReady`, `rxReady${i}`]);
      tag(`txData${i}`, [`xb.data${i}`, `txData${i}`]); tag(`txValid${i}`, [`xb.valid${i}`, `txValid${i}`]); tag(`txLast${i}`, [`xb.last${i}`, `txLast${i}`]);
      tag(`txReady${i}`, [`txReady${i}`, `xb.ready${i}`]);
      tag(`drops${i}`, [`in${i}.drops`, `drops${i}`]); tag(`bad${i}`, [`in${i}.bad`, `bad${i}`]); tag(`frames${i}`, [`out${i}.frames`, `frames${i}`]);
      tag(`d${i}`, [`in${i}.txData`, `xb.txData${i}`]); tag(`l${i}`, [`in${i}.txLast`, `xb.txLast${i}`]); tag(`v${i}`, [`in${i}.txValid`, `xb.txValid${i}`]);
      tag(`adv${i}`, [`xb.adv${i}`, `in${i}.adv`]);
      tag(`src${i}`, [`out${i}.src`, `xb.src${i}`]); tag(`busy${i}`, [`out${i}.busy`, `xb.busy${i}`, `bz.i${i}`]); tag(`end${i}`, [`xb.end${i}`, `out${i}.end`]);
      tag(`sel${i}`, [`in${i}.sel`, `ss${i}.in`]);
      tag(`r${i}`, [`rq${i}.out`, `out${i}.r`]);
      tag(`g${i}`, [`out${i}.g`, `sg${i}.in`]);
      tag(`gnt${i}`, [`gm${i}.out`, `in${i}.gnt`]);
      for (const j of I4) {
        tag(`sel${i}to${j}`, [`ss${i}.o${j}`, `rq${j}.i${i}`]);
        tag(`g${i}for${j}`, [`sg${i}.o${j}`, `gm${j}.i${i}`]);
      }
      tag(`req${i}`, [`in${i}.req`, `rqt.i${i}`]); tag(`dst${i}`, [`in${i}.dst`, `tp.dst${i}`]); tag(`tsrc${i}`, [`in${i}.src`, `tp.src${i}`]);
      tag(`lgrant${i}`, [`sl.o${i}`, `in${i}.lgrant`]);
      tag(`tmask${i}`, ['tb.mask', `in${i}.tmask`]);
      tag(`outBusy${i}`, ['bz.out', `in${i}.outBusy`]);
    });
    tag('reqs', ['rqt.out', 'tp.req']);
    tag('lgrants', ['tp.lgrant', 'sl.in']);
    tag('op', ['tp.op', 'tb.op']); tag('tdst', ['tp.dst', 'tb.dst']); tag('tsrc', ['tp.src', 'tb.src']); tag('sport', ['tp.sport', 'tb.sport']);
    for (const c of ['learned', 'evicted', 'flooded', 'filtered']) tag(c, [`tb.${c}`, c]);
    const ports: PortDef[] = [bit('clk', 'in', 'bottom', true),
      ...I4.flatMap((i) => [bus(`rxData${i}`, 8, 'in'), bit(`rxValid${i}`, 'in'), bit(`rxLast${i}`, 'in'), bit(`rxErr${i}`, 'in'), bit(`txReady${i}`, 'in')]),
      ...I4.flatMap((i) => [bit(`rxReady${i}`, 'out'), bus(`txData${i}`, 8, 'out'), bit(`txValid${i}`, 'out'), bit(`txLast${i}`, 'out'), bus(`drops${i}`, COUNT_BITS, 'out'), bus(`bad${i}`, COUNT_BITS, 'out'), bus(`frames${i}`, COUNT_BITS, 'out')]),
      ...['learned', 'evicted', 'flooded', 'filtered'].map((c) => bus(c, COUNT_BITS, 'out'))];
    const pins: Record<string, [number, number]> = {};
    let yi = 2, yo = 2;
    for (const p of ports) { if (p.dir === 'in') { pins[p.name] = [0, yi]; yi += 3; } else { pins[p.name] = [R, yo]; yo += 3; } }
    return define({
      id, name: `4-port switch (${o.voq ? 'VOQ' : 'FIFO'}, ${o.cut ? 'cut-through' : 'store-and-forward'}, ${2 ** o.tableK}-entry table)`, category: 'routing',
      summary: 'Four ports, each a byte stream in and out. Every input buffers its frames in cells and asks the learning table once a frame; each output has a round-robin arbiter over the inputs that want it, and the crossbar of multiplexers carries the bytes. '
        + `${o.cut ? 'Cut-through: an output starts as soon as the table has answered.' : 'Store-and-forward: a frame is sent after its last byte has arrived.'} ${o.voq ? 'Each input keeps one queue per output.' : 'Each input keeps one FIFO.'}`,
      ports, symbol: { kind: 'box', label: 'SWITCH' },
      netlist: () => ({ pins, instances, nets }),
      notes: 'Open any box to see how it is built. The cells and the table are RAM behaviours (their banks open down to flip-flops); everything else is NAND gates and the library flip-flops.',
    });
  });
}
