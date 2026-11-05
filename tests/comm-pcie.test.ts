// PCIe's golden model against independent statements of the formats, and the link's behaviour end to end.
import { describe, expect, it } from 'vitest';
import { crc32 as zcrc32 } from 'node:zlib';
import { K_COM, K_EDB, K_END, K_PAD, K_SDP, K_STP, TS1_ID, TS2_ID, TS_LEN, tsSymbol, COMPLETER_ID, creditOk, CRC32_RESIDUE, dataCredits, dlWrap, DL_UP, dllpCrc, dllpBody, dllpSymbols, DLLP_ACK, DLLP_RESIDUE, fcWord, LINK_IN0, LT_L0, parseTlp, PcieLink, tlpBytes, type LinkIn } from '../src/comm/pcie';
import { fcsBytes, stepBits } from '../src/comm/crc';
import { isKCode, nameOf } from '../src/comm/linecode';

/** cocotbext-pcie's dllp.py, as written there (MIT, Alex Forencich; read 2026-11-05): LSB first, poly 0xD008, init 0xFFFF. */
function cocotbCrc16(data: number[]): number {
  let crc = 0xffff;
  for (const b of data) { crc ^= b; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >> 1) ^ 0xd008 : crc >> 1; }
  return crc;
}
const run = (l: PcieLink, n: number, i: Partial<LinkIn> = {}) => { for (let k = 0; k < n; k++) l.step({ ...LINK_IN0, ...i }); };
function cmd(l: PcieLink, c: Partial<LinkIn>): void {
  let n = 0;
  while (l.ra.st !== 0 && n++ < 20000) l.step(LINK_IN0);
  l.step({ ...LINK_IN0, go: 1, ...c });
}
const settle = (l: PcieLink, n = 800) => run(l, n);

describe('formats', () => {
  it('DLLP CRC-16 equals cocotbext-pcie: complemented, low byte first', () => {
    for (const b of [[0, 0, 0, 0], [0x40, 0x01, 0x00, 0x10], [0x10, 0, 0x0f, 0xff], [0x80, 0x3f, 0xc0, 0x55]]) {
      expect(dllpCrc(b)).toBe(~cocotbCrc16(b) & 0xffff);
    }
    const s = dllpSymbols(DLLP_ACK, 5), body = dllpBody(DLLP_ACK, 5), c = ~cocotbCrc16(body) & 0xffff;
    expect(s.map((x) => x.d).slice(1, 7)).toEqual([...body, c & 255, c >> 8]);
  });
  it('the DLLP residue is a constant, whatever the bytes', () => {
    for (const b of [[1, 2, 3, 4], [255, 0, 255, 0], [0x10, 0, 0, 7]]) {
      const c = dllpCrc(b); let q = 0xffff;
      for (const x of [...b, c & 255, c >> 8]) q = stepBits(q, x, 8, 0xd008, 16);
      expect(q).toBe(DLLP_RESIDUE);
    }
  });
  it('InitFC / UpdateFC fields sit where cocotbext-pcie packs them (hdr at bit 14, data at bit 0)', () => {
    expect(fcWord(4, 16)).toBe((4 << 14) | 16);
    expect(dllpBody(0x40, fcWord(4, 16))).toEqual([0x40, 0x01, 0x00, 0x10]);
  });
  it('dlWrap computes the Ethernet register (zlib) over 4 reserved bits, the sequence number and the TLP; not held to a real PCIe trace', () => {
    const tlp = tlpBytes({ kind: 'MRd', len: 1, tag: 3, addr: 0x40 }), w = dlWrap(0xabc, tlp);
    expect(w.slice(0, 2)).toEqual([0x0a, 0xbc]);
    expect(w.slice(-4)).toEqual(fcsBytes(zcrc32(Uint8Array.from(w.slice(0, -4)))));
    let q = 0xffffffff;
    for (const b of w) q = stepBits(q, b, 8);
    expect(q).toBe(CRC32_RESIDUE);
  });
  it('TLP headers match cocotbext-pcie\'s field positions', () => {
    const wr = tlpBytes({ kind: 'MWr', len: 2, tag: 7, requester: 0x0100, addr: 0x12345678, data: [1, 2, 3, 4, 5, 6, 7, 8] });
    const dw = (i: number) => ((wr[i] << 24) | (wr[i + 1] << 16) | (wr[i + 2] << 8) | wr[i + 3]) >>> 0;
    // dw0: fmt at 29, type at 24, length at 0
    expect(dw(0) >>> 29).toBe(2); expect((dw(0) >>> 24) & 31).toBe(0); expect(dw(0) & 0x3ff).toBe(2);
    // dw1: first BE at 0, last BE at 4, tag at 8, requester at 16
    expect(dw(4) & 15).toBe(15); expect((dw(4) >>> 4) & 15).toBe(15); expect((dw(4) >>> 8) & 255).toBe(7); expect(dw(4) >>> 16).toBe(0x0100);
    expect(dw(8)).toBe(0x12345678 & 0xfffffffc);
    const cp = tlpBytes({ kind: 'CplD', len: 1, tag: 9, requester: 0x0100, completer: 0x0200, addr: 0x44, data: [9, 9, 9, 9] });
    const cw = (i: number) => ((cp[i] << 24) | (cp[i + 1] << 16) | (cp[i + 2] << 8) | cp[i + 3]) >>> 0;
    expect(cw(0) >>> 29).toBe(2); expect((cw(0) >>> 24) & 31).toBe(0x0a);
    expect(cw(4) >>> 16).toBe(0x0200); expect(cw(4) & 0xfff).toBe(4);
    expect(cw(8) >>> 16).toBe(0x0100); expect((cw(8) >>> 8) & 255).toBe(9); expect(cw(8) & 0x7f).toBe(0x44);
    const f = parseTlp(wr);
    expect(f).toMatchObject({ kind: 'MWr', len: 2, tag: 7, requester: 0x0100, addr: 0x12345678, firstBe: 15, lastBe: 15 });
  });
  it('the framing symbols are the K codes the text names, and 8b/10b carries them', () => {
    expect([nameOf(K_STP, true), nameOf(K_SDP, true), nameOf(K_END, true), nameOf(K_EDB, true), nameOf(K_COM, true), nameOf(K_PAD, true)]).toEqual(['K27.7', 'K28.2', 'K29.7', 'K30.7', 'K28.5', 'K23.7']);
    for (const k of [K_STP, K_SDP, K_END, K_EDB, K_COM, K_PAD]) expect(isKCode(k)).toBe(true);
    expect(nameOf(TS1_ID, false)).toBe('D10.2'); expect(nameOf(TS2_ID, false)).toBe('D5.2');
    expect(tsSymbol(0, false)).toEqual({ d: K_COM, k: 1 });
    expect(Array.from({ length: TS_LEN }, (_, i) => tsSymbol(i, true).d).slice(6)).toEqual(Array(10).fill(TS2_ID));
  });
  it('the credit gate: modular, and half the field is the farthest ahead the limit can be', () => {
    expect(creditOk(4, 0, 4, 8)).toBe(true);
    expect(creditOk(4, 0, 5, 8)).toBe(false);
    expect(creditOk(2, 254, 4, 8)).toBe(true);   // the limit has wrapped
    expect(creditOk(2, 254, 5, 8)).toBe(false);
    expect(dataCredits(1)).toBe(1); expect(dataCredits(4)).toBe(1); expect(dataCredits(5)).toBe(2); expect(dataCredits(16)).toBe(4);
  });
});

describe('the link, on the model', () => {
  it('trains, and initializes flow control at both ends', () => {
    const l = new PcieLink();
    const n = l.bringUp();
    expect(l.a.lt).toBe(LT_L0); expect(l.b.lt).toBe(LT_L0);
    expect(l.a.dl).toBe(DL_UP); expect(l.b.dl).toBe(DL_UP);
    expect(n).toBeLessThan(3000);
    expect(l.a.phLim).toBe(4); expect(l.a.pdLim).toBe(16); expect(l.a.nphLim).toBe(4);
  });
  it('a write lands in the memory, a read comes back, tags and all', () => {
    const l = new PcieLink(); l.bringUp();
    cmd(l, { wr: 1, addr: 5, len: 2, seed: 0x30 });
    settle(l);
    expect([...l.eb.ram.slice(20, 28)]).toEqual([0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37]);
    cmd(l, { wr: 0, addr: 5, len: 2 });
    const got: number[] = [];
    for (let k = 0; k < 800; k++) { const w = l.out(LINK_IN0); if (w.rd_valid) got.push(w.rd_data); l.step(LINK_IN0); }
    expect(got).toEqual([0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37]);
    expect(l.ra.rtag).toBe(1);
    expect(COMPLETER_ID).toBe(0x0100);
    expect(l.a.ackd).toBe((l.a.nextSeq - 1) & 0xfff);
  });
  it('a flipped bit in a TLP: Nak, replay, the data still right and delivered once', () => {
    const l = new PcieLink(); l.bringUp();
    cmd(l, { wr: 1, addr: 8, len: 4, seed: 1 });
    // find a data symbol going out, flip it
    while (!(l.a.kind === 1 && l.a.pos === 3)) l.step(LINK_IN0);
    const seqBefore = l.b.nextRcv;
    l.step({ ...LINK_IN0, flip_ab: 1 });
    let sawNak = 0, sawReplay = 0;
    for (let k = 0; k < 400; k++) { if (l.b.nakReq) sawNak = 1; if (l.a.replay) sawReplay = 1; l.step(LINK_IN0); }
    expect(sawNak).toBe(1); expect(sawReplay).toBe(1);
    expect(l.b.nextRcv).toBe((seqBefore + 1) & 0xfff);
    expect([...l.eb.ram.slice(32, 48)]).toEqual(Array.from({ length: 16 }, (_, i) => 1 + i));
    expect(l.a.ackd).toBe(seqBefore);
  });
  it('credits run out and the requester waits; the completer\'s returns free it', () => {
    const l = new PcieLink(); l.bringUp();
    const limit = l.a.phLim;
    for (let n = 0; n < limit + 1; n++) cmd(l, { wr: 1, addr: n, len: 1, seed: n });
    settle(l, 2500);
    expect(l.a.phLim).toBeGreaterThan(limit);
    expect(l.ra.st).toBe(0);
    expect(l.eb.ram[limit * 4]).toBe(limit);
  });
  it('a lost Ack: the replay timer resends, the receiver answers the duplicate with an Ack', () => {
    const l = new PcieLink(); l.bringUp();
    cmd(l, { wr: 1, addr: 2, len: 1, seed: 9 });
    let flipped = 0;
    for (let k = 0; k < 2000; k++) {
      const hit = l.b.kind === 2 && l.b.pos === 3 && l.b.dt === DLLP_ACK;
      l.step({ ...LINK_IN0, flip_ba: hit && !flipped ? 1 : 0 });
      if (hit) flipped = 1;
    }
    expect(flipped).toBe(1);
    expect(l.a.ackd).toBe((l.a.nextSeq - 1) & 0xfff);
    expect(l.b.nextRcv).toBe(l.a.nextSeq);
    expect(l.eb.ram[8]).toBe(9);
  });
  it('REPLAY_NUM rolls over after four replays with no progress, and the link goes through Recovery', () => {
    const l = new PcieLink(); l.bringUp();
    cmd(l, { wr: 1, addr: 3, len: 1, seed: 7 });
    let rec = 0, sawRoll = 0;
    // every symbol from a to b corrupted until it has rolled
    for (let k = 0; k < 6000 && !rec; k++) {
      l.step({ ...LINK_IN0, flip_ab: 1 });
      if (l.a.wantRec) sawRoll = 1;
      if (l.a.lt === 5) rec = 1;
    }
    expect(sawRoll).toBe(1); expect(rec).toBe(1);
    run(l, 3000);
    expect(l.a.lt).toBe(LT_L0); expect(l.b.lt).toBe(LT_L0);
    expect(l.eb.ram[12]).toBe(7);
  });
  it('sequence numbers wrap past 0xfff cleanly', () => {
    const l = new PcieLink(); l.bringUp();
    l.a.nextSeq = 0xffe; l.a.ackd = 0xffd; l.b.nextRcv = 0xffe;
    for (let n = 0; n < 4; n++) cmd(l, { wr: 1, addr: 20 + n, len: 1, seed: 40 + n });
    settle(l, 1500);
    expect(l.a.nextSeq).toBe(2); expect(l.a.ackd).toBe(1); expect(l.b.nextRcv).toBe(2);
    expect(l.eb.ram[(20 + 3) * 4]).toBe(43);
  });
});
