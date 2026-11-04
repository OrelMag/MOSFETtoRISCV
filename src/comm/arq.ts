// Automatic repeat request over a lossy link (DOM-free): stop-and-wait, go-back-N and selective repeat. Time is counted
// in frame times; the one-way propagation delay is `a` frame times, so a frame sent at slot t is fully received at
// t + 1 + a and its (zero-length, never lost) acknowledgement is back at t + 1 + 2a = RTT. A frame is lost with
// probability p, independently per transmission. The closed forms (Stallings, Data and Computer Communications) are
// the expectations of exactly this model, and tests/comm-arq.test.ts holds the seeded simulations to them.

import { rng } from '../phys/line';

export type Proto = 'saw' | 'gbn' | 'sr';
export const PROTO_NAMES: Record<Proto, string> = { saw: 'Stop-and-wait', gbn: 'Go-back-N', sr: 'Selective repeat' };

/** Round trip in frame times: the window that keeps the link busy is this many frames. */
export const rttOf = (a: number): number => 1 + 2 * a;

/** The a of a link: propagation delay over the time one frame takes to send. */
export const aOf = (propSec: number, frameBits: number, bitRate: number): number => propSec / (frameBits / bitRate);

/** The window (frames) that fills the pipe: the bandwidth-delay product in frames, plus the frame being sent. */
export const fullWindow = (a: number): number => Math.ceil(rttOf(a));

/**
 * Closed-form utilization (fraction of the link's frame slots that carry a frame delivered for the first time), Stallings'
 * forms. Exact for stop-and-wait and for go-back-N with W >= 1 + 2a. For go-back-N below that they are an approximation (the
 * simulation is a little higher), and selective repeat reaches 1 - p only when the window is about three round trips: a lost
 * frame is resent one timeout later and acknowledged one round trip after that, and the window cannot slide past it meanwhile.
 */
export function utilization(proto: Proto, a: number, W: number, p: number): number {
  const R = rttOf(a);
  if (proto === 'saw') return (1 - p) / R;
  if (proto === 'gbn') return W >= R ? (1 - p) / (1 + 2 * a * p) : (W * (1 - p)) / (R * (1 - p + W * p));
  return W >= R ? 1 - p : (W * (1 - p)) / R;
}

export interface TxEvent {
  /** The slot the frame is sent in. */
  t: number;
  seq: number;
  /** A retransmission of a frame sent before. */
  retx: boolean;
  /** Did it arrive intact? */
  ok: boolean;
  /** Receiver discards it although intact (go-back-N: out of order). */
  discarded: boolean;
}

export interface ArqRun {
  proto: Proto;
  slots: number;
  /** Frames delivered in order. */
  delivered: number;
  /** Transmissions, retransmissions included. */
  sent: number;
  /** delivered / slots. */
  u: number;
  /** Mean transmissions per delivered frame. */
  perFrame: number;
  events: TxEvent[];
}

/**
 * Send `frames` frames. `record`: keep the first that many transmissions as events (for the timeline). a must make
 * 1 + 2a an integer (the model has whole slots), W >= 1 (stop-and-wait ignores it).
 */
export function simulate(proto: Proto, a: number, W: number, p: number, frames: number, seed = 1, record = 0): ArqRun {
  const R = Math.round(rttOf(a)), win = proto === 'saw' ? 1 : Math.max(1, Math.floor(W));
  const u = rng(seed);
  const lastTx = new Array<number>(frames).fill(-Infinity), acked = new Array<boolean>(frames).fill(false), sentOnce = new Array<boolean>(frames).fill(false);
  const acks = new Map<number, number[]>(); // slot -> sequence numbers whose ack arrives then
  const events: TxEvent[] = [];
  let base = 0, next = 0, exp = 0, sent = 0, t = 0;
  while (base < frames) {
    // acknowledgements arriving at the start of this slot
    for (const i of acks.get(t) ?? []) {
      if (proto === 'gbn') base = Math.max(base, i + 1);
      else acked[i] = true;
    }
    acks.delete(t);
    if (proto !== 'gbn') while (base < frames && acked[base]) base++;
    if (base >= frames) break;
    let seq = -1;
    if (proto === 'gbn') {
      if (next > base && t >= lastTx[base] + R) next = base; // timeout on the oldest: go back
      if (next < frames && next < base + win) seq = next++;
    } else {
      for (let i = base; i < Math.min(frames, base + win); i++) if (!acked[i] && sentOnce[i] && t >= lastTx[i] + R) { seq = i; break; } // oldest timed-out first
      if (seq < 0 && next < frames && next < base + win) seq = next++;
    }
    if (seq >= 0) {
      const retx = sentOnce[seq], ok = u() >= p;
      let discarded = false;
      sentOnce[seq] = true; lastTx[seq] = t; sent++;
      if (ok) {
        if (proto === 'gbn') { if (seq === exp) exp++; else discarded = true; }
        if (!discarded) { const at = t + R; if (!acks.has(at)) acks.set(at, []); acks.get(at)!.push(seq); }
      }
      if (events.length < record) events.push({ t, seq, retx, ok, discarded });
    }
    t++;
  }
  return { proto, slots: t, delivered: frames, sent, u: frames / t, perFrame: sent / frames, events };
}

/** Mean time (frame times) from the first transmission of a frame to its acknowledgement, with timeout = RTT: a geometric number of tries. */
export const meanDeliveryTime = (a: number, p: number): number => 1 + 2 * a + (p / (1 - p)) * rttOf(a);
