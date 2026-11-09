// The routing table as a router's fast path holds it (chapter errors): a binary trie in RAM, one read a level, and the table a next hop
// points into. DOM-free; lib/router.ts walks the same words in gates, and `lpmLinear` is the definition the walk is tested against.
//
// A trie word is 24 bits: hop[23:20] (0: no route ends here), child0[19:10], child1[9:0] (0: no child; node 0 is the root and nobody's
// child). A next-hop entry is 8 bytes at hop · 8: the MAC at +0 … +5, the output port at +6. Entry 0 is the router's own MAC.

import type { Mac } from '../comm/ethframe';

export const TRIE_K = 10, ADJ_K = 7, BUF_K = 11;
export const TRIE_NODES = 1 << TRIE_K;
export const MAX_HOPS = 15;
/** The port meaning "this router": the frame goes up to the slow path. */
export const PORT_CPU = 3;

export interface Route { prefix: number; len: number; hop: number }
export interface NextHop { mac: Mac; port: number }

export const mask = (len: number): number => (len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0);
export const routeMatches = (r: Route, ip: number): boolean => ((ip & mask(r.len)) >>> 0) === ((r.prefix & mask(r.len)) >>> 0);

/** The definition: of the routes that match, the longest wins (0: none). A scan of the whole table. */
export function lpmLinear(routes: readonly Route[], ip: number): number {
  let best = -1, hop = 0;
  for (const r of routes) if (r.len > best && routeMatches(r, ip)) { best = r.len; hop = r.hop; }
  return hop;
}

export const trieWord = (hop: number, c0: number, c1: number): number => ((hop << 20) | (c0 << 10) | c1) >>> 0;
export const hopOf = (w: number): number => w >>> 20;
export const childOf = (w: number, bit: number): number => (bit ? w : w >>> 10) & (TRIE_NODES - 1);

/** The trie's words, node 0 first, for bigRamWithInit. Throws when the table does not fit the memory. */
export function buildTrie(routes: readonly Route[]): number[] {
  const nodes: { hop: number; c: [number, number] }[] = [{ hop: 0, c: [0, 0] }];
  for (const r of routes) {
    if (r.hop < 1 || r.hop > MAX_HOPS) throw new Error(`next hop ${r.hop}: 1 to ${MAX_HOPS}`);
    let n = 0;
    for (let i = 0; i < r.len; i++) {
      const b = (r.prefix >>> (31 - i)) & 1;
      if (!nodes[n].c[b]) {
        if (nodes.length >= TRIE_NODES) throw new Error(`the table needs more than ${TRIE_NODES} nodes`);
        nodes[n].c[b] = nodes.length;
        nodes.push({ hop: 0, c: [0, 0] });
      }
      n = nodes[n].c[b];
    }
    nodes[n].hop = r.hop;
  }
  return nodes.map((x) => trieWord(x.hop, x.c[0], x.c[1]));
}

export interface WalkStep { node: number; word: number; hop: number; bit: number }

/** The walk, a read a level: where it went, the best hop seen, and the reads it took (the root counts). */
export function walkTrie(words: ArrayLike<number>, ip: number): { hop: number; reads: number; path: WalkStep[] } {
  const path: WalkStep[] = [];
  let n = 0, best = 0;
  for (let d = 0; ; d++) {
    const w = words[n] ?? 0, h = hopOf(w), bit = (ip >>> (31 - d)) & 1;
    path.push({ node: n, word: w, hop: h, bit });
    if (h) best = h;
    const c = d === 32 ? 0 : childOf(w, bit);
    if (!c) return { hop: best, reads: d + 1, path };
    n = c;
  }
}

/** The next-hop table's bytes, for bigRamWithInit: `own` at entry 0, then each hop at its index. */
export function adjImage(own: Mac, hops: Readonly<Record<number, NextHop>>): number[] {
  const a = new Array<number>(1 << ADJ_K).fill(0);
  own.forEach((b, i) => { a[i] = b; });
  for (const [h, x] of Object.entries(hops)) {
    x.mac.forEach((b, i) => { a[+h * 8 + i] = b; });
    a[+h * 8 + 6] = x.port;
  }
  return a;
}
