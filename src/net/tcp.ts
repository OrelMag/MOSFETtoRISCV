// Chapter 52's TCP, the reference: one connection, RFC 9293's state machine, RFC 6298's retransmission timer, RFC 5681's congestion control with
// RFC 3465's byte counting (no multiply or divide on an RV32I without M). DOM-free; comm/stack/tcp.ts is the same rules in the Python subset, and
// tests/net-tcp-stack.test.ts makes the two emit the same bytes on the same inputs.
//
// What it leaves out, each named in the chapter:
//   one connection at a time; no out-of-order queue: a segment that does not start at rcv_nxt is dropped and acknowledged (so a loss costs everything
//   sent after it: both fast retransmit and the timer go back to snd_una); an ACK for every segment, none delayed; no options but the handshake's
//   MSS (so no window scaling, timestamps or SACK); an ACK field on a dropped segment is not looked at; the initial sequence number is a counter, not
//   RFC 6528's keyed hash.
//
// Sequence numbers are int32 here as in the subset: every comparison is on a difference, so they wrap. Time is in clock cycles, also wrapping.

export const TCP_PROTO = 6;
export const FIN = 1, SYN = 2, RST = 4, PSH = 8, ACK = 16;

export const CLOSED = 0, LISTEN = 1, SYN_SENT = 2, SYN_RCVD = 3, ESTABLISHED = 4, FIN_WAIT_1 = 5, FIN_WAIT_2 = 6, CLOSE_WAIT = 7, CLOSING = 8, LAST_ACK = 9, TIME_WAIT = 10;
export const STATE_NAMES = ['CLOSED', 'LISTEN', 'SYN_SENT', 'SYN_RCVD', 'ESTABLISHED', 'FIN_WAIT_1', 'FIN_WAIT_2', 'CLOSE_WAIT', 'CLOSING', 'LAST_ACK', 'TIME_WAIT'];

/** Sizes and times, the same constants as the Python. Buffers are powers of two, in the 1.8 KB of RAM above the NIC's frame buffers (stack/layout.ts). */
export const TCP_K = {
  /** Data bytes a segment: a 118-byte frame, which also fits chapter 50's switch cell of 128 with its FCS. */
  MSS: 64,
  SND: 1024,
  RCV: 512,
  /** Clock cycles. A round trip on the bench is some tens of thousands. */
  RTO_INIT: 200_000,
  RTO_MIN: 40_000,
  RTO_MAX: 6_400_000,
  /** Timeouts in a row before the connection is given up. */
  RETRIES: 8,
  /** 2 MSL, far shorter than the RFC's minutes: no segment lives long on this bench. */
  TIME_WAIT: 400_000,
  DUPACKS: 3,
} as const;

const lt = (a: number, b: number) => ((a - b) | 0) < 0;
const le = (a: number, b: number) => ((a - b) | 0) <= 0;

export interface Segment { sport: number; dport: number; seq: number; ack: number; flags: number; wnd: number; mss?: number; data: number[] }

const be16 = (v: number) => [(v >> 8) & 255, v & 255];
const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

/** The 16-bit ones' complement sum, RFC 1071. */
function sum16(b: ArrayLike<number>, start: number): number {
  let s = start;
  for (let i = 0; i < b.length; i += 2) s += (b[i] << 8) | (i + 1 < b.length ? b[i + 1] : 0);
  while (s > 0xffff) s = (s & 0xffff) + (s >>> 16);
  return s;
}
const pseudo = (src: number, dst: number, len: number) => sum16([...be32(src), ...be32(dst), 0, TCP_PROTO, ...be16(len)], 0);

/** A segment's bytes, checksum filled in. */
export function segBytes(s: Segment, src: number, dst: number): number[] {
  const opt = s.mss === undefined ? [] : [2, 4, ...be16(s.mss)];
  const hl = 20 + opt.length;
  const b = [...be16(s.sport), ...be16(s.dport), ...be32(s.seq), ...be32(s.ack), (hl / 4) << 4, s.flags, ...be16(s.wnd), 0, 0, 0, 0, ...opt, ...s.data];
  const c = ~sum16(b, pseudo(src, dst, b.length)) & 0xffff;
  b[16] = c >> 8; b[17] = c & 255;
  return b;
}

/** The fields of a segment, or null when it is too short or its checksum is wrong. */
export function parseSeg(b: ArrayLike<number>, src: number, dst: number): (Segment & { off: number }) | null {
  const n = b.length;
  if (n < 20 || sum16(b, pseudo(src, dst, n)) !== 0xffff) return null;
  const off = (b[12] >> 4) * 4;
  if (off < 20 || off > n) return null;
  let mss: number | undefined;
  for (let i = 20; i + 1 < off;) {
    const k = b[i];
    if (k === 0) break;
    if (k === 1) { i++; continue; }
    if (k === 2 && b[i + 1] === 4 && i + 3 < off) mss = (b[i + 2] << 8) | b[i + 3];
    if (b[i + 1] < 2) break;
    i += b[i + 1];
  }
  const w = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) | 0;
  return { sport: (b[0] << 8) | b[1], dport: (b[2] << 8) | b[3], seq: w(4), ack: w(8), off, flags: b[13] & 63, wnd: (b[14] << 8) | b[15], mss, data: Array.from({ length: n - off }, (_, i) => b[off + i]) };
}

export interface TcpEvent { t: number; cwnd: number; ssthresh: number; flight: number; rto: number; srtt: number; st: number; why: 'ack' | 'timeout' | 'fast' | 'probe' | 'sample' }

export interface TcpOptions {
  ip: number;
  /** The first initial sequence number; each new connection takes the next. */
  isn?: number;
  /** Hands a finished segment to the layer below. False: no buffer free, or the next hop's address is not known yet; nothing was sent. */
  send(seg: Segment, to: number): boolean;
  /** A segment answered to something with no connection. */
  onEvent?(e: TcpEvent): void;
}

export class TcpModel {
  st = CLOSED;
  lport = 0; rport = 0; rip = 0;
  passive = false;
  iss = 0; isnNext: number;
  sndUna = 0; sndNxt = 0; sndMax = 0; sndEnd = 0; sndWnd = 0; wl1 = 0; wl2 = 0;
  rcvNxt = 0; rcvRead = 0;
  mss: number = TCP_K.MSS;
  cwnd: number = 2 * TCP_K.MSS; ssthresh: number = TCP_K.SND; acc = 0; dupacks = 0;
  srtt = 0; rttvar = 0; rto: number = TCP_K.RTO_INIT; rtoOn = false; rtoAt = 0; rttOn = false; rttSeq = 0; rttT = 0; retries = 0;
  finWant = false; finIn = false; ackPending = false; twAt = 0;
  /** True once the connection failed: reset by the peer, or given up after RETRIES timeouts. */
  err = false;
  readonly sb = new Uint8Array(TCP_K.SND);
  readonly rb = new Uint8Array(TCP_K.RCV);

  constructor(readonly o: TcpOptions) { this.isnNext = o.isn ?? 0x10000000; }

  /** Bytes waiting to be read: the peer's FIN holds a sequence number but no byte. */
  private held(): number { return ((this.rcvNxt - this.rcvRead) | 0) - (this.finIn ? 1 : 0); }
  private free(): number { return TCP_K.RCV - this.held(); }
  private event(t: number, why: TcpEvent['why']): void {
    this.o.onEvent?.({ t, cwnd: this.cwnd, ssthresh: this.ssthresh, flight: (this.sndMax - this.sndUna) | 0, rto: this.rto, srtt: this.srtt, st: this.st, why });
  }

  private reset(): void {
    this.sndUna = this.sndNxt = this.sndMax = this.sndEnd = 0;
    this.rcvNxt = this.rcvRead = 0;
    this.mss = TCP_K.MSS; this.cwnd = 2 * TCP_K.MSS; this.ssthresh = TCP_K.SND; this.acc = 0; this.dupacks = 0;
    this.srtt = 0; this.rttvar = 0; this.rto = TCP_K.RTO_INIT; this.rtoOn = false; this.rttOn = false; this.retries = 0;
    this.finWant = false; this.finIn = false; this.ackPending = false;
  }
  private drop(): void { this.reset(); this.st = this.passive ? LISTEN : CLOSED; }
  private start(): void {
    this.iss = this.isnNext;
    this.isnNext = (this.isnNext + 0x10000) | 0;
    this.sndUna = this.sndNxt = this.sndMax = this.iss;
    this.sndEnd = (this.iss + 1) | 0;
  }

  listen(port: number): void { this.reset(); this.lport = port; this.passive = true; this.st = LISTEN; }
  connect(ip: number, sport: number, dport: number, now: number): void {
    this.reset(); this.passive = false; this.err = false; this.lport = sport; this.rip = ip; this.rport = dport; this.start();
    this.st = SYN_SENT;
    this.output(now);
  }

  /** Bytes taken into the send buffer: as many as fit. */
  write(data: ArrayLike<number>, now: number): number {
    if (this.st !== ESTABLISHED && this.st !== CLOSE_WAIT) return 0;
    const room = TCP_K.SND - ((this.sndEnd - this.sndUna) | 0), n = Math.min(room, data.length);
    for (let i = 0; i < n; i++) this.sb[((this.sndEnd + i) | 0) & (TCP_K.SND - 1)] = data[i];
    this.sndEnd = (this.sndEnd + n) | 0;
    this.output(now);
    return n;
  }

  /** Up to `max` received bytes. A window that opens by a segment or more after being too small for one is announced at once. */
  read(max: number, now: number): number[] {
    const before = this.free(), n = Math.min(max, this.held()), out: number[] = [];
    for (let i = 0; i < n; i++) out.push(this.rb[((this.rcvRead + i) | 0) & (TCP_K.RCV - 1)]);
    this.rcvRead = (this.rcvRead + n) | 0;
    if (before < this.mss && this.free() >= this.mss && this.st >= ESTABLISHED) { this.ackPending = true; this.output(now); }
    return out;
  }

  close(now: number): void {
    if (this.st === ESTABLISHED) { this.finWant = true; this.st = FIN_WAIT_1; }
    else if (this.st === CLOSE_WAIT) { this.finWant = true; this.st = LAST_ACK; }
    else if (this.st === SYN_SENT || this.st === LISTEN) { this.passive = false; this.drop(); return; }
    this.output(now);
  }

  private emit(flags: number, seq: number, n: number, mss?: number): boolean {
    const data: number[] = [];
    for (let i = 0; i < n; i++) data.push(this.sb[((seq + i) | 0) & (TCP_K.SND - 1)]);
    return this.o.send({ sport: this.lport, dport: this.rport, seq, ack: flags & ACK ? this.rcvNxt : 0, flags, wnd: this.free(), mss, data }, this.rip);
  }

  /** Everything the state allows now: a SYN, as much data as both windows take, a FIN, else the ACK that is owed. Then the timer's state. */
  output(now: number): void {
    if (this.st === CLOSED || this.st === LISTEN) return;
    if ((this.st === SYN_SENT || this.st === SYN_RCVD) && this.sndNxt === this.iss) {
      if (this.emit(this.st === SYN_SENT ? SYN : SYN | ACK, this.iss, 0, TCP_K.MSS)) {
        this.sndNxt = (this.iss + 1) | 0; this.sndMax = this.sndNxt; this.ackPending = false;
        if (!this.rttOn && this.retries === 0) { this.rttOn = true; this.rttSeq = this.sndNxt; this.rttT = now; }
      }
    }
    let sent = false;
    if (this.st >= ESTABLISHED && this.st !== FIN_WAIT_2 && this.st !== TIME_WAIT) {
      for (;;) {
        const flight = (this.sndNxt - this.sndUna) | 0, win = Math.min(this.cwnd, this.sndWnd), avail = (this.sndEnd - this.sndNxt) | 0;
        let n = Math.max(0, Math.min(this.mss, avail, win - flight));
        // no small segment while one is out when more is waiting (the sender's side of silly window avoidance)
        if (n < this.mss && n < avail && flight !== 0) n = 0;
        const fin = this.finWant && avail >= 0 && n === avail;
        if (n === 0 && !fin) break;
        const end = (this.sndNxt + n) | 0;
        const flags = ACK | (fin ? FIN : 0) | (n > 0 && end === this.sndEnd ? PSH : 0);
        if (!this.emit(flags, this.sndNxt, n)) break;
        const after = (end + (fin ? 1 : 0)) | 0, fresh = lt(this.sndMax, after);
        this.sndNxt = after;
        if (fresh) {
          this.sndMax = after;
          if (!this.rttOn) { this.rttOn = true; this.rttSeq = after; this.rttT = now; }
        }
        sent = true; this.ackPending = false;
        if (fin) break;
      }
    }
    if (this.ackPending && !sent && this.st !== SYN_SENT) {
      if (this.emit(ACK, this.sndNxt, 0)) this.ackPending = false;
    }
    const avail = (this.sndEnd - this.sndNxt) | 0;
    const need = this.sndMax !== this.sndUna || (this.st >= ESTABLISHED && avail > 0 && this.sndWnd === 0);
    if (!need) this.rtoOn = false;
    else if (!this.rtoOn) { this.rtoOn = true; this.rtoAt = (now + this.rto) | 0; }
  }

  private onTimeout(now: number): void {
    this.rtoOn = false;
    const avail = (this.sndEnd - this.sndNxt) | 0;
    if (this.st >= ESTABLISHED && this.sndNxt === this.sndUna && this.sndWnd === 0 && avail > 0) {
      // the zero-window probe: one byte past the window, not a loss, so nothing is cut and it never gives up
      if (this.emit(ACK, this.sndNxt, 1)) {
        this.sndNxt = (this.sndNxt + 1) | 0;
        if (lt(this.sndMax, this.sndNxt)) this.sndMax = this.sndNxt;
      }
      this.rto = Math.min(this.rto * 2, TCP_K.RTO_MAX);
      this.event(now, 'probe');
      return;
    }
    this.retries++;
    if (this.retries > TCP_K.RETRIES) { this.err = true; this.drop(); return; }
    const flight = (this.sndMax - this.sndUna) | 0;
    this.ssthresh = Math.max(flight >> 1, 2 * this.mss);
    this.cwnd = this.mss; this.acc = 0; this.dupacks = 0;
    this.sndNxt = this.sndUna;
    this.rttOn = false;
    this.rto = Math.min(this.rto * 2, TCP_K.RTO_MAX);
    this.event(now, 'timeout');
  }

  tick(now: number): void {
    if (this.st === TIME_WAIT && ((now - this.twAt) | 0) >= 0) { this.drop(); return; }
    if (this.rtoOn && ((now - this.rtoAt) | 0) >= 0) this.onTimeout(now);
    if (this.st !== CLOSED) this.output(now);
  }

  private rst(s: Segment, n: number, to: number): void {
    if (s.flags & RST) return;
    const len = n + (s.flags & SYN ? 1 : 0) + (s.flags & FIN ? 1 : 0);
    this.o.send(s.flags & ACK
      ? { sport: s.dport, dport: s.sport, seq: s.ack, ack: 0, flags: RST, wnd: 0, data: [] }
      : { sport: s.dport, dport: s.sport, seq: 0, ack: (s.seq + len) | 0, flags: RST | ACK, wnd: 0, data: [] }, to);
  }

  private sample(now: number): void {
    const r = (now - this.rttT) | 0;
    if (this.srtt === 0) { this.srtt = r; this.rttvar = r >> 1; }
    else {
      this.rttvar += (Math.abs(this.srtt - r) - this.rttvar) >> 2;
      this.srtt += (r - this.srtt) >> 3;
    }
    this.rto = Math.min(Math.max(this.srtt + 4 * this.rttvar, TCP_K.RTO_MIN), TCP_K.RTO_MAX);
    this.rttOn = false;
    this.event(now, 'sample');
  }

  /** A TCP segment from the layer below (its bytes, from the IP header's end to the datagram's). */
  input(b: ArrayLike<number>, src: number, now: number): void {
    const s = parseSeg(b, src, this.o.ip);
    if (!s) return;
    const syn = (s.flags & SYN) !== 0, rstf = (s.flags & RST) !== 0, ackf = (s.flags & ACK) !== 0;
    let finf = (s.flags & FIN) !== 0, dlen = s.data.length, seq = s.seq, skip = 0;
    if (this.st === CLOSED || s.dport !== this.lport || (this.st !== LISTEN && (src !== this.rip || s.sport !== this.rport))) { this.rst(s, dlen, src); return; }

    if (this.st === LISTEN) {
      if (rstf) return;
      if (ackf) { this.rst(s, dlen, src); return; }
      if (!syn) return;
      this.rip = src; this.rport = s.sport; this.start();
      this.rcvNxt = this.rcvRead = (seq + 1) | 0;
      this.mss = Math.min(TCP_K.MSS, s.mss ?? 536);
      this.sndWnd = s.wnd; this.wl1 = seq; this.wl2 = this.iss;
      this.st = SYN_RCVD;
      this.output(now);
      return;
    }

    if (this.st === SYN_SENT) {
      const good = ackf && s.ack === this.sndNxt;
      if (ackf && !good) { this.rst(s, dlen, src); return; }
      if (rstf) { if (good) { this.err = true; this.drop(); } return; }
      if (!syn) return;
      this.rcvNxt = this.rcvRead = (seq + 1) | 0;
      this.mss = Math.min(TCP_K.MSS, s.mss ?? 536);
      this.sndWnd = s.wnd; this.wl1 = seq; this.wl2 = s.ack;
      if (good) {
        this.sndUna = s.ack; this.st = ESTABLISHED; this.ackPending = true; this.retries = 0;
        if (this.rttOn) this.sample(now);
        this.rtoOn = false;
      } else { this.st = SYN_RCVD; this.sndNxt = this.iss; this.rttOn = false; this.rtoOn = false; }
      this.output(now);
      return;
    }

    // RFC 5961: a reset takes effect only at exactly rcv_nxt, and one elsewhere in the window, or any SYN, is answered with an ACK
    if (rstf) {
      if (seq === this.rcvNxt) { this.err = !(this.passive && this.st === SYN_RCVD); this.drop(); return; }
      if (le(this.rcvNxt, seq) && lt(seq, (this.rcvNxt + this.free()) | 0)) { this.ackPending = true; this.output(now); }
      return;
    }
    if (syn) { this.ackPending = true; this.output(now); return; }
    if (!ackf) return;

    // only the next byte is taken: what lies ahead is dropped, what was seen already is cut off
    const seqlen = dlen + (finf ? 1 : 0), d = (this.rcvNxt - seq) | 0;
    if (d < 0 || (d > 0 && d >= seqlen)) { this.ackPending = true; this.output(now); return; }
    if (d > 0) { skip = d; dlen -= d; seq = this.rcvNxt; }

    if (this.st === SYN_RCVD) {
      if (!lt(this.iss, s.ack) || lt(this.sndMax, s.ack)) { this.rst(s, dlen, src); return; }
      this.sndUna = (this.iss + 1) | 0; this.st = ESTABLISHED; this.retries = 0;
      this.sndWnd = s.wnd; this.wl1 = seq; this.wl2 = s.ack;
      if (this.rttOn) this.sample(now);
      this.rtoOn = false;
    }
    if (lt(this.sndMax, s.ack)) { this.ackPending = true; this.output(now); return; }

    if (lt(this.sndUna, s.ack)) {
      const acked = (s.ack - this.sndUna) | 0;
      this.sndUna = s.ack;
      if (lt(this.sndNxt, this.sndUna)) this.sndNxt = this.sndUna;
      this.retries = 0; this.dupacks = 0; this.rtoOn = false;
      if (this.rttOn && le(this.rttSeq, s.ack)) this.sample(now);
      if (this.cwnd < this.ssthresh) this.cwnd += Math.min(acked, this.mss);
      else {
        this.acc += acked;
        if (this.acc >= this.cwnd) { this.acc -= this.cwnd; this.cwnd += this.mss; }
      }
      if (this.cwnd > TCP_K.SND) this.cwnd = TCP_K.SND;
      this.event(now, 'ack');
    } else if (s.ack === this.sndUna && dlen === 0 && !finf && s.wnd === this.sndWnd && this.sndMax !== this.sndUna) {
      this.dupacks++;
      if (this.dupacks === TCP_K.DUPACKS) {
        // fast retransmit: halve, and go back (no out-of-order queue at the far end to save the rest)
        const flight = (this.sndMax - this.sndUna) | 0;
        this.ssthresh = Math.max(flight >> 1, 2 * this.mss);
        this.cwnd = this.ssthresh; this.acc = 0;
        this.sndNxt = this.sndUna;
        this.rttOn = false; this.rtoOn = false;
        this.event(now, 'fast');
      }
    }
    if (lt(this.wl1, seq) || (this.wl1 === seq && le(this.wl2, s.ack))) { this.sndWnd = s.wnd; this.wl1 = seq; this.wl2 = s.ack; }

    const finAcked = this.finWant && this.sndUna === ((this.sndEnd + 1) | 0);
    if (finAcked) {
      if (this.st === FIN_WAIT_1) this.st = FIN_WAIT_2;
      else if (this.st === CLOSING) { this.st = TIME_WAIT; this.twAt = (now + TCP_K.TIME_WAIT) | 0; }
      else if (this.st === LAST_ACK) { this.drop(); return; }
    }

    if (dlen > 0) {
      this.ackPending = true;
      if (this.st === ESTABLISHED || this.st === FIN_WAIT_1 || this.st === FIN_WAIT_2) {
        const k = Math.min(dlen, this.free());
        for (let i = 0; i < k; i++) this.rb[((this.rcvNxt + i) | 0) & (TCP_K.RCV - 1)] = s.data[skip + i];
        this.rcvNxt = (this.rcvNxt + k) | 0;
        if (k < dlen) finf = false;
      } else finf = false;
    }
    if (finf) {
      this.rcvNxt = (this.rcvNxt + 1) | 0;
      this.finIn = true;
      this.ackPending = true;
      if (this.st === ESTABLISHED) this.st = CLOSE_WAIT;
      else if (this.st === FIN_WAIT_1) this.st = CLOSING;
      else if (this.st === FIN_WAIT_2) { this.st = TIME_WAIT; this.twAt = (now + TCP_K.TIME_WAIT) | 0; }
    }
    this.output(now);
  }
}
