// The sandbox's card reader part (cards/reader.ts): its deck lives in the document like a ROM's program, so the
// chip saves, shares and undoes it. DOM-free (the tests run in Node; cardui.ts adds its panel).
//
// A card is stored as the deck file's holes (three hex digits a column, column 1 first) with the blank columns
// at its end left off (a source card is mostly blank on the right), and its print. A reader reads the deck in
// word mode (row 9 of the first `bits` columns, one word a card) or column mode (12 bits a column, 80 a card).

import type { ComponentDef } from '../sim/types';
import { blankCard, COLUMNS, type Card, type Deck, MAX_DECK, MAX_WORD_BITS, objectCard, seqText } from '../cards/card';
import { deckReader, MAX_FEED, readerSpecOf, type ReaderMode } from '../cards/reader';

export interface CardDoc {
  /** Three hex digits a column (bit 0 = row 12 … bit 11 = row 9), trailing blank columns dropped. */
  holes: string;
  /** What the keypunch printed along the top (absent: nothing). */
  print?: string;
}

export interface ReaderRef {
  mode: ReaderMode;
  /** Word mode: bits read from row 9 (1–32); kept, but unused, in column mode (12 rows). */
  bits: number;
  /** Clock edges between taking a card and the next one at the read station (0–255). */
  feed: number;
  name: string;
  cards: CardDoc[];
}

export const READER_MAX_CARDS = MAX_DECK;
export const READER_NAME_MAX = 80;

const HOLES = /^(?:[0-9a-f]{3}){0,80}$/;

/** A card as the document stores it. */
export function cardDoc(c: Card): CardDoc {
  let s = c.cols.slice(0, COLUMNS).map((m) => (m & 0xfff).toString(16).padStart(3, '0')).join('');
  while (s.endsWith('000')) s = s.slice(0, -3);
  const print = c.print.slice(0, COLUMNS).replace(/\s+$/, '');
  return print ? { holes: s, print } : { holes: s };
}

/** A stored card as a card (its blank columns put back). */
export function cardOf(d: CardDoc): Card {
  const c = blankCard();
  for (let k = 0; 3 * k < d.holes.length && k < COLUMNS; k++) c.cols[k] = parseInt(d.holes.slice(3 * k, 3 * k + 3), 16) & 0xfff;
  c.print = d.print ?? '';
  return c;
}

export const refDeck = (r: Pick<ReaderRef, 'name' | 'cards'>): Deck => ({ name: r.name, cards: r.cards.map(cardOf) });

/** A reader reference holding `deck`, with the other settings of `like` (a new reader: word mode, 32 bits, no feed delay). */
export function deckRef(deck: Deck, like?: Partial<ReaderRef>): ReaderRef {
  return {
    mode: like?.mode ?? 'word', bits: like?.bits ?? 32, feed: like?.feed ?? 0,
    name: deck.name.slice(0, READER_NAME_MAX), cards: deck.cards.slice(0, READER_MAX_CARDS).map(cardDoc),
  };
}

/** Why a reader reference cannot be built, or null. */
export function readerProblem(r: ReaderRef): string | null {
  if (!r || typeof r !== 'object') return 'card reader: no settings';
  if (r.mode !== 'word' && r.mode !== 'column') return 'card reader: word or column mode';
  if (!Number.isInteger(r.bits) || r.bits < 1 || r.bits > MAX_WORD_BITS) return `card reader: 1–${MAX_WORD_BITS} bits a word`;
  if (!Number.isInteger(r.feed) || r.feed < 0 || r.feed > MAX_FEED) return `card reader: a feed of 0–${MAX_FEED} clock edges`;
  if (!Array.isArray(r.cards) || r.cards.length > READER_MAX_CARDS) return `card reader: at most ${READER_MAX_CARDS} cards`;
  if (!r.cards.every((c) => c && typeof c.holes === 'string' && HOLES.test(c.holes))) return 'card reader: a card\'s holes are three hex digits a column';
  return null;
}

/** Definitions by reference object: an edit makes a new reference, a recompile of the same one costs nothing. */
const built = new WeakMap<ReaderRef, ComponentDef | { error: string }>();

/** The card reader a reference describes (cards/reader.ts, memoized there by what it reads), or why not. */
export function readerRefDef(r: ReaderRef): ComponentDef | { error: string } {
  const hit = built.get(r);
  if (hit) return hit;
  const why = readerProblem(r);
  const d = why ? { error: why } : deckReader(refDeck(r), r.mode, { bits: r.bits, feed: r.feed });
  built.set(r, d);
  return d;
}

/** A reader reference rebuilt field by field from untrusted JSON (store.ts), null when it is broken. */
export function sanitizeReaderRef(x: unknown): ReaderRef | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.cards) || o.cards.length > READER_MAX_CARDS) return null;
  const cards: CardDoc[] = [];
  for (const c of o.cards) {
    const cc = c as Record<string, unknown> | null;
    if (!cc || typeof cc !== 'object' || typeof cc.holes !== 'string') return null;
    const holes = cc.holes.toLowerCase();
    if (!HOLES.test(holes)) return null;
    const print = typeof cc.print === 'string' ? cc.print.slice(0, COLUMNS).replace(/\s+$/, '') : '';
    cards.push(cardDoc({ cols: cardOf({ holes }).cols, print }));
  }
  const r: ReaderRef = {
    mode: o.mode === 'column' ? 'column' : 'word',
    bits: o.bits as number, feed: o.feed as number,
    name: typeof o.name === 'string' ? o.name.slice(0, READER_NAME_MAX) : 'deck',
    cards,
  };
  return readerProblem(r) ? null : r;
}

/** The palette's reader: "HELLO, CARDS" and a new line, one 8-bit character a card (wire data to a console). */
export function sampleReaderRef(): ReaderRef {
  const text = 'HELLO, CARDS\n';
  const cards = [...text].map((ch, i) => objectCard(ch.charCodeAt(0), ch === '\n' ? 'NEW LINE (10)' : `'${ch}'`, seqText(i), 8));
  return deckRef({ name: 'hello', cards }, { bits: 8 });
}

/**
 * A card reader leaf of a circuit the site shows (cards/reader.ts) as a sandbox part: its deck rebuilt from what
 * it reads (word mode: an object card a word; column mode: the columns, 80 a card). The prints are not in the
 * definition, so the cards come back unprinted but for their words.
 */
export function readerRefOf(d: ComponentDef): ReaderRef | null {
  const sp = readerSpecOf(d);
  if (!sp) return null;
  const cards: Card[] = [];
  if (sp.mode === 'word') sp.items.forEach((w, i) => cards.push(objectCard(w, '', seqText(i), sp.bits)));
  else {
    for (let i = 0; i < sp.items.length; i += COLUMNS) {
      const c = blankCard();
      for (let k = 0; k < COLUMNS; k++) c.cols[k] = (sp.items[i + k] ?? 0) & 0xfff;
      cards.push(c);
    }
  }
  return deckRef({ name: sp.name ?? 'deck', cards }, { mode: sp.mode, bits: sp.mode === 'word' ? sp.bits : 32, feed: sp.feed });
}
