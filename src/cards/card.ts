// Punched cards and decks (prologue P3, the sandbox's card reader, programs exported as decks). DOM-free.
//
// A card is 80 column masks (cards/hollerith.ts: bit 0 = row 12 … bit 11 = row 9) and the line a keypunch printed
// along its top edge. Two kinds are made here:
// - a source card: a line of text, one character a column in the 029 code (what a programmer punched);
// - an object card: one machine word, punched in binary along row 9 (column 1 its most significant bit, 32 columns
//   for 32 bits), its source line and the word in hex printed along the top, and a sequence number in columns 73–80
//   as on real decks, so that a dropped deck can be put back in order on a sorter.
// Real machines read binary cards in their own layouts (the IBM 704 read each row as two 36-bit words, "row binary");
// one word along one row keeps a card readable at a glance, and a reader that reads one row is the smallest.

import { ROW9, charOf, punchOf } from './hollerith';

export const COLUMNS = 80;
/** Columns 73–80: the sequence number (the 029 left them out of the program). */
export const SEQ_FROM = 72, SEQ_LEN = 8;
/** Object cards number in steps of 10, as programmers did, so a card can be slipped in between. */
export const SEQ_STEP = 10;
/** Widest word an object card holds (one bit a column of row 9, leaving the sequence columns free). */
export const MAX_WORD_BITS = 32;

export interface Card {
  /** 80 column masks. */
  cols: number[];
  /** What the keypunch printed along the top (at most 80 characters; '' for a card punched by hand). */
  print: string;
}

export interface Deck {
  name: string;
  cards: Card[];
}

export const blankCard = (): Card => ({ cols: new Array<number>(COLUMNS).fill(0), print: '' });

/** A source card: `text` punched in the 029 code, a character a column (upper-cased; past 80 cut off). */
export function textCard(text: string): Card {
  const s = text.toUpperCase().slice(0, COLUMNS);
  const cols = new Array<number>(COLUMNS).fill(0);
  for (let i = 0; i < s.length; i++) cols[i] = punchOf(s[i]) ?? punchOf('?')!;
  return { cols, print: s.replace(/\s+$/, '') };
}

/** The characters of a card's columns ('·' where a column is no character), trailing blanks dropped. */
export function textOf(card: Card): string {
  return card.cols.map((m) => charOf(m) ?? '·').join('').replace(/\s+$/, '');
}

/** Characters in `text` the 029 cannot punch (each once, in order). */
export function unpunchable(text: string): string[] {
  const bad: string[] = [];
  for (const ch of text.toUpperCase()) if (punchOf(ch) === null && !bad.includes(ch)) bad.push(ch);
  return bad;
}

const hex = (w: number, bits: number) => (w >>> 0).toString(16).toUpperCase().padStart(Math.ceil(bits / 4), '0');

/** The sequence number of the n-th card (0-based): 00000010, 00000020, … */
export const seqText = (n: number): string => String((n + 1) * SEQ_STEP).padStart(SEQ_LEN, '0');

/**
 * An object card: `word` (bits wide, ≤ 32) in binary along row 9 from column 1 (most significant bit first),
 * `seq` punched and printed in columns 73–80, and `source` with the word in hex printed along the top.
 */
export function objectCard(word: number, source: string, seq: string, bits = 32): Card {
  if (bits < 1 || bits > MAX_WORD_BITS) throw new Error(`object cards hold 1–${MAX_WORD_BITS} bits`);
  const cols = new Array<number>(COLUMNS).fill(0);
  for (let b = 0; b < bits; b++) if ((word >>> (bits - 1 - b)) & 1) cols[b] |= ROW9;
  const s = seq.slice(-SEQ_LEN).padStart(SEQ_LEN, '0');
  for (let k = 0; k < SEQ_LEN; k++) cols[SEQ_FROM + k] = punchOf(s[k]) ?? 0;
  const src = source.replace(/\s+/g, ' ').trim().toUpperCase();
  const left = `${src.slice(0, 38).padEnd(40)}${hex(word, bits)}`;
  return { cols, print: left.slice(0, SEQ_FROM).padEnd(SEQ_FROM) + s };
}

/** The word an object card holds: row 9 of its first `bits` columns, column 1 the most significant bit. */
export function wordOf(card: Card, bits = 32): number {
  let w = 0;
  for (let b = 0; b < bits; b++) w = (w * 2) + ((card.cols[b] & ROW9) ? 1 : 0);
  return bits >= 32 ? w >>> 0 : w;
}

/** The sequence number punched in columns 73–80, or null when they are not all digits. */
export function seqOf(card: Card): number | null {
  let s = '';
  for (let k = 0; k < SEQ_LEN; k++) {
    const c = charOf(card.cols[SEQ_FROM + k]);
    if (c === null || !/[0-9 ]/.test(c)) return null;
    s += c;
  }
  return s.trim() ? Number(s.trim()) : null;
}

/** Is it an object card (sequence-numbered, nothing but row 9 in its word columns)? */
export function isObjectCard(card: Card, bits = 32): boolean {
  for (let b = 0; b < bits; b++) if (card.cols[b] & ~ROW9 & 0xfff) return false;
  return seqOf(card) !== null;
}

/** One source line per word (missing or blank lines print as `.word 0x…`). */
export interface ProgramLine { word: number; source?: string }

/** A program as a deck of object cards, one word a card, numbered 10, 20, … */
export function programDeck(name: string, lines: readonly ProgramLine[], bits = 32): Deck {
  return {
    name,
    cards: lines.map((l, i) => objectCard(l.word, l.source?.trim() || `.word 0x${hex(l.word, bits).toLowerCase()}`, seqText(i), bits)),
  };
}

/** The words of a deck, card by card in the order it lies (a reader in word mode). */
export const deckWords = (deck: Deck, bits = 32): number[] => deck.cards.map((c) => wordOf(c, bits));

/** A source deck: one card a line of `text` (blank lines kept: a blank card). */
export function sourceDeck(name: string, text: string): Deck {
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return { name, cards: lines.map(textCard) };
}

/** The cards sorted by their sequence numbers, as a card sorter would (unnumbered cards last, in their order). */
export function sortDeck(cards: readonly Card[]): Card[] {
  return cards.map((c, i) => ({ c, i, s: seqOf(c) }))
    .sort((a, b) => (a.s ?? Infinity) - (b.s ?? Infinity) || a.i - b.i)
    .map((x) => x.c);
}

/** Is the deck in sequence order (every card numbered, the numbers rising)? */
export function inSequence(cards: readonly Card[]): boolean {
  let last = -Infinity;
  for (const c of cards) {
    const s = seqOf(c);
    if (s === null || s <= last) return false;
    last = s;
  }
  return true;
}

/** The deck dropped on the floor: the cards in a seeded random order (a small LCG, so tests can repeat it). */
export function dropDeck(cards: readonly Card[], seed = 1): Card[] {
  const a = cards.slice();
  let x = (seed >>> 0) || 1;
  for (let i = a.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- files -------------------------------------------------------------------------------------
// A deck saved as JSON: { "format": "punched-cards", "version": 1, "name": …, "cards": [{ "holes": …, "print": … }] },
// each card's holes as 80 columns of three hex digits (240 characters), column 1 first.

export const DECK_FORMAT = 'punched-cards';
export const DECK_EXT = '.deck.json';
/** Most cards a deck file may hold (a long box held 2 000). */
export const MAX_DECK = 4096;

export function deckToJson(deck: Deck): string {
  return JSON.stringify({
    format: DECK_FORMAT, version: 1, name: deck.name,
    cards: deck.cards.map((c) => ({ holes: c.cols.map((m) => (m & 0xfff).toString(16).padStart(3, '0')).join(''), print: c.print })),
  }, null, 1);
}

/** Read a deck file; a string says what is wrong with it. */
export function deckFromJson(text: string): Deck | string {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return 'not a JSON file'; }
  const d = o as { format?: unknown; name?: unknown; cards?: unknown };
  if (!d || typeof d !== 'object' || d.format !== DECK_FORMAT) return 'not a deck of cards (no "format": "punched-cards")';
  if (!Array.isArray(d.cards)) return 'the deck has no cards';
  if (d.cards.length > MAX_DECK) return `more than ${MAX_DECK} cards`;
  const cards: Card[] = [];
  for (let i = 0; i < d.cards.length; i++) {
    const c = d.cards[i] as { holes?: unknown; print?: unknown };
    if (!c || typeof c.holes !== 'string' || !/^[0-9a-fA-F]{240}$/.test(c.holes)) return `card ${i + 1}: holes must be 240 hex digits`;
    const cols: number[] = [];
    for (let k = 0; k < COLUMNS; k++) cols.push(parseInt(c.holes.slice(3 * k, 3 * k + 3), 16));
    cards.push({ cols, print: typeof c.print === 'string' ? c.print.slice(0, COLUMNS) : '' });
  }
  return { name: typeof d.name === 'string' ? d.name.slice(0, 80) : 'deck', cards };
}

/** Does a dropped or picked file look like a deck (by name)? */
export const isDeckFile = (name: string): boolean => name.toLowerCase().endsWith(DECK_EXT);
