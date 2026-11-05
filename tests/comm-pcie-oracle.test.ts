// What lock step cannot see: a bug the gates and the model share. An independent monitor reads the symbols on the lane, written apart from comm/pcie.ts:
// framing by the K codes, zlib's CRC-32 over each TLP, cocotbext-pcie's CRC-16 over each DLLP, TLP fields by fixed offsets; and it holds the protocol's
// promises against a scoreboard: nothing sent past the advertised credits, Acks only for what was sent, every write delivered exactly once and in order.
import { describe, expect, it } from 'vitest';
import { crc32 as zcrc32 } from 'node:zlib';
import { LINK_IN0, PcieLink, type LinkIn } from '../src/comm/pcie';
import { lcg } from './util';

const STP = 0xfb, SDP = 0x5c, END = 0xfd, COM = 0xbc;
function crc16(data: number[]): number {
  let c = 0xffff;
  for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >> 1) ^ 0xd008 : c >> 1; }
  return ~c & 0xffff;
}
interface Pkt { kind: 'tlp'; good: boolean; seq: number; tlp: number[] }
interface Dl { kind: 'dllp'; good: boolean; type: number; word: number }
/** Packets out of a stream of (data, k) symbols, as a bus analyser would read them. */
class Monitor {
  cur: number[] | null = null; mode = ''; pkts: (Pkt | Dl)[] = []; ts = 0;
  feed(d: number, k: number): void {
    if (this.cur === null) {
      if (k && d === STP) { this.cur = []; this.mode = 't'; } else if (k && d === SDP) { this.cur = []; this.mode = 'd'; } else if (k && d === COM) this.ts++;
      return;
    }
    if (!k) { this.cur.push(d); return; }
    const b = this.cur; this.cur = null;
    if (d !== END) { if (this.mode === 't') this.pkts.push({ kind: 'tlp', good: false, seq: -1, tlp: [] }); return; }
    if (this.mode === 't') {
      if (b.length < 6) { this.pkts.push({ kind: 'tlp', good: false, seq: -1, tlp: [] }); return; }
      const body = b.slice(0, -4), fcs = b.slice(-4), z = zcrc32(Uint8Array.from(body));
      const good = fcs[0] === (z & 255) && fcs[1] === ((z >>> 8) & 255) && fcs[2] === ((z >>> 16) & 255) && fcs[3] === (z >>> 24);
      this.pkts.push({ kind: 'tlp', good, seq: ((body[0] & 15) << 8) | body[1], tlp: body.slice(2) });
    } else {
      const good = b.length === 6 && crc16(b.slice(0, 4)) === (b[4] | (b[5] << 8));
      this.pkts.push({ kind: 'dllp', good, type: b[0], word: (b[1] << 16) | (b[2] << 8) | b[3] });
    }
  }
}

interface Cmd { wr: number; addr: number; len: number; seed: number }
function drive(seed: number, flipRate: number, cmds: Cmd[], tail = 4000) {
  const r = lcg(seed), l = new PcieLink(), mAB = new Monitor(), mBA = new Monitor();
  const flipped = { ab: 0, ba: 0 }, quiet = { on: false };
  const step = (c: Partial<LinkIn> = {}) => {
    const noisy = flipRate && !quiet.on, fa = noisy && r(flipRate) === 0 ? 1 : 0, fb = noisy && r(flipRate) === 0 ? 1 : 0;
    flipped.ab += fa; flipped.ba += fb;
    const w = l.out({ ...LINK_IN0, ...c });
    mAB.feed(l.ab[0] & 255, l.ab[0] >> 8); mBA.feed(l.ba[0] & 255, l.ba[0] >> 8);   // what arrives, flips and all
    if (w.rd_valid) got.push(w.rd_data);
    l.step({ ...LINK_IN0, ...c, flip_ab: fa, flip_ba: fb });
  };
  const got: number[] = [];
  let n = 0;
  while (l.a.dl !== 3 || l.b.dl !== 3) { step(); if (++n > 200000) throw new Error('no link'); }
  for (const c of cmds) {
    let g = 0;
    while (l.ra.st !== 0) { step(); if (++g > 200000) throw new Error('stuck'); }
    step({ go: 1, ...c });
  }
  for (let k = 0; k < tail; k++) step();
  quiet.on = true;   // the errors stop: whatever is still unacknowledged gets through
  for (let k = 0; k < 6000; k++) step();
  return { l, mAB, mBA, got };
}

const workload = (seed: number, count: number): Cmd[] => {
  const r = lcg(seed);
  return Array.from({ length: count }, () => ({ wr: r(3) ? 1 : 0, addr: r(200), len: 1 + r(16), seed: r(256) }));
};
const REF = (cmds: Cmd[]) => {
  const ram = new Uint8Array(1024), reads: number[] = [];
  for (const c of cmds) {
    for (let i = 0; i < c.len * 4; i++) {
      const a = ((c.addr << 2) + i) & 1023;
      if (c.wr) ram[a] = (c.seed + i) & 255; else reads.push(ram[a]);
    }
  }
  return { ram, reads };
};

function holdsPromises(m: { mAB: Monitor; mBA: Monitor }, clean: boolean): void {
  let ph = 0, pd = 0, np = 0, phLim = -1, pdLim = -1, npLim = -1, seen = 0;
  const seenSeqs = new Set<number>();
  // walk the two streams' events in file order only per stream: credits were advertised before they were used, so compare totals at the end
  for (const p of m.mBA.pkts) if (p.kind === 'dllp' && p.good) {
    const hi = p.type >> 4;
    if (hi >= 4 && hi <= 0xe && hi !== 7 && hi !== 0xb) {
      const cls = hi & 3, hdr = (p.word >> 14) & 255, data = p.word & 0xfff;
      if (cls === 0) { phLim = Math.max(phLim, hdr); pdLim = Math.max(pdLim, data); } else if (cls === 1) npLim = Math.max(npLim, hdr);
    }
  }
  expect(phLim).toBeGreaterThan(0);
  for (const p of m.mAB.pkts) if (p.kind === 'tlp' && p.good) {
    if (seenSeqs.has(p.seq)) continue;
    seenSeqs.add(p.seq); seen++;
    const first = p.tlp[0], len = p.tlp[3];
    expect([0x40, 0x00]).toContain(first);
    if (first === 0x40) { ph++; pd += (len + 3) >> 2; expect(p.tlp.length).toBe(12 + len * 4); } else { np++; expect(p.tlp.length).toBe(12); }
    expect(ph).toBeLessThanOrEqual(phLim); expect(pd).toBeLessThanOrEqual(pdLim); expect(np).toBeLessThanOrEqual(npLim);
    expect(p.tlp[7]).toBe(len === 1 ? 0x0f : 0xff);
  }
  expect(seen).toBeGreaterThan(0);
  // sequence numbers of new TLPs count up by one from zero
  expect([...seenSeqs].sort((a, b) => a - b)).toEqual(Array.from({ length: seen }, (_, i) => i));
  // Acks never pass what has gone out (as far as the monitor has seen)
  for (const p of m.mBA.pkts) if (p.kind === 'dllp' && p.good && p.type === 0) expect(p.word & 0xfff).toBeLessThan(seen);
  if (clean) for (const s of [...m.mAB.pkts, ...m.mBA.pkts]) expect(s.good).toBe(true);
  // completions are well formed
  for (const p of m.mBA.pkts) if (p.kind === 'tlp' && p.good) {
    expect(p.tlp[0]).toBe(0x4a);
    expect(p.tlp[4]).toBe(1); expect(p.tlp[5]).toBe(0);
    expect(((p.tlp[6] & 15) << 8) | p.tlp[7]).toBe(p.tlp[3] * 4);
    expect(p.tlp.length).toBe(12 + p.tlp[3] * 4);
  }
}

describe('an independent monitor on the lane', () => {
  it('a clean link: every packet good, memory and reads as a plain array computes them', () => {
    const cmds = workload(1, 60), ref = REF(cmds), m = drive(1, 0, cmds);
    holdsPromises(m, true);
    expect([...m.l.eb.ram]).toEqual([...ref.ram]);
    expect(m.got).toEqual(ref.reads);
  });
  for (const rate of [400, 120, 50]) {
    it(`bit errors, one symbol in ${rate}: damaged packets replayed, memory and reads still exact`, () => {
      const cmds = workload(rate, 50), ref = REF(cmds), m = drive(rate, rate, cmds, 20000);
      holdsPromises(m, false);
      expect(m.mAB.pkts.some((p) => !p.good) || m.mBA.pkts.some((p) => !p.good)).toBe(true);
      expect([...m.l.eb.ram]).toEqual([...ref.ram]);
      expect(m.got).toEqual(ref.reads);
    });
  }
  it('training survives errors (a timeout starts the sequence again)', () => {
    const m = drive(9, 40, [{ wr: 1, addr: 1, len: 1, seed: 1 }], 1000);
    expect(m.l.a.dl).toBe(3);
    expect(m.l.eb.ram[4]).toBe(1);
  });
  it('training puts COM on the lane, and TS1 before TS2 before anything else', () => {
    const l = new PcieLink(), seen: number[] = [];
    let last = -1;
    for (let k = 0; k < 2000; k++) {
      const w = l.out(LINK_IN0);
      if (!w.a.txk && (w.a.txd === 0x4a || w.a.txd === 0x45) && w.a.txd !== last) { seen.push(w.a.txd); last = w.a.txd; }
      l.step(LINK_IN0);
    }
    expect(seen).toEqual([0x4a, 0x45]);
  });
});
