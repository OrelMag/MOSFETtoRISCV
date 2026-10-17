// The card reader: a deck in its hopper, one card at the read station, cards fed through on request. Like the
// console and PUZZLE IN it is an external part (sim/types isExternal: a behaviour with no structure, zero cost, a
// comment in Verilog) that samples its inputs when its own clk rises, so it works at any depth and on either engine.
//
// Word mode: `data` is the word punched in row 9 of the card at the station (cards/card.ts wordOf), `ready` is 1
// while a card waits there, and next = 1 at a rising clk edge takes it: the next card arrives `feed` edges later
// (a reader moves cards; the IBM 2540 read 800 a minute). `empty` is 1 once the hopper has run out and the last
// card has been taken. Column mode: the same, a 12-bit column at a time (80 a card, the feed delay between cards).
//
// The deck is part of the definition (one definition per deck, like a ROM's program), so a Reset puts it back in
// the hopper. A chapter can still load another one into a running simulation with Sim.poke(loadedReader(…)).

import type { ComponentDef } from '../sim/types';
import type { Sim } from '../sim/sim';
import { COLUMNS, type Deck, deckWords } from './card';

export type ReaderMode = 'word' | 'column';

export interface CardReaderSpec {
  mode: ReaderMode;
  /** Word mode: bits read from row 9 (1–32). Column mode: always 12. */
  bits: number;
  /** Clock edges between taking a card and the next one arriving at the station (0–255). */
  feed: number;
  /** The deck, as the reader reads it: words (word mode) or column masks, 80 a card (column mode). */
  items: number[];
  /** A name for the inspector. */
  name?: string;
}

export interface CardReaderState {
  /** The definition's key: a rebuilt design keeps its position only on the same deck. */
  k: string;
  /** The clk level last seen (-1: none yet). */
  c: number;
  /** What it reads, items per card, and how many items the circuit has taken. */
  q: number[];
  per: number;
  i: number;
  /** Edges until the next card is at the station. */
  wait: number;
  feed: number;
  /** Rising clk edges seen, and reads at an edge with nothing waiting. */
  e: number;
  over: number;
}

export const CARD_READER_PREFIX = 'card_reader_';
export const MAX_FEED = 255;

/** FNV-1a over the items. */
function hashItems(xs: readonly number[]): string {
  let h = 0x811c9dc5;
  for (const x of xs) { h ^= x & 0xffff; h = Math.imul(h, 0x01000193); h ^= (x >>> 16) & 0xffff; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0') + xs.length.toString(16);
}

/** v as an unsigned w-bit word. */
const toW = (v: number, w: number) => (w >= 32 ? v >>> 0 : v & (2 ** w - 1));

const CACHE_SIZE = 16;
const cache = new Map<string, ComponentDef>();
const specs = new WeakMap<ComponentDef, CardReaderSpec>();

/** The items a reader in `mode` reads from a deck. */
export function readerItems(deck: Deck, mode: ReaderMode, bits = 32): number[] {
  return mode === 'word' ? deckWords(deck, bits) : deck.cards.flatMap((c) => c.cols.slice(0, COLUMNS).map((m) => m & 0xfff));
}

export function freshReaderState(spec: CardReaderSpec, key: string): CardReaderState {
  return { k: key, c: -1, q: spec.items.slice(), per: spec.mode === 'word' ? 1 : COLUMNS, i: 0, wait: 0, feed: spec.feed, e: 0, over: 0 };
}

/** A card reader holding `spec.items` (memoized by content: the same deck, the same definition). */
export function cardReader(spec: CardReaderSpec): ComponentDef {
  const bits = spec.mode === 'column' ? 12 : spec.bits;
  if (!Number.isInteger(bits) || bits < 1 || bits > 32) throw new Error('card reader: 1–32 bits');
  const feed = Math.max(0, Math.min(MAX_FEED, Math.floor(spec.feed)));
  const key = `${spec.mode === 'word' ? 'w' : 'c'}${bits}_f${feed}_${hashItems(spec.items)}`;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const sp: CardReaderSpec = { ...spec, bits, feed, items: spec.items.map((x) => toW(x, bits)) };
  const unit = spec.mode === 'word' ? 'card' : 'column';
  const d: ComponentDef = {
    id: `${CARD_READER_PREFIX}${key}`, name: 'Card reader', category: 'plumbing',
    summary: `A deck of ${spec.mode === 'word' ? sp.items.length : sp.items.length / COLUMNS} punched cards${spec.name ? ` (${spec.name})` : ''}. `
      + (spec.mode === 'word' ? `data: the ${bits}-bit word punched in row 9 of the card at the read station, column 1 its most significant bit. `
        : 'data: the 12 rows of the column under the read brushes (bit 0 row 12 … bit 11 row 9). ')
      + `ready: 1 while a ${unit} waits; next = 1 at a rising clk edge takes it${feed ? `, and the next card arrives ${feed} edge${feed > 1 ? 's' : ''} later` : ''}. `
      + 'empty: 1 once the last card has been taken. Reset puts the deck back. Outside the circuit: no gates, nothing in Verilog.',
    ports: [
      { name: 'next', width: 1, dir: 'in', doc: `Takes the ${unit} at the station at the next rising clk edge` },
      { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true, doc: 'Samples next on its rising edge' },
      { name: 'data', width: bits, dir: 'out', doc: spec.mode === 'word' ? 'The word on the card at the station (0 when none)' : 'The column under the brushes (0 when none)' },
      { name: 'ready', width: 1, dir: 'out', doc: `1 while a ${unit} waits at the station` },
      { name: 'empty', width: 1, dir: 'out', doc: '1 once the hopper is empty and the last card taken' },
    ],
    symbol: { kind: 'box', label: 'CARD READER', w: 10, h: 8 },
    behavior: {
      init: () => freshReaderState(sp, key),
      carry: (prev) => {
        const p = prev as CardReaderState | undefined;
        return p && p.k === key ? { ...p, q: p.q.slice() } : freshReaderState(sp, key);
      },
      eval: ([next, clk], s) => {
        const st = s as CardReaderState;
        if (clk === 1 && st.c === 0) {
          st.e++;
          if (st.wait > 0) st.wait--;
          else if (next === 1) {
            if (st.i < st.q.length) {
              st.i++;
              if (st.i % st.per === 0 && st.i < st.q.length) st.wait = st.feed;
            } else st.over++;
          }
        }
        st.c = clk;
        const left = st.i < st.q.length;
        const ready = left && st.wait === 0;
        return [ready ? toW(st.q[st.i], bits) : 0, ready ? 1 : 0, left ? 0 : 1];
      },
    },
  };
  specs.set(d, sp);
  cache.set(key, d);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return d;
}

/** A card reader reading `deck` in `mode`. */
export const deckReader = (deck: Deck, mode: ReaderMode = 'word', opts: { bits?: number; feed?: number } = {}): ComponentDef =>
  cardReader({ mode, bits: opts.bits ?? 32, feed: opts.feed ?? 0, items: readerItems(deck, mode, opts.bits ?? 32), name: deck.name });

/** Which spec a definition is (null for any other definition). */
export const readerSpecOf = (d: ComponentDef | undefined): CardReaderSpec | null => (d && specs.get(d)) ?? null;

/** A reader's state with another deck in its hopper (nothing read yet), keeping the clk level it last saw. */
export function loadedReader(old: CardReaderState, items: readonly number[]): CardReaderState {
  return { ...old, q: items.slice(), i: 0, wait: 0, e: 0, over: 0 };
}

export interface ReaderLeaf { li: number; path: string[]; spec: CardReaderSpec }

/** The card readers of a simulation, at any depth. */
export function readerLeaves(sim: Sim): ReaderLeaf[] {
  const r: ReaderLeaf[] = [];
  sim.design.leaves.forEach((l, li) => {
    const sp = readerSpecOf(l.def);
    if (sp) r.push({ li, path: l.node.path, spec: sp });
  });
  return r;
}

/** Where a reader is in its deck: cards taken (whole), the card at the station (0-based, null when empty), items left. */
export function readerProgress(st: CardReaderState): { taken: number; at: number | null; cards: number; column: number; feeding: boolean } {
  const cards = Math.ceil(st.q.length / st.per);
  const at = st.i < st.q.length ? Math.floor(st.i / st.per) : null;
  return { taken: Math.floor(st.i / st.per), at, cards, column: st.i % st.per, feeding: st.wait > 0 };
}
