// A ROM's program as a deck of punched cards and back (cards/program.ts does the cards; this pairs them with the
// sandbox's ROM parts). DOM-free. Saving punches one object card a word with the source line it came from; loading
// replaces the program with the deck's words as hex, each with its card's printed source as a comment.

import type { Deck } from '../cards/card';
import { programCards, deckProgram, widerCards } from '../cards/program';
import { kFor, romImage, type RomRef } from './memory';

/** parts.ts MAX_ROM_K (parts.ts imports memory.ts, which this file imports too). */
const MAX_K = 16;

/** The program of a ROM as object cards, a word a card (`w` bits each), or why not (it does not build). */
export function romDeck(r: RomRef, name: string): Deck | { error: string } {
  const img = romImage(r);
  if (img.problems.length) return { error: `the program does not build (${img.problems[0].line ? `line ${img.problems[0].line}: ` : ''}${img.problems[0].message})` };
  if (!img.lines.length) return { error: 'the program is empty' };
  // Hex words carry no source of their own (a line's comment says what they are), nor does a hex word's RV32
  // disassembly mean anything in a narrower ROM.
  const hex = r.lang === 'hex';
  return programCards(name, r.src, img.lines.map((l) => ({ word: l.word, srcLine: l.srcLine, dis: hex ? undefined : l.text || undefined })), r.w, hex);
}

/**
 * A ROM holding the deck's words instead of its program: hex words with the cards' sources as comments, the ROM
 * grown to hold them (never shrunk). Refused when a card holds a word wider than the ROM's.
 */
export function romWithDeck(r: RomRef, deck: Deck): RomRef | { error: string } {
  const wide = widerCards(deck, r.w);
  if (wide.length) return { error: `card ${wide[0] + 1}${wide.length > 1 ? ` and ${wide.length - 1} more` : ''} hold${wide.length > 1 ? '' : 's'} a word wider than this ROM's ${r.w} bits` };
  const k = Math.max(r.k, kFor(deck.cards.length));
  if (k > MAX_K) return { error: `${deck.cards.length} cards do not fit in the largest ROM (${2 ** MAX_K} words)` };
  const { isa: _isa, ...rest } = r;
  return { ...rest, k, lang: 'hex', src: deckProgram(deck, r.w, 'hex') };
}
