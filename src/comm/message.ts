// The on-ramp's arithmetic (DOM-free): how long a message takes, how much is on the line at once, what packets and layers cost, and
// decibels. Nothing here is a model of a particular network; each figure is the definition worked out (tests/comm-message.test.ts).

import { IP_HEADER } from '../net/ipv4';
import { FCS_BYTES, GAP_BYTES, HEADER_BYTES, MIN_FRAME, PREAMBLE } from './ethframe';

/** A TCP header with no options. */
export const TCP_HEADER = 20;
/** What Ethernet adds around a packet: preamble and delimiter, header, check, and the gap after it. */
export const WIRE_OVERHEAD = PREAMBLE.length + 1 + HEADER_BYTES + FCS_BYTES + GAP_BYTES;

/** Signal speed in cable or fibre, about two thirds of light's in vacuum. */
export const LINE_SPEED = 2e8;

/** Seconds to push `bytes` onto a line of `rate` bits a second. */
export const pushTime = (bytes: number, rate: number): number => (bytes * 8) / rate;
/** Seconds for one bit to travel `metres`. */
export const travelTime = (metres: number): number => metres / LINE_SPEED;
/** The whole delay of one message over one link. */
export const delayOf = (bytes: number, rate: number, metres: number): number => pushTime(bytes, rate) + travelTime(metres);
/** Bytes on the line at once: rate × travel time. */
export const onTheLine = (rate: number, metres: number): number => (rate * travelTime(metres)) / 8;

export interface PacketPlan {
  /** The message. */
  bytes: number;
  /** Data bytes a packet carries, and the header each one adds. */
  payload: number;
  header: number;
  /** Bits a second on every link, links in a row, each stored whole before it is sent on. */
  rate: number;
  hops: number;
}

/** How many packets a message makes. */
export const packetCount = (p: Pick<PacketPlan, 'bytes' | 'payload'>): number => Math.max(1, Math.ceil(p.bytes / p.payload));

/** When the last bit arrives (no distance, no other traffic): each packet takes each link in turn, and waits for the one ahead of it. */
export function storeAndForward(p: PacketPlan): number {
  const n = packetCount(p), free = new Array<number>(p.hops).fill(0);
  let done = 0;
  for (let i = 0; i < n; i++) {
    const data = i < n - 1 ? p.payload : p.bytes - p.payload * (n - 1), t = ((data + p.header) * 8) / p.rate;
    let at = 0;
    for (let h = 0; h < p.hops; h++) { at = Math.max(at, free[h]) + t; free[h] = at; }
    done = at;
  }
  return done;
}

/** The chance that a block of `bytes` arrives with no bit wrong. */
export const cleanChance = (bytes: number, ber: number): number => (1 - ber) ** (bytes * 8);

/** Bytes sent on average to deliver the message when a block with a wrong bit is sent again: a whole block, not the whole message. */
export const bytesWithLoss = (p: Pick<PacketPlan, 'bytes' | 'payload' | 'header'>, ber: number): number => {
  const n = packetCount(p), block = p.payload + p.header;
  return (n * block) / cleanChance(block, ber);
};

/** What a page's kilobyte of text costs on Ethernet: the data, each layer's header, and the share of what goes out that is data. */
export function layerCost(data: number): { data: number; pad: number; total: number; share: number } {
  const frame = data + TCP_HEADER + IP_HEADER + HEADER_BYTES + FCS_BYTES, pad = Math.max(0, MIN_FRAME - frame);
  const total = data + pad + TCP_HEADER + IP_HEADER + WIRE_OVERHEAD;
  return { data, pad, total, share: data / total };
}
