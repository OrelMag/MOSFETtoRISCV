// A campaign program level's RV16 code as a deck of punched cards and back (the roadmap's "Cards for the RISC-V CPUs":
// the sandbox's ROMs and the chapters' CPU panel already do it, cards/program.ts). DOM-free.
//
// Saving: one object card a program word, 16 bits along row 9, printed with the source line it came from (a
// pseudo-instruction's later words print their disassembly), numbered 10, 20, … in columns 73–80; then, when the
// program has a .data section, a source card `.DATA` and one object card a data word, from address 0 up. Loading:
// the words as `.word` lines, each with its card's print as a comment, and the data words after `.data`. A deck
// read back assembles to the same program words and data, so it runs and grades as the code it was punched from.
// tests/puzzledeck.test.ts round-trips every RV16 level's reference program.

import { type Card, type Deck, isObjectCard, objectCard, seqText, textCard, wordOf } from '../cards/card';
import { cardSource, programCards, widerCards } from '../cards/program';
import { assemble16 } from '../riscv/rv16/asm16';
import { disasm16 } from '../riscv/rv16/isa16';

/** The source card between a deck's program words and its data words. */
export const DATA_CARD = '.DATA';
const BITS = 16;

const isData = (c: Card) => c.print.trim() === DATA_CARD && !isObjectCard(c, BITS);

/** The level's code as a deck, or why not (it does not assemble, or it is empty). */
export function puzzleDeck(name: string, src: string): Deck | { error: string } {
  const a = assemble16(src);
  if (a.errors.length) return { error: `the code does not assemble (line ${a.errors[0].line}: ${a.errors[0].message})` };
  if (!a.lines.length) return { error: 'the code is empty' };
  const deck = programCards(name, src, a.lines.map((l) => ({ word: l.word, srcLine: l.srcLine, dis: disasm16(l.word, l.addr) })), BITS);
  if (a.data.size) {
    deck.cards.push(textCard(DATA_CARD));
    const top = Math.max(...a.data.keys());
    for (let addr = 0; addr <= top; addr++) {
      const w = a.data.get(addr) ?? 0;
      deck.cards.push(objectCard(w, `data ${addr}: ${(w << 16) >> 16}`, seqText(deck.cards.length), BITS));
    }
  }
  return deck;
}

/**
 * A deck as RV16 source: `.word` lines for the program cards, then `.data` and its words, each line with its card's
 * print as a comment. Refused when a card holds a word wider than 16 bits (a 32-bit deck), or holds no word at all.
 */
export function deckSource(deck: Deck): string | { error: string } {
  const wide = widerCards(deck, BITS);
  if (wide.length) return { error: `card ${wide[0] + 1}${wide.length > 1 ? ` and ${wide.length - 1} more` : ''} hold${wide.length > 1 ? '' : 's'} a word wider than RV16's 16 bits` };
  const n = deck.cards.length;
  const out = [`# deck "${deck.name.replace(/\s+/g, ' ')}": ${n} card${n === 1 ? '' : 's'}, 16-bit words read from row 9`];
  let words = 0, data = false;
  deck.cards.forEach((c, i) => {
    if (isData(c)) {
      if (!data) out.push('        .data');
      data = true;
      return;
    }
    if (!isObjectCard(c, BITS)) {
      out.push(`# card ${i + 1}: ${cardSource(c, BITS) || 'blank'} (no word: left out)`);
      return;
    }
    const s = cardSource(c, BITS);
    out.push(`        .word 0x${wordOf(c, BITS).toString(16).padStart(4, '0')}${s ? `   # ${s.toLowerCase()}` : ''}`);
    words++;
  });
  if (!words) return { error: 'the deck holds no object cards: no words to load' };
  return out.join('\n') + '\n';
}
