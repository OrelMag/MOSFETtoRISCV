// A router's fast path, cycle by cycle (chapter errors): the golden model lib/router.ts is compared with at every output of every clock.
//
// One frame at a time on comm/ethframe.ts's stream, from the destination address on, without FCS. RX: the bytes go into the packet
// buffer while the header's facts are collected, a byte a cycle. DECIDE: one cycle turns them into drop, up to the slow path, or a route
// lookup. WALK: the trie, a read a cycle (net/trie.ts). ADJ: the next hop's port. TX: the buffer read back; a forwarded frame takes the
// next hop's MAC, the router's own as source, TTL − 1 and the checksum's incremental update (net/ipv4.ts).
//
// It holds a whole frame before the first byte leaves (store and forward), and takes no byte meanwhile (ready = 0): one engine, no
// queue, so a second frame waits at the sender. Our simplifications, named in the chapter: no options, no fragmentation, one MAC.

import { ttlChecksum } from './ipv4';
import { BUF_K, childOf, hopOf, PORT_CPU, TRIE_NODES } from './trie';

export const S_RX = 0, S_DECIDE = 1, S_WALK = 2, S_ADJ = 3, S_TX = 4;
export const STATE_NAMES = ['RX', 'DECIDE', 'WALK', 'ADJ', 'TX'];

/** Why a frame left this way; 0 is forwarded. */
export const C_FORWARD = 0, C_NOT_IP = 1, C_OPTIONS = 2, C_TTL = 3, C_NO_ROUTE = 4, C_LOCAL = 5, C_BROADCAST = 6;
export const CAUSE_NAMES = ['forwarded', 'not IPv4', 'IP options', 'TTL expired', 'no route', 'for this router', 'broadcast'];

export const ACT_DROP = 0, ACT_PUNT = 1, ACT_WALK = 2;

export interface Flags { me: number; bcast: number; len14: number; isIp: number; r34: number; ip45: number; sumOk: number; ttlOk: number }

/** DECIDE's table: the order of the tests is the order a frame can fail them. */
export function verdict(f: Flags): { act: number; cause: number } {
  if (!(f.me || f.bcast) || !f.len14) return { act: ACT_DROP, cause: 0 };
  if (!f.isIp) return { act: ACT_PUNT, cause: C_NOT_IP };
  if (!f.r34) return { act: ACT_DROP, cause: 0 };
  if (!f.ip45) return { act: ACT_PUNT, cause: C_OPTIONS };
  if (!f.sumOk) return { act: ACT_DROP, cause: 0 };
  if (f.bcast) return { act: ACT_PUNT, cause: C_BROADCAST };
  if (!f.ttlOk) return { act: ACT_PUNT, cause: C_TTL };
  return { act: ACT_WALK, cause: 0 };
}

/** What the header decoder says about a byte's position (frame offsets: IP starts at 14). */
export const posOf = (i: number) => ({
  mac: i < 6, src: i >= 6 && i < 12, i12: i === 12, i13: i === 13, i14: i === 14, i22: i === 22, i24: i === 24, i25: i === 25,
  dst: i >= 30 && i < 34, hdr: i >= 14 && i < 34, i33: i === 33, idx: i < 6 ? i : i >= 6 && i < 12 ? i - 6 : 0,
});

export interface FpIn { rxd: number; rxv: number; rxl: number; txr: number; cfgWe?: number; cfgT?: number; cfgA?: number; cfgD?: number }
export interface FpOut { rxr: number; txd: number; txv: number; txl: number; port: number; cause: number; state: number }

export class FastPathModel {
  buf = new Uint8Array(1 << BUF_K);
  trie: Uint32Array;
  adj: Uint8Array;
  s = S_RX;
  i = 0; len = 0;
  meBad = 0; bBad = 0; len14 = 0; typeBad = 0; r34 = 0; verBad = 0;
  ttl = 0; chk = 0; dst = 0; sum = 0; c = 0;
  n = 0; best = 0; depth = 0;
  rw = 0; port = 0; cause = 0;

  constructor(trie: ArrayLike<number>, adj: ArrayLike<number>) {
    this.trie = new Uint32Array(TRIE_NODES); this.trie.set(Array.from(trie));
    this.adj = new Uint8Array(128); this.adj.set(Array.from(adj));
  }

  flags(): Flags {
    const sumOk = (this.sum >>> 1) === 0x7fff && (this.sum & 1) !== this.c ? 1 : 0;
    return { me: this.meBad ? 0 : 1, bcast: this.bBad ? 0 : 1, len14: this.len14, isIp: this.typeBad ? 0 : 1, r34: this.r34, ip45: this.verBad ? 0 : 1, sumOk, ttlOk: this.ttl >= 2 ? 1 : 0 };
  }

  outputs(): FpOut {
    const tx = this.s === S_TX, p = posOf(this.i);
    let d = this.buf[this.i];
    if (this.rw) {
      if (p.mac) d = this.adj[this.best * 8 + p.idx];
      else if (p.src) d = this.adj[p.idx];
      else if (p.i22) d = (this.ttl - 1) & 255;
      else if (p.i24) d = ttlChecksum(this.chk) >> 8;
      else if (p.i25) d = ttlChecksum(this.chk) & 255;
    }
    return { rxr: this.s === S_RX ? 1 : 0, txd: tx ? d : 0, txv: tx ? 1 : 0, txl: tx && this.i === this.len ? 1 : 0, port: this.port, cause: this.cause, state: this.s };
  }

  private clear(): void {
    this.s = S_RX; this.i = 0; this.meBad = this.bBad = this.len14 = this.typeBad = this.r34 = this.verBad = 0;
    this.sum = 0; this.c = 0; this.rw = 0;
  }

  /** One rising edge with these inputs. */
  step(x: FpIn): void {
    const cfgTrie = x.cfgWe && !x.cfgT, cfgAdj = x.cfgWe && x.cfgT;
    const trieA = cfgTrie ? x.cfgA! & (TRIE_NODES - 1) : this.n, word = this.trie[trieA];
    const portIn = this.adj[this.best * 8 + 6] & 3;
    const s = this.s;
    if (s === S_RX && x.rxv) {
      const b = x.rxd, p = posOf(this.i);
      this.buf[this.i] = b;
      if (p.mac) { if (b !== this.adj[p.idx]) this.meBad = 1; if (b !== 0xff) this.bBad = 1; }
      if (p.i12 && b !== 0x08) this.typeBad = 1;
      if (p.i13) { if (b !== 0) this.typeBad = 1; this.len14 = 1; }
      if (p.i14 && b !== 0x45) this.verBad = 1;
      if (p.i22) this.ttl = b;
      if (p.i24) this.chk = (b << 8) | (this.chk & 255);
      if (p.i25) this.chk = (this.chk & 0xff00) | b;
      if (p.dst) this.dst = ((this.dst << 8) | b) >>> 0;
      if (p.hdr) {
        const t = this.sum + (this.i & 1 ? b : b << 8) + this.c;
        this.sum = t & 0xffff; this.c = t >> 16;
      }
      if (p.i33) this.r34 = 1;
      if (x.rxl) { this.len = this.i; this.i = 0; this.s = S_DECIDE; } else this.i = (this.i + 1) & ((1 << BUF_K) - 1);
    } else if (s === S_DECIDE) {
      const v = verdict(this.flags());
      this.cause = v.cause; this.n = 0; this.best = 0; this.depth = 0;
      if (v.act === ACT_DROP) this.clear();
      else if (v.act === ACT_PUNT) { this.port = PORT_CPU; this.s = S_TX; } else this.s = S_WALK;
    } else if (s === S_WALK) {
      const bit = this.dst >>> 31, child = childOf(word, bit), best = hopOf(word) || this.best;
      this.best = best;
      if (this.depth === 32 || child === 0) {
        if (best === 0) { this.cause = C_NO_ROUTE; this.port = PORT_CPU; this.s = S_TX; } else this.s = S_ADJ;
      } else { this.n = child; this.depth++; this.dst = (this.dst << 1) >>> 0; }
    } else if (s === S_ADJ) {
      this.port = portIn;
      if (portIn === PORT_CPU) this.cause = C_LOCAL;
      else { this.cause = C_FORWARD; this.rw = 1; }
      this.s = S_TX;
    } else if (s === S_TX && x.txr) {
      if (this.i === this.len) this.clear(); else this.i++;
    }
    if (cfgTrie) this.trie[x.cfgA! & (TRIE_NODES - 1)] = x.cfgD! & 0xffffff;
    if (cfgAdj) this.adj[x.cfgA! & 127] = x.cfgD! & 255;
  }
}
