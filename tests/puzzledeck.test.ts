// A campaign program level's code as a deck and back (campaign/puzzledeck.ts): every RV16 level's reference program
// punched, written to a .deck.json, read back, loaded as source, assembled to the same words and data, and graded.

import { describe, expect, it } from 'vitest';
import { deckFromJson, deckToJson, isObjectCard, textCard, wordOf } from '../src/cards/card';
import { DATA_CARD, deckSource, puzzleDeck } from '../src/campaign/puzzledeck';
import { PUZZLES, runPuzzle } from '../src/campaign/puzzles';
import { assemble16 } from '../src/riscv/rv16/asm16';

const rv16 = Object.entries(PUZZLES).filter(([, p]) => !p.nic);
const dataOf = (m: Map<number, number>) => [...m].filter(([, v]) => v).sort((a, b) => a[0] - b[0]);

describe('campaign program decks', () => {
  it('cover every RV16 program level', () => expect(rv16.length).toBeGreaterThan(10));

  it.each(rv16)('%s: the reference punched, saved, read back, loads to the same words and data and still passes', (id, p) => {
    const deck = puzzleDeck(id, p.ref);
    if ('error' in deck) throw new Error(deck.error);
    const back = deckFromJson(deckToJson(deck));
    if (typeof back === 'string') throw new Error(back);
    const src = deckSource(back);
    if (typeof src !== 'string') throw new Error(src.error);
    const a = assemble16(p.ref), b = assemble16(src);
    expect(b.errors).toEqual([]);
    expect(b.words).toEqual(a.words);
    expect(dataOf(b.data)).toEqual(dataOf(a.data));
    expect(runPuzzle(p, src).ok, id).toBe(true);
  });

  it('prints each card with its source line, numbers it, and puts data after a .DATA card', () => {
    const deck = puzzleDeck('t', 'start: li a0, 5\n  add a0, a0, a0   # double\n  halt\n  .data\nv: .word 7, 0, -1\n');
    if ('error' in deck) throw new Error(deck.error);
    expect(deck.cards[0].print).toMatch(/^START: LI A0, 5 +[0-9A-F]{4} +00000010$/);
    const sep = deck.cards.findIndex((c) => c.print === DATA_CARD);
    expect(sep).toBeGreaterThan(0);
    expect(deck.cards.slice(sep + 1).map((c) => wordOf(c, 16))).toEqual([7, 0, 0xffff]);
    expect(deck.cards.slice(0, sep).every((c) => isObjectCard(c, 16))).toBe(true);
  });

  it('refuses what it cannot load or punch', () => {
    expect(puzzleDeck('t', 'bogus a0')).toHaveProperty('error');
    expect(puzzleDeck('t', '# nothing\n')).toHaveProperty('error');
    expect(deckSource({ name: 'text', cards: [textCard('HELLO')] })).toHaveProperty('error');
    const wide = puzzleDeck('t', 'li a0, 1\nhalt\n');
    if ('error' in wide) throw new Error(wide.error);
    wide.cards[0].cols[20] |= 1 << 11; // a row-9 hole past bit 16: a 32-bit word
    expect(deckSource(wide)).toHaveProperty('error');
  });
});
