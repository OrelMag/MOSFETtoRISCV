import { describe, expect, it } from 'vitest';
import { CHARSET, ROWS, charOf, punchOf, rowsOfChar } from '../src/cards/hollerith';
import {
  COLUMNS, deckFromJson, deckToJson, deckWords, dropDeck, inSequence, isObjectCard, objectCard, programDeck, seqOf, sortDeck,
  sourceDeck, textCard, textOf, unpunchable, wordOf,
} from '../src/cards/card';
import { type CardReaderState, cardReader, deckReader, loadedReader, readerProgress } from '../src/cards/reader';
import { bench } from '../src/chapters/types';
import { evalOnce, simulate } from '../src/sim/harness';

describe('Hollerith code (IBM 029)', () => {
  it('punches digits in one row, letters as zone + digit', () => {
    expect(rowsOfChar('0')).toBe('0');
    expect(rowsOfChar('7')).toBe('7');
    expect(rowsOfChar('A')).toBe('12-1');
    expect(rowsOfChar('I')).toBe('12-9');
    expect(rowsOfChar('J')).toBe('11-1');
    expect(rowsOfChar('R')).toBe('11-9');
    expect(rowsOfChar('S')).toBe('0-2');
    expect(rowsOfChar('Z')).toBe('0-9');
    expect(rowsOfChar('/')).toBe('0-1');
    expect(rowsOfChar('.')).toBe('12-3-8');
    expect(rowsOfChar('=')).toBe('6-8');
    expect(rowsOfChar(' ')).toBe('');
    expect(rowsOfChar('a')).toBe('12-1');
    expect(punchOf('~')).toBeNull();
  });

  it('is one to one: every code reads back as its character, at most three holes', () => {
    const seen = new Set<number>();
    for (const ch of CHARSET) {
      const m = punchOf(ch)!;
      expect(charOf(m)).toBe(ch);
      expect(seen.has(m)).toBe(false);
      seen.add(m);
      let holes = 0;
      for (let i = 0; i < ROWS.length; i++) if (m & (1 << i)) holes++;
      expect(holes).toBeLessThanOrEqual(3);
    }
    expect(CHARSET.length).toBe(63);
  });
});

describe('cards and decks', () => {
  it('a source card reads back as its text', () => {
    const c = textCard('      LI   T0, 0X80000000  # CONSOLE');
    expect(c.cols.length).toBe(COLUMNS);
    expect(textOf(c)).toBe('      LI   T0, 0X80000000  # CONSOLE');
    expect(textOf(textCard('hello'))).toBe('HELLO');
    expect(unpunchable('a{b}~')).toEqual(['{', '}', '~']);
  });

  it('an object card holds its word in row 9 and its sequence number in 73–80', () => {
    for (const w of [0, 1, 0x00a00193, 0xfe0198e3, 0xffffffff, 0x80000000]) {
      const c = objectCard(w, 'addi x3, x0, 10', '00000030');
      expect(wordOf(c)).toBe(w >>> 0);
      expect(seqOf(c)).toBe(30);
      expect(isObjectCard(c)).toBe(true);
      expect(c.print.length).toBe(80);
      expect(c.print.endsWith('00000030')).toBe(true);
    }
    const c16 = objectCard(0xbeef, 'x', '00000010', 16);
    expect(wordOf(c16, 16)).toBe(0xbeef);
    expect(c16.cols[16]).toBe(0); // nothing past the word
    expect(isObjectCard(textCard('HELLO'))).toBe(false);
  });

  it('a dropped deck sorts back into program order by its sequence numbers', () => {
    const words = Array.from({ length: 40 }, (_, i) => (i * 0x9e3779b9) >>> 0);
    const deck = programDeck('t', words.map((word) => ({ word })));
    expect(inSequence(deck.cards)).toBe(true);
    const dropped = dropDeck(deck.cards, 7);
    expect(inSequence(dropped)).toBe(false);
    expect(deckWords({ name: 't', cards: sortDeck(dropped) })).toEqual(words);
    expect(deck.cards[0].print).toContain('.WORD 0X');
  });

  it('saves and loads a deck file', () => {
    const deck = { name: 'mix', cards: [...programDeck('p', [{ word: 0x12345678, source: 'lui x0, 0x12345' }]).cards, ...sourceDeck('s', 'HELLO\n\nWORLD\n\n').cards] };
    expect(deck.cards.length).toBe(4);
    const back = deckFromJson(deckToJson(deck));
    expect(back).toEqual(deck);
    expect(deckFromJson('{}')).toMatch(/not a deck/);
    expect(deckFromJson('nope')).toMatch(/JSON/);
    expect(deckFromJson(JSON.stringify({ format: 'punched-cards', cards: [{ holes: 'zz' }] }))).toMatch(/card 1/);
  });
});

describe('card reader', () => {
  const deck = programDeck('three', [{ word: 0x11 }, { word: 0x22 }, { word: 0x33 }]);

  /** Clock a reader on a bench: one full cycle per call, `next` held for it; returns [data, ready, empty] after the edge. */
  function runner(def = deckReader(deck, 'word', { feed: 2 })) {
    const sim = simulate(bench(def));
    sim.reset?.('zero');
    let out = evalOnce(sim, [0, 0]);
    return {
      sim, first: out,
      cycle(next: number) { evalOnce(sim, [next, 0]); out = evalOnce(sim, [next, 1]); evalOnce(sim, [0, 1]); return evalOnce(sim, [0, 0]); },
    };
  }

  it('hands out the deck card by card, waits for the feed, then says empty', () => {
    const r = runner();
    expect(r.first).toEqual([0x11, 1, 0]);
    expect(r.cycle(1)).toEqual([0, 0, 0]); // card taken, the next one is on its way (2 edges)
    expect(r.cycle(1)).toEqual([0, 0, 0]); // next is ignored while feeding
    expect(r.cycle(0)).toEqual([0x22, 1, 0]);
    expect(r.cycle(0)).toEqual([0x22, 1, 0]);
    expect(r.cycle(1)).toEqual([0, 0, 0]);
    r.cycle(0);
    expect(r.cycle(0)).toEqual([0x33, 1, 0]);
    expect(r.cycle(1)).toEqual([0, 0, 1]); // the last card: no feed, empty at once
    expect(r.cycle(1)).toEqual([0, 0, 1]);
  });

  it('reads column by column in column mode, 80 to a card', () => {
    const d = cardReader({ mode: 'column', bits: 12, feed: 0, items: [...textCard('A1').cols, ...textCard('Z').cols] });
    const r = runner(d);
    expect(r.first).toEqual([punchOf('A'), 1, 0]);
    expect(r.cycle(1)[0]).toBe(punchOf('1'));
    for (let k = 2; k < 80; k++) expect(r.cycle(1)[0]).toBe(0);
    expect(r.cycle(1)[0]).toBe(punchOf('Z'));
  });

  it('memoizes by deck, and a poke loads another deck', () => {
    expect(deckReader(deck)).toBe(deckReader(programDeck('again', deck.cards.map((c) => ({ word: wordOf(c) })))));
    const r = runner(deckReader(deck));
    const li = r.sim.design.leaves.findIndex((l) => l.def.id.startsWith('card_reader_'));
    const st = r.sim.leafState(li) as CardReaderState;
    r.sim.poke(li, loadedReader(st, [0x99]));
    expect(evalOnce(r.sim, [0, 0])).toEqual([0x99, 1, 0]);
    expect(readerProgress(r.sim.leafState(li) as CardReaderState)).toMatchObject({ taken: 0, at: 0, cards: 1 });
  });
});
