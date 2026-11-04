// Chapter 50's NIC: the gates (lib/nic.ts) against the golden model (comm/nic.ts), every output after every clock, on a bench with a
// RAM that makes the master wait; then what the model does with the rings, the bytes on the line and the bad frames.

import { describe, expect, it } from 'vitest';
import { crc32, fcsBytes } from '../src/comm/crc';
import { BROADCAST } from '../src/comm/ethframe';
import { NIC_REG, OWN, ST_BAD, ST_MISS, ST_RXI, ST_TXI, TX_DROPPED } from '../src/comm/nic';
import { stats } from '../src/sim/stats';
import { nic } from '../src/lib/nic';
import { bench, decodeLine, frameFor, RegScript, serialLine, type Bench, type RegOp } from './nickit';
import { dmaRx, dmaTx } from '../src/widgets/net';
import { tick } from './yieldtick';

const MAC = [0x02, 0x00, 0x00, 0x00, 0x00, 0x0a], PEER = [0x02, 0x00, 0x00, 0x00, 0x00, 0x0b];
const RXR = 0x1000, TXR = 0x1040, RXB = 0x2000, TXB = 0x3000;
const macl = MAC[0] | (MAC[1] << 8) | (MAC[2] << 16) | (MAC[3] << 24), mach = MAC[4] | (MAC[5] << 8);
const w = (addr: number, data: number, gap = 0): RegOp => ({ w: true, addr, data, gap });
const r = (addr: number, gap = 0): RegOp => ({ w: false, addr, gap });
const SETUP: RegOp[] = [w(NIC_REG.RXBASE, RXR), w(NIC_REG.TXBASE, TXR), w(NIC_REG.MACL, macl >>> 0), w(NIC_REG.MACH, mach), w(NIC_REG.IE, 3), w(NIC_REG.CTRL, 1)];

/** Descriptors for 8 buffers in each ring: receive ones owned by the NIC, transmit ones owned by the software. */
function rings(b: Bench): void {
  for (let i = 0; i < 8; i++) {
    b.ram.ram[(RXR + 8 * i) >>> 2] = RXB + 0x600 * i; b.ram.ram[(RXR + 8 * i + 4) >>> 2] = OWN;
    b.ram.ram[(TXR + 8 * i) >>> 2] = TXB + 0x600 * i; b.ram.ram[(TXR + 8 * i + 4) >>> 2] = 0;
  }
}

function run(b: Bench, script: RegScript | null, line: { rxd: number[]; crs: number[] } | null, clocks: number, compare = true): void {
  for (let c = 0; c < clocks; c++) b.clock(script, line?.rxd[c] ?? 0, line?.crs[c] ?? 0, compare);
}

describe('NIC: the gates against the model, every output every clock', () => {
  it('registers, a transmitted frame, a received frame, a bad frame, with a slow RAM', async () => {
    const b = bench(2);
    rings(b);
    const out = frameFor(PEER, MAC, 0x0800, Array.from({ length: 50 }, (_, i) => (i * 5 + 1) & 255)); // 64 bytes
    b.ram.setBytes(TXB, out);
    b.ram.ram[(TXR + 4) >>> 2] = (OWN | out.length) >>> 0;
    const good = frameFor(MAC, PEER, 0x0800, Array.from({ length: 77 }, (_, i) => (i * 3 + 7) & 255));
    const bad = frameFor(MAC, PEER, 0x0800, Array.from({ length: 30 }, (_, i) => i));
    const l1 = serialLine(good, 600), l2 = serialLine(bad, 40, 60, 120), l3 = serialLine(good, 40);
    const cat = (...ls: { rxd: number[]; crs: number[] }[]) => ({ rxd: ls.flatMap((l) => l.rxd), crs: ls.flatMap((l) => l.crs) });
    const line = cat(l1, l2, l3);
    const script = new RegScript([...SETUP, w(NIC_REG.KICK, 1, 20), r(NIC_REG.STATUS, 3000), r(NIC_REG.STATUS, 9000), r(NIC_REG.STATUS, 6000), r(7 * 4, 3000), w(NIC_REG.STATUS, 15), r(NIC_REG.STATUS), r(NIC_REG.MACL), r(NIC_REG.RXBASE)]);
    const total = line.rxd.length + 26000;
    for (let c = 0; c < total; c++) {
      b.clock(script, line.rxd[c] ?? 0, line.crs[c] ?? 0, true);
      if (c % 3000 === 0) await tick();
    }
    expect(script.done).toBe(true);
    // register 7 read at that point: receive head in bits 2:0, transmit head in 5:3
    expect(script.reads[3] & 63).toBe(2 | (1 << 3));
    // the frame the NIC sent decodes, with a good FCS, to what the software put in the buffer (padding is not needed at 64 bytes)
    const sent = decodeLine(b.txd, b.txen);
    expect(sent.length).toBe(1);
    expect(sent[0].err).toBe(0);
    expect(sent[0].bytes).toEqual(out);
    // the transmit descriptor came back to the software, not dropped
    expect(b.ram.ram[(TXR + 4) >>> 2] >>> 0).toBe(out.length);
    // two good frames were stored whole; the corrupted one left no trace in the descriptors
    expect(b.ram.bytes(RXB, good.length)).toEqual(good);
    expect(b.ram.ram[(RXR + 4) >>> 2] >>> 0).toBe(good.length);
    expect(b.ram.bytes(RXB + 0x600, good.length)).toEqual(good);
    expect(b.ram.ram[(RXR + 12) >>> 2] >>> 0).toBe(good.length);
    expect(b.ram.ram[(RXR + 20) >>> 2] >>> 0).toBe(OWN);
    expect(script.reads[2] & 15).toBe(ST_RXI | ST_TXI | ST_BAD);
    expect(script.reads[4]).toBe(0); // written back as ones: cleared
    expect(script.reads[5] >>> 0).toBe(macl >>> 0);
    expect(script.reads[6]).toBe(RXR);
    expect(b.model.sRx).toBe(0);
    void ST_MISS; void TX_DROPPED;
  }, 300000);
});

describe('NIC model: descriptors, bad frames, misses', () => {
  const setup = (maxWait = 0) => {
    const b = bench(maxWait, 8192, false);
    rings(b);
    run(b, new RegScript(SETUP), null, 200, false);
    return b;
  };
  const feed = (b: Bench, body: number[], flip = -1) => { const l = serialLine(body, 30, 300, flip); run(b, null, l, l.rxd.length + 200, false); };

  it('a good frame is in the buffer with its length, the descriptor handed back, head moved', () => {
    const b = setup();
    const f = frameFor(MAC, PEER, 0x0806, Array.from({ length: 100 }, (_, i) => i ^ 0x5a));
    feed(b, f);
    expect(b.ram.bytes(RXB, f.length)).toEqual(f);
    expect(b.ram.ram[(RXR + 4) >>> 2]).toBe(f.length);
    expect(b.model.rxhead).toBe(1);
    expect(b.model.sRx).toBe(1);
    expect(b.model.irq).toBe(1);
  });
  it('every length from 60 to 66 and 1514: the last partial word is written with the right strobes', () => {
    for (const n of [60, 61, 62, 63, 64, 65, 66, 1514]) {
      const b = setup();
      const f = frameFor(MAC, PEER, 0x0800, Array.from({ length: Math.max(0, n - 14) }, (_, i) => (i * 11 + n) & 255));
      b.ram.setBytes(RXB + f.length, [0xee, 0xee, 0xee, 0xee, 0xee]);
      feed(b, f);
      expect(b.ram.bytes(RXB, f.length), `length ${f.length}`).toEqual(f);
      expect(b.ram.bytes(RXB + f.length, 5), 'bytes past the end are untouched').toEqual([0xee, 0xee, 0xee, 0xee, 0xee]);
      expect(b.ram.ram[(RXR + 4) >>> 2]).toBe(f.length);
    }
  });
  it('a frame whose FCS is wrong leaves the descriptor and the head alone; the next frame overwrites its buffer', () => {
    const b = setup();
    const bad = frameFor(MAC, PEER, 0x0800, Array.from({ length: 60 }, (_, i) => i));
    feed(b, bad, 120);
    expect(b.model.rxhead).toBe(0);
    expect(b.model.sBad).toBe(1);
    expect(b.ram.ram[(RXR + 4) >>> 2] >>> 0).toBe(OWN);
    expect(b.model.sRx).toBe(0);
    const good = frameFor(MAC, PEER, 0x0800, Array.from({ length: 70 }, (_, i) => 255 - i));
    feed(b, good);
    expect(b.ram.bytes(RXB, good.length)).toEqual(good);
    expect(b.model.rxhead).toBe(1);
  });
  it('a frame for another address is dropped; a broadcast is kept', () => {
    const b = setup();
    feed(b, frameFor([2, 0, 0, 0, 0, 0x77], PEER, 0x0800, [1, 2, 3]));
    expect(b.model.rxhead).toBe(0);
    feed(b, frameFor(BROADCAST, PEER, 0x0806, [9, 9, 9]));
    expect(b.model.rxhead).toBe(1);
  });
  it('with no descriptor owned by the NIC the frame is dropped and counted, and the ring is untouched', () => {
    const b = setup();
    for (let i = 0; i < 8; i++) b.ram.ram[(RXR + 8 * i + 4) >>> 2] = 0;
    feed(b, frameFor(MAC, PEER, 0x0800, Array.from({ length: 60 }, (_, i) => i)));
    expect(b.model.sMiss).toBe(1);
    expect(b.model.rxhead).toBe(0);
    expect(b.ram.bytes(RXB, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('frames fill the ring in order and wrap', () => {
    const b = setup();
    for (let k = 0; k < 10; k++) {
      const f = frameFor(MAC, PEER, 0x0800, Array.from({ length: 50 }, (_, i) => (i + k) & 255));
      feed(b, f);
      const slot = k % 8;
      expect(b.ram.bytes(RXB + 0x600 * slot, f.length), `frame ${k}`).toEqual(f);
      b.ram.ram[(RXR + 8 * slot + 4) >>> 2] = OWN; // the software hands the descriptor back
    }
    expect(b.model.rxhead).toBe(2);
  });
  it('transmit: two frames queued, one doorbell, both go out in order and come back; a short frame is padded by the MAC', () => {
    const b = setup();
    const a = frameFor(PEER, MAC, 0x0800, Array.from({ length: 70 }, (_, i) => i)), s = [...PEER, ...MAC, 0x08, 0x06, 1, 2, 3];
    b.ram.setBytes(TXB, a); b.ram.setBytes(TXB + 0x600, s);
    b.ram.ram[(TXR + 4) >>> 2] = (OWN | a.length) >>> 0; b.ram.ram[(TXR + 12) >>> 2] = (OWN | s.length) >>> 0;
    run(b, new RegScript([w(NIC_REG.KICK, 1)]), null, 12000, false);
    const got = decodeLine(b.txd, b.txen);
    expect(got.map((g) => g.err)).toEqual([0, 0]);
    expect(got[0].bytes).toEqual(a);
    expect(got[1].bytes.slice(0, s.length)).toEqual(s);
    expect(got[1].bytes.length).toBe(60);
    expect(b.model.txhead).toBe(2);
    expect(b.ram.ram[(TXR + 4) >>> 2] >>> 0).toBe(a.length);
    expect(b.ram.ram[(TXR + 12) >>> 2] >>> 0).toBe(s.length);
    // the FCS of the first is the CRC-32 of its bytes
    void fcsBytes; void crc32;
  });
});

describe('NIC: bus transactions per frame (the chapter formulas)', () => {
  it('transmit: 3 + ceil(len / 4) reads and one write; receive: two reads and ceil(max(60, len) / 4) + 1 writes', () => {
    for (const len of [42, 50, 61, 64, 100]) {
      const b = bench(0, 8192, false);
      rings(b);
      run(b, new RegScript(SETUP), null, 200, false);
      const n0 = b.ram.log.length;
      const out = frameFor(PEER, MAC, 0x0800, Array.from({ length: Math.max(0, len - 14) }, (_, i) => i)).slice(0, len);
      b.ram.setBytes(TXB, out);
      b.ram.ram[(TXR + 4) >>> 2] = (OWN | len) >>> 0;
      run(b, new RegScript([w(NIC_REG.KICK, 1)]), null, 6000, false);
      const tx = b.ram.log.slice(n0);
      expect({ reads: tx.filter((x) => !x[0]).length, writes: tx.filter((x) => x[0]).length }, `transmit ${len}`).toEqual(dmaTx(len));
      const n1 = b.ram.log.length;
      const l = serialLine(frameFor(MAC, PEER, 0x0800, Array.from({ length: Math.max(0, len - 14) }, (_, i) => i)), 30, 300);
      run(b, null, l, l.rxd.length + 300, false);
      const rx = b.ram.log.slice(n1);
      expect({ reads: rx.filter((x) => !x[0]).length, writes: rx.filter((x) => x[0]).length }, `receive ${len}`).toEqual(dmaRx(len));
    }
  });
});

describe('NIC: cost', () => {
  it('is gates all the way down', () => {
    const s = stats(nic());
    expect(s.nands).toBeGreaterThan(5000);
    expect(s.transistors).toBeGreaterThan(0);
  });
});
