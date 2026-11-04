// The Python TCP (comm/stack/tcp.ts) compiled for RV32I, against the reference (net/tcp.ts), on the same inputs at the same virtual times: every frame it
// sends equals what comm/netframes.ts builds from the reference's segment, every state variable equals the reference's after every pass of its main loop.
// A third TCP is the peer, over a link that loses, duplicates and reorders, and the bench adds junk no well-behaved peer sends.

import { describe, expect, it } from 'vitest';
import { dissect, ip4, tcpFrame } from '../src/comm/netframes';
import { DEFAULT_STACK } from '../src/comm/stack/all';
import { stackProgram } from '../src/comm/stack';
import { STACK_LAYOUT as L, STACK_RAM_K } from '../src/comm/stack/layout';
import { TCP } from '../src/comm/stack/tcp';
import { ACK, CLOSED, ESTABLISHED, FIN, LISTEN, PSH, RST, segBytes, SYN, TcpModel, TIME_WAIT, type Segment } from '../src/net/tcp';
import { DEV, FastISS } from '../src/riscv/fastiss';
import { lcg } from './util';
import { tick } from './yieldtick';

const A = ip4(10, 0, 0, 1), B = ip4(10, 0, 0, 2);
const MA = [2, 0, 0, 0, 0, 1], MB = [2, 0, 0, 0, 0, 2];
const CMD = 0x7f00, BUF = 0x7f10, BUF_N = 200;

/** The application: one command word from the bench a pass (0 none, 1 listen, 2 connect, 3 write, 4 read, 5 close), then the receive ring and the timers. */
const app = (isn: number) => `isn_next = ${isn | 0}
net_init(${A}, ${MA.join(', ')})
store8(${BUF}, ${MB[0]})
store8(${BUF + 1}, ${MB[1]})
store8(${BUF + 2}, ${MB[2]})
store8(${BUF + 3}, ${MB[3]})
store8(${BUF + 4}, ${MB[4]})
store8(${BUF + 5}, ${MB[5]})
arp_learn(${B}, ${BUF})
while 1:
    c = load32(${CMD})
    if c == 1:
        tcp_listen(load32(${CMD + 4}))
    elif c == 2:
        tcp_connect(${B}, load32(${CMD + 4}), load32(${CMD + 8}))
    elif c == 3:
        store32(${CMD + 12}, tcp_write(${BUF}, load32(${CMD + 4})))
    elif c == 4:
        store32(${CMD + 12}, tcp_read(${BUF}, load32(${CMD + 4})))
    elif c == 5:
        tcp_close()
    store32(${CMD}, 0)
    net_poll()
    tcp_tick()
    store32(0x80000018, 1)
`;

/** The computer without its NIC: the bench is the NIC (it fills receive buffers and empties transmit ones) and sets the clock. */
class Dut extends FastISS {
  clock = 1;
  constructor(words: ArrayLike<number>) {
    super(words, { system: true, dmemWords: 2 ** STACK_RAM_K, imemWords: 2 ** Math.ceil(Math.log2(words.length + 1)) });
    this.region[7] = DEV;
  }
  protected override load(addr: number, f3: number): number { return addr >>> 28 === 7 ? 0 : super.load(addr, f3); }
  protected override store(addr: number, f3: number, v: number): void { if (addr >>> 28 !== 7) super.store(addr, f3, v); }
  protected override ioRead(addr: number): number { return ((addr >>> 2) & 7) === 4 ? this.clock : super.ioRead(addr); }
  protected override ioWrite(addr: number, f3: number, v: number): void {
    if (((addr >>> 2) & 7) === 6) this.yieldNow = true;
    else super.ioWrite(addr, f3, v);
  }
  word(a: number): number { return this.dmem[a >>> 2] >>> 0; }
}

interface Fixture { words: number[]; home: (name: string) => number }
function compile(isn: number): Fixture {
  const b = stackProgram([...DEFAULT_STACK, TCP], app(isn));
  if (b.compiled.error) throw new Error(`${b.compiled.error.message} (${JSON.stringify(b.where(b.compiled.error.line))})`);
  const homes = new Map(b.compiled.layout!.homes.filter((h) => h.addr !== undefined).map((h) => [h.name, h.addr!]));
  return { words: b.compiled.words, home: (n) => { const a = homes.get(n); if (a === undefined) throw new Error(`no home for ${n}`); return a; } };
}

const VARS: [string, (m: TcpModel) => number][] = [
  ['tcp_st', (m) => m.st], ['tcp_lport', (m) => m.lport], ['tcp_rport', (m) => m.rport], ['tcp_rip', (m) => m.rip], ['iss', (m) => m.iss], ['snd_una', (m) => m.sndUna], ['snd_nxt', (m) => m.sndNxt],
  ['snd_max', (m) => m.sndMax], ['snd_end', (m) => m.sndEnd], ['snd_wnd', (m) => m.sndWnd], ['wl1', (m) => m.wl1], ['wl2', (m) => m.wl2], ['rcv_nxt', (m) => m.rcvNxt], ['rcv_read', (m) => m.rcvRead],
  ['fin_in', (m) => +m.finIn], ['fin_want', (m) => +m.finWant], ['ack_pending', (m) => +m.ackPending], ['tcp_mss', (m) => m.mss], ['cwnd', (m) => m.cwnd], ['ssthresh', (m) => m.ssthresh], ['acc', (m) => m.acc],
  ['dupacks', (m) => m.dupacks], ['srtt', (m) => m.srtt], ['rttvar', (m) => m.rttvar], ['rto', (m) => m.rto], ['rto_on', (m) => +m.rtoOn], ['rto_at', (m) => m.rtoAt], ['rtt_on', (m) => +m.rttOn], ['retries', (m) => m.retries],
  ['tcp_err', (m) => +m.err], ['tcp_passive', (m) => +m.passive],
];

type Cmd = { k: 'listen'; port: number } | { k: 'connect'; sport: number; dport: number } | { k: 'write'; bytes: number[] } | { k: 'read'; n: number } | { k: 'close' };

/** The compiled stack and the model side by side. */
class Pair {
  readonly cpu: Dut;
  readonly model: TcpModel;
  private readonly f: Fixture;
  private out: { seg: Segment; to: number }[] = [];
  private pending = 0; private ip = 1; private rxi = 0; private txi = 0;
  /** What the pair sent last pass, as segments. */
  constructor(isn: number) {
    this.f = compile(isn);
    this.cpu = new Dut(this.f.words);
    this.model = new TcpModel({ ip: A, isn, send: (seg, to) => { if (this.pending === L.descriptors) return false; this.pending++; this.out.push({ seg, to }); return true; } });
    this.runPass(); // past its initialization, to the first yield
  }

  private runPass(): void {
    const c = this.cpu;
    c.yieldNow = false;
    for (let g = 0; g < 2000; g++) {
      const before = c.retired;
      c.run(50_000_000);
      if (c.halted) throw new Error('the program halted');
      if (c.retired !== before) return;
    }
    throw new Error('no progress');
  }

  /** One pass of the main loop on both: a command, a frame in the receive ring, the timers. Returns the segments sent, checked. */
  step(now: number, o: { cmd?: Cmd; seg?: number[]; src?: number; rawFrame?: number[] } = {}): { seg: Segment; to: number }[] {
    const c = this.cpu, m = this.model;
    c.clock = now;
    this.out = [];
    let wrote = -1, read: number[] | null = null;
    if (o.cmd) {
      const w = (a: number, v: number) => { c.dmem[a >>> 2] = v >>> 0; };
      switch (o.cmd.k) {
        case 'listen': w(CMD + 4, o.cmd.port); w(CMD, 1); m.listen(o.cmd.port); break;
        case 'connect': w(CMD + 4, o.cmd.sport); w(CMD + 8, o.cmd.dport); w(CMD, 2); m.connect(B, o.cmd.sport, o.cmd.dport, now); break;
        case 'write': o.cmd.bytes.forEach((b, i) => { c.d8[BUF + i] = b; }); w(CMD + 4, o.cmd.bytes.length); w(CMD, 3); wrote = m.write(o.cmd.bytes, now); break;
        case 'read': w(CMD + 4, o.cmd.n); w(CMD, 4); read = m.read(o.cmd.n, now); break;
        case 'close': w(CMD, 5); m.close(now); break;
      }
    }
    if (o.seg || o.rawFrame) {
      // as the NIC would: bytes in the buffer, OWN cleared, the length
      const frame = o.rawFrame ?? tcpFrameFor(o.seg!, o.src ?? B);
      const b = L.rxBuf + this.rxi * L.bufSize;
      frame.forEach((v, i) => { c.d8[b + i] = v; });
      c.dmem[(L.rxRing + 8 * this.rxi + 4) >>> 2] = frame.length;
      this.rxi = (this.rxi + 1) & 7;
      if (o.seg) m.input(o.seg, o.src ?? B, now);
    }
    m.tick(now);
    this.runPass();
    // the frames that left the CPU, in ring order
    const sent = this.out, got: number[][] = [];
    for (let k = 0; k < L.descriptors; k++) {
      const d = (L.txRing + 8 * this.txi + 4) >>> 2, w = c.dmem[d];
      if (w < 0x80000000) break;
      const n = w & 0x7ff, at = L.txBuf + this.txi * L.bufSize;
      got.push(Array.from(c.d8.subarray(at, at + n)));
      c.dmem[d] = 0;
      this.txi = (this.txi + 1) & 7;
    }
    this.pending = 0;
    {
      expect(got.length, `frames sent at ${now}`).toBe(sent.length);
      sent.forEach((s, i) => {
        const want = tcpFrame({ srcMac: MA, dstMac: MB, src: A, dst: s.to, id: this.ip++, ...s.seg }).bytes;
        expect(got[i], `frame ${i} at ${now}: ${dissect(want)}`).toEqual(want);
      });
    }
    for (const [name, get] of VARS) expect(c.word(this.f.home(name)) | 0, `${name} at ${now}`).toBe(get(m) | 0);
    if (wrote >= 0) expect(c.word(CMD + 12)).toBe(wrote);
    if (read) {
      expect(c.word(CMD + 12)).toBe(read.length);
      expect(Array.from(c.d8.subarray(BUF, BUF + read.length))).toEqual(read);
    }
    return sent;
  }
}

const tcpFrameFor = (seg: number[], src: number): number[] => [...MA, ...MB, 8, 0, 0x45, 0, (20 + seg.length) >> 8, (20 + seg.length) & 255, 0, 1, 0x40, 0, 64, 6, ...ipCk(20 + seg.length, src), (src >>> 24) & 255, (src >>> 16) & 255, (src >>> 8) & 255, src & 255, 10, 0, 0, 1, ...seg];
function ipCk(total: number, src: number): number[] {
  let s = 0x4500 + total + 1 + 0x4000 + 0x4006 + (src >>> 16) + (src & 0xffff) + 0x0a00 + 1;
  while (s > 0xffff) s = (s & 0xffff) + (s >>> 16);
  s = ~s & 0xffff;
  return [s >> 8, s & 255];
}

const payload = (r: (n: number) => number, n: number) => Array.from({ length: n }, () => r(256));

/** The pair against a peer model over a link; `script` runs before each pass with the time. */
function world(o: { seed: number; isn?: number; isnPeer?: number; loss?: number; dup?: number; jitter?: number; delay?: number; junk?: number; active?: boolean; slowRead?: boolean; n?: number }) {
  const r = lcg(o.seed);
  const pair = new Pair(o.isn ?? 0x10000000);
  const toPair: { at: number; bytes: number[] }[] = [], toPeer: { at: number; bytes: number[] }[] = [];
  const delay = o.delay ?? 9000, jitter = o.jitter ?? 0;
  const pushTo = (q: typeof toPair, bytes: number[], now: number) => {
    const v = r(100), loss = o.loss ?? 0, dup = o.dup ?? 0;
    const k = v < loss ? 0 : v < loss + dup ? 2 : 1;
    for (let i = 0; i < k; i++) q.push({ at: now + delay + (jitter ? r(jitter) : 0), bytes });
  };
  let now = 1;
  const peer = new TcpModel({ ip: B, isn: o.isnPeer ?? 0x60000000, send: (s, to) => { pushTo(toPair, segBytes(s, B, to), now); return true; } });
  return { r, pair, peer, toPair, toPeer, pushTo, now: () => now, setNow: (t: number) => { now = t; } };
}

/** Drive a whole connection: open, send `n` bytes each way or one way, close. Returns what each side read. */
async function converse(o: Parameters<typeof world>[0]) {
  const w = world(o), { r, pair, peer, toPair, toPeer } = w, n = o.n ?? 1500;
  const up = payload(r, n), down = payload(r, Math.floor(n / 3));
  let upSent = 0, downSent = 0, closed = false;
  const gotPeer: number[] = [], gotPair: number[] = [];
  const m = pair.model;
  const deliver = (sent: { seg: Segment; to: number }[], now: number) => { for (const s of sent) w.pushTo(toPeer, segBytes(s.seg, A, s.to), now); };
  const active = o.active ?? true;
  if (active) { peer.listen(80); deliver(pair.step(w.now(), { cmd: { k: 'connect', sport: 40000, dport: 80 } }), w.now()); }
  else { deliver(pair.step(w.now(), { cmd: { k: 'listen', port: 80 } }), w.now()); peer.rip = 0; peer.connect(A, 50000, 80, w.now()); }
  let t = w.now(), guard = 0;
  const done = () => gotPeer.length >= n && gotPair.length >= down.length && closed && (m.st === TIME_WAIT || m.st === CLOSED || m.st === LISTEN) && (peer.st === TIME_WAIT || peer.st === CLOSED || peer.st === LISTEN);
  while (!done() && guard++ < 60000) {
    t += 700 + r(800);
    w.setNow(t);
    const now = t;
    peer.tick(now);
    for (let i = 0; i < toPeer.length;) { if (toPeer[i].at <= now) { peer.input(toPeer.splice(i, 1)[0].bytes, A, now); } else i++; }
    if (peer.st === ESTABLISHED || peer.st === 7) {
      if (downSent < down.length) downSent += peer.write(down.slice(downSent, downSent + 90), now);
      if (gotPeer.length >= n && downSent >= down.length) peer.close(now);
    }
    if (!o.slowRead || r(4) === 0) gotPeer.push(...peer.read(4096, now));
    const i = toPair.findIndex((x) => x.at <= now);
    const seg = i >= 0 ? toPair.splice(i, 1)[0].bytes : undefined;
    let cmd: Cmd | undefined;
    const open = m.st === ESTABLISHED || m.st === 7;
    if (open && upSent < n && r(3) === 0) { const k = Math.min(BUF_N, n - upSent, 1 + r(180)); cmd = { k: 'write', bytes: up.slice(upSent, upSent + k) }; }
    else if (m.st >= ESTABLISHED && r(2) === 0) cmd = { k: 'read', n: 1 + r(BUF_N - 1) };
    else if (open && upSent >= n && gotPair.length >= down.length && !closed) { cmd = { k: 'close' }; closed = true; }
    const wbefore = m.sndEnd;
    let rawFrame: number[] | undefined;
    if (o.junk && r(100) < o.junk) rawFrame = junkFrame(r, m);
    if (rawFrame && !seg) {
      deliver(pair.step(now, { cmd, seg: rawFrame.slice(34), src: B }), now);
    } else deliver(pair.step(now, { cmd, seg }), now);
    if (cmd?.k === 'write') upSent += ((m.sndEnd - wbefore) | 0);
    if (cmd?.k === 'read') { const c = pair.cpu; gotPair.push(...Array.from(c.d8.subarray(BUF, BUF + c.word(CMD + 12)))); }
    if (guard % 400 === 0) await tick();
  }
  return { up, down, gotPeer, gotPair, m, peer, guard };
}

/** Something no well-behaved peer sends, on the connection or next to it. */
function junkFrame(r: (n: number) => number, m: TcpModel): number[] {
  const near = (v: number) => (v + (r(2) ? r(2000) : -r(2000))) | 0;
  const s: Segment = { sport: r(5) === 0 ? r(65536) : m.rport, dport: r(5) === 0 ? r(65536) : m.lport, seq: r(2) ? near(m.rcvNxt) : m.rcvNxt, ack: r(2) ? near(m.sndUna) : m.sndNxt, flags: r(64) & 63, wnd: r(65536), data: payload(r, r(3) ? 0 : r(70)) };
  const b = segBytes(s, B, A);
  if (r(6) === 0) b[r(b.length)] ^= 1 << r(8);
  if (r(9) === 0) b[12] = r(256);
  return [...new Array(34).fill(0), ...b];
}

describe('the Python TCP against the reference', () => {
  it('compiles within the data region', () => {
    const b = stackProgram([...DEFAULT_STACK, TCP], app(1));
    expect(b.compiled.error).toBeNull();
    expect(b.compiled.layout!.outBase).toBeLessThanOrEqual(2040);
  });
  it('active open, by hand: the SYN, then what a SYN-ACK brings', () => {
    const p = new Pair(0x1000);
    const s = p.step(5, { cmd: { k: 'connect', sport: 40000, dport: 80 } });
    expect(s.map((x) => x.seg.flags)).toEqual([SYN]);
    expect(s[0].seg.seq).toBe(0x1000);
    const synack = segBytes({ sport: 80, dport: 40000, seq: 0x2000, ack: 0x1001, flags: SYN | ACK, wnd: 512, mss: 64, data: [] }, B, A);
    const r = p.step(1005, { seg: synack });
    expect(r.map((x) => [x.seg.flags, x.seg.seq, x.seg.ack])).toEqual([[ACK, 0x1001, 0x2001]]);
    expect(p.model.st).toBe(ESTABLISHED);
    expect(p.model.srtt).toBe(1000);
  });
  it('passive open, a reset for what belongs to nothing, data and close', () => {
    const p = new Pair(0x1000);
    expect(p.step(1, { cmd: { k: 'listen', port: 80 } })).toEqual([]);
    // to another port: a reset
    const stray = segBytes({ sport: 9, dport: 81, seq: 77, ack: 0, flags: SYN, wnd: 512, data: [] }, B, A);
    const r0 = p.step(2, { seg: stray });
    expect(r0[0].seg).toMatchObject({ flags: RST | ACK, seq: 0, ack: 78 });
    const syn = segBytes({ sport: 50000, dport: 80, seq: 0xfffffffe | 0, ack: 0, flags: SYN, wnd: 512, mss: 40, data: [] }, B, A);
    expect(p.step(3, { seg: syn }).map((x) => x.seg.flags)).toEqual([SYN | ACK]);
    expect(p.model.mss).toBe(40);
    const ack = segBytes({ sport: 50000, dport: 80, seq: 0xffffffff | 0, ack: 0x1001, flags: ACK, wnd: 512, data: [] }, B, A);
    expect(p.step(4, { seg: ack })).toEqual([]);
    expect(p.model.st).toBe(ESTABLISHED);
    // data across the sequence numbers' wrap, then a FIN in the same segment
    const data = segBytes({ sport: 50000, dport: 80, seq: 0xffffffff | 0, ack: 0x1001, flags: ACK | PSH | FIN, wnd: 512, data: [1, 2, 3, 4] }, B, A);
    expect(p.step(5, { seg: data }).map((x) => [x.seg.flags, x.seg.ack])).toEqual([[ACK, 4]]);
    p.step(6, { cmd: { k: 'read', n: 100 } });
    expect(Array.from(p.cpu.d8.subarray(BUF, BUF + 4))).toEqual([1, 2, 3, 4]);
    expect(p.step(7, { cmd: { k: 'close' } }).map((x) => x.seg.flags)).toEqual([ACK | FIN]);
    const last = segBytes({ sport: 50000, dport: 80, seq: 4, ack: 0x1002, flags: ACK, wnd: 512, data: [] }, B, A);
    p.step(8, { seg: last });
    expect(p.model.st).toBe(LISTEN);
  });
  it('a whole conversation on a clean link, both ways', async () => {
    const c = await converse({ seed: 1 });
    expect(c.gotPeer).toEqual(c.up);
    expect(c.gotPair).toEqual(c.down);
  }, 120000);
  it('any fate on the link, either side opening: both streams, identical to the reference at every step', async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const c = await converse({ seed: seed * 17, loss: [0, 3, 8, 15][seed & 3], dup: seed % 5, jitter: seed % 2 ? 5000 : 0, active: seed % 3 !== 0, slowRead: seed % 4 === 0, n: 800 });
      expect(c.gotPeer, `seed ${seed}`).toEqual(c.up);
      expect(c.gotPair, `seed ${seed}`).toEqual(c.down);
    }
  }, 240000);
  it('sequence numbers crossing both wrap points', async () => {
    for (const [a, b] of [[0x7ffffd00, 0xfffffd00 | 0], [0xfffffd00 | 0, 0x7ffffd00]]) {
      const c = await converse({ seed: 5, isn: a, isnPeer: b, loss: 4, n: 1200 });
      expect(c.gotPeer).toEqual(c.up);
    }
  }, 120000);
  it('junk on the connection and beside it: the same answers as the reference, every time', async () => {
    for (let seed = 1; seed <= 8; seed++) await converse({ seed: 300 + seed, junk: 12, loss: 3, n: 400 });
  }, 240000);
});

// Paths the random conversations did not reach: a harness check that broke each rule on purpose found them (a wrong rule went unnoticed).
describe('directed: what random traffic does not reach', () => {
  const PEER = { sport: 80, dport: 40000 };
  /** An established connection with the peer at sequence 0x2001 and a window of `wnd`. */
  function established(wnd = 512) {
    const p = new Pair(0x1000);
    p.step(1, { cmd: { k: 'connect', sport: 40000, dport: 80 } });
    p.step(2, { seg: segBytes({ ...PEER, seq: 0x2000, ack: 0x1001, flags: SYN | ACK, wnd, mss: 64, data: [] }, B, A) });
    return p;
  }
  const ack = (seq: number, a: number, wnd = 512, flags = ACK, data: number[] = []) => segBytes({ ...PEER, seq, ack: a, flags, wnd, data }, B, A);
  const fill = (n: number) => Array.from({ length: n }, (_, i) => (i * 3) & 255);

  it('a timeout with a large window: ssthresh is half of what was out, cwnd one segment, and it goes back', () => {
    const p = established();
    let now = 10, una = 0x1001;
    // grow the window with clean ACKs until more than 8 segments are allowed
    for (let k = 0; k < 12; k++) {
      p.step(now += 100, { cmd: { k: 'write', bytes: fill(BUF_N) } });
      una = p.model.sndNxt;
      p.step(now += 100, { seg: ack(0x2001, una) });
    }
    expect(p.model.cwnd).toBeGreaterThan(6 * 64);
    p.step(now += 100, { cmd: { k: 'write', bytes: fill(BUF_N) } });
    p.step(now += 100, { cmd: { k: 'write', bytes: fill(BUF_N) } });
    p.step(now += 100, { cmd: { k: 'write', bytes: fill(BUF_N) } });
    const flight = (p.model.sndMax - p.model.sndUna) | 0;
    expect(flight).toBeGreaterThan(4 * 64);
    const s = p.step(p.model.rtoAt + 1);
    expect(p.model.ssthresh).toBe(flight >> 1);
    expect(p.model.cwnd).toBe(64);
    expect(s[0].seg.seq).toBe(p.model.sndUna);
    expect(s.length).toBe(1);
  });
  it('zero window: the same byte probes on a doubling timer, longer than the retry limit, nothing cut, until the window opens', () => {
    const p = established(512);
    let now = 10;
    p.step(now += 10, { cmd: { k: 'write', bytes: fill(200) } });
    const una = p.model.sndNxt;
    expect(una).toBe(0x1001 + 128);
    p.step(now += 10, { seg: ack(0x2001, una, 0) });
    expect(p.model.sndWnd).toBe(0);
    expect(p.model.sndEnd - p.model.sndNxt).toBe(72);
    const cw = p.model.cwnd, ss = p.model.ssthresh;
    let rto = p.model.rto;
    for (let k = 0; k < 12; k++) {
      now = p.model.rtoAt + 1;
      const s = p.step(now);
      expect(s.map((x) => [x.seg.seq, x.seg.data.length]), `probe ${k}`).toEqual([[una, 1]]);
      expect(p.model.rto).toBe(Math.min(2 * rto, 6_400_000));
      rto = p.model.rto;
      // refused: the receiver's window is still shut
      p.step(now += 1, { seg: ack(0x2001, una, 0) });
    }
    expect(p.model.st).toBe(ESTABLISHED);
    expect(p.model.err).toBe(false);
    expect([p.model.cwnd, p.model.ssthresh]).toEqual([cw, ss]);
    expect(p.model.retries).toBe(0);
    // the window opens: the rest goes, from the probe's byte on
    const s = p.step(now += 1, { seg: ack(0x2001, una, 512) });
    expect(s.length).toBeGreaterThan(0);
    const last = p.step(now += 1, { seg: ack(0x2001, (una + 1) | 0, 512) });
    expect([...s, ...last].reduce((n, x) => n + x.seg.data.length, 0)).toBe(71);
  });
  it('a reset at the window\'s last byte is challenged, at the first byte past it dropped', () => {
    const p = established();
    const free = 512;
    const inside = (0x2001 + free - 1) | 0, past = (0x2001 + free) | 0;
    expect(p.step(10, { seg: segBytes({ ...PEER, seq: inside, ack: 0, flags: RST, wnd: 0, data: [] }, B, A) }).map((x) => x.seg.flags)).toEqual([ACK]);
    expect(p.step(11, { seg: segBytes({ ...PEER, seq: past, ack: 0, flags: RST, wnd: 0, data: [] }, B, A) })).toEqual([]);
    expect(p.model.st).toBe(ESTABLISHED);
  });
  it('a retransmission that overlaps what arrived: the old part is cut, the new part taken in order', () => {
    const p = established();
    const d = fill(30);
    p.step(10, { seg: ack(0x2001, 0x1001, 512, ACK | PSH, d.slice(0, 10)) });
    // 4 bytes seen already, 16 new
    p.step(11, { seg: ack(0x2001 + 6, 0x1001, 512, ACK | PSH, d.slice(6, 26)) });
    expect(p.model.rcvNxt).toBe(0x2001 + 26);
    p.step(12, { cmd: { k: 'read', n: 100 } });
    expect(Array.from(p.cpu.d8.subarray(BUF, BUF + 26))).toEqual(d.slice(0, 26));
    // wholly old: acknowledged and dropped
    expect(p.step(13, { seg: ack(0x2001, 0x1001, 512, ACK | PSH, d.slice(0, 10)) }).map((x) => x.seg.ack)).toEqual([0x2001 + 26]);
  });
  it('options in a SYN: NOPs and unknown kinds are walked, an end-of-list stops, a bad length stops', () => {
    const syn = (opts: number[]) => {
      const pad = [...opts]; while (pad.length % 4) pad.push(0);
      const hl = 20 + pad.length;
      const b = [0xc3, 0x50, 0, 80, 0, 0, 0x30, 0, 0, 0, 0, 0, (hl / 4) << 4, SYN, 2, 0, 0, 0, 0, 0, ...pad];
      const sum = (x: number[], st: number) => { let s = st; for (let i = 0; i < x.length; i += 2) s += (x[i] << 8) | (x[i + 1] ?? 0); while (s > 0xffff) s = (s & 0xffff) + (s >>> 16); return s; };
      const c = ~sum(b, sum([10, 0, 0, 2, 10, 0, 0, 1, 0, 6, 0, hl], 0)) & 0xffff;
      b[16] = c >> 8; b[17] = c & 255;
      return b;
    };
    const mssOf = (opts: number[]) => {
      const p = new Pair(0x1000);
      p.step(1, { cmd: { k: 'listen', port: 80 } });
      p.step(2, { seg: syn(opts) });
      return p.model.mss;
    };
    expect(mssOf([1, 1, 2, 4, 0, 40])).toBe(40);
    expect(mssOf([1, 3, 3, 7, 2, 4, 0, 32])).toBe(32);
    expect(mssOf([0, 2, 4, 0, 32])).toBe(64);
    expect(mssOf([2, 0, 2, 4, 0, 32])).toBe(64);
    expect(mssOf([])).toBe(64);
  });
});
