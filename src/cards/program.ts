// Programs as decks of object cards and back, shared by the sandbox (a ROM's program, the card reader) and the
// chapters' CPU panel. DOM-free.
//
// Saving: one object card a word (cards/card.ts objectCard), printed with the line of source it came from, as a
// keypunch listing would: a pseudo-instruction's later words print their disassembly instead of the line again.
// Loading: the words punched in row 9, one a line, each with what its card printed as a comment, so a deck read
// back into an editor still says what every word was.

import { commentStart } from '../riscv/asm';
import { MAX_WORD_BITS, type Card, type Deck, isObjectCard, programDeck, wordOf } from './card';
import { ROW9 } from './hollerith';

/** A word of an assembled program: its 1-based source line (0: none) and, optionally, its disassembly. */
export interface SourceWord { word: number; srcLine: number; dis?: string }

/** The code part of a source line: the comment cut off (#, // or ;), blanks squeezed. */
export function codeOf(line: string): string {
  return line.slice(0, commentStart(line)).replace(/\s+/g, ' ').trim();
}

/** The comment of a source line (after #, // or ;), or ''. */
export function commentOf(line: string): string {
  const i = commentStart(line);
  return i < line.length ? line.slice(i).replace(/^(#|;|\/\/)\s*/, '').replace(/\s+/g, ' ').trim() : '';
}

/**
 * A program as a deck of object cards, one a word, numbered 10, 20, … `hex`: the source is a hex listing, so a
 * card prints its line's comment (what the word is), not the hex digits it would repeat.
 */
export function programCards(name: string, src: string, words: readonly SourceWord[], bits = 32, hex = false): Deck {
  const text = src.replace(/\r/g, '').split('\n');
  let last = -1;
  return programDeck(name, words.map((w) => {
    const raw = w.srcLine > 0 ? text[w.srcLine - 1] ?? '' : '';
    const first = w.srcLine > 0 && w.srcLine !== last;
    last = w.srcLine;
    const own = first ? (hex ? commentOf(raw) : codeOf(raw)) : '';
    return { word: w.word >>> 0, source: own || w.dis };
  }), bits);
}

/** What a card says it is: an object card the text left of its hex word, any other card its whole print. */
export function cardSource(card: Card, bits = 32): string {
  return (isObjectCard(card, bits) ? card.print.slice(0, 40) : card.print).replace(/\s+/g, ' ').trim();
}

/**
 * A deck as program text: one word a line, as hex words ('hex', a ROM's hex language) or `.word` lines ('asm',
 * for an assembler), each with its card's printed source as a comment.
 */
export function deckProgram(deck: Deck, bits = 32, style: 'hex' | 'asm' = 'hex'): string {
  const d = Math.ceil(bits / 4);
  const n = deck.cards.length;
  const head = `# deck "${deck.name.replace(/\s+/g, ' ')}": ${n} card${n === 1 ? '' : 's'}, ${bits}-bit words read from row 9`;
  return [head, ...deck.cards.map((c) => {
    const w = `0x${wordOf(c, bits).toString(16).padStart(d, '0')}`;
    const s = cardSource(c, bits);
    return style === 'asm' ? `        .word ${w}${s ? `   # ${s}` : ''}` : `${w}${s ? `  # ${s}` : ''}`;
  })].join('\n') + '\n';
}

/**
 * Cards whose words are wider than `bits` (a row-9 hole in columns bits+1 … 32 of an object card): a 32-bit
 * deck read as 16-bit words would lose half of every word. Their indices.
 */
export function widerCards(deck: Deck, bits: number): number[] {
  const out: number[] = [];
  deck.cards.forEach((c, i) => {
    if (!isObjectCard(c, MAX_WORD_BITS)) return;
    for (let b = bits; b < MAX_WORD_BITS; b++) if (c.cols[b] & ROW9) { out.push(i); return; }
  });
  return out;
}

/**
 * The narrowest common word width (8, 16 or 32 bits) holding every object card's word: the last row-9 hole in
 * the word columns tells. 0 for a deck with no object card. A guess (a 16-bit deck of even words reads as 15
 * bits), good enough to set a reader that would otherwise cut the words off.
 */
export function deckBits(deck: Deck): number {
  let last = 0;
  for (const c of deck.cards) {
    if (!isObjectCard(c, MAX_WORD_BITS)) continue;
    for (let b = MAX_WORD_BITS - 1; b >= last; b--) if (c.cols[b] & ROW9) { last = b + 1; break; }
  }
  return last === 0 ? 0 : last <= 8 ? 8 : last <= 16 ? 16 : 32;
}
