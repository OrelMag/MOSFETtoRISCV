// The sandbox's card reader part (editor/cardparts.ts) and decks for ROM programs (editor/deckio.ts,
// cards/program.ts): the part compiles and reads its deck card by card (or column by column) on the editor's
// simulation, the document keeps the deck through the sanitizer, and a ROM's program survives a trip through a deck.

import { describe, expect, it } from 'vitest';
import { blankCard, deckWords, objectCard, programDeck, seqText, textCard } from '../src/cards/card';
import { punchOf } from '../src/cards/hollerith';
import { cardSource, codeOf, deckProgram, programCards, widerCards } from '../src/cards/program';
import { deckReader, readerSpecOf } from '../src/cards/reader';
import { cardDoc, cardOf, deckRef, readerRefDef, readerRefOf, type ReaderRef, refDeck, sampleReaderRef, sanitizeReaderRef } from '../src/editor/cardparts';
import { romDeck, romWithDeck } from '../src/editor/deckio';
import { romImage, type RomRef } from '../src/editor/memory';
import { type ChipDoc } from '../src/editor/model';
import { idPrefix } from '../src/editor/ops';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { sanitizeChip } from '../src/editor/store';
import { assemble } from '../src/riscv/asm';
import { disasm } from '../src/riscv/isa';
import { PROGRAMS } from '../src/riscv/programs';
import { PROGRAMS4 } from '../src/isa4/programs4';
import { RV16_LEDS } from '../src/editor/memory';
import { stats } from '../src/sim/stats';
import { isExternal } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { chip, compileLib, part, pin, wire } from './editorkit';

const clock = (id: string, at: [number, number]) => ({ ...pin(id, 'in', at), kind: 'clock' as const });

/** A reader wired to pins: next and clk in, data / ready / empty out. */
function readerChip(ref: ReaderRef, bits = ref.mode === 'word' ? ref.bits : 12): ChipDoc {
  return chip('u_rd', 'Reader', {
    pins: [pin('next', 'in', [0, 2]), clock('clk', [0, 14]), pin('data', 'out', [30, 2], bits), pin('ready', 'out', [30, 4]), pin('empty', 'out', [30, 6])],
    parts: [part('cr1', { reader: ref }, [8, 0])],
    wires: [wire('w1', 'pin:next', 'cr1.next'), wire('w2', 'pin:clk', 'cr1.clk'), wire('w3', 'cr1.data', 'pin:data'), wire('w4', 'cr1.ready', 'pin:ready'), wire('w5', 'cr1.empty', 'pin:empty')],
  });
}

function run(doc: ChipDoc) {
  const c = compileLib(doc);
  expect(c.diags.filter((d) => d.level === 'error')).toEqual([]);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(c, doc.pins);
  const next = doc.pins.find((p) => p.name === 'next')!;
  const read = () => [pack(es.pinBits('data')!), pack(es.pinBits('ready')!), pack(es.pinBits('empty')!)];
  return { es, read, take(n = 1) { es.setInput(next, n); es.stepOnce(); es.setInput(next, 0); return read(); } };
}

describe('card reader part', () => {
  const words = [0x00a00193, 0xfe0198e3, 0x13, 0xffffffff];
  const deck = programDeck('four', words.map((word) => ({ word, source: disasm(word, 0) })));

  it('is a zero-cost external part, built from the deck in the document', () => {
    const d = partDef({ reader: deckRef(deck) }, () => undefined);
    if ('error' in d) throw new Error(d.error);
    expect(isExternal(d)).toBe(true);
    expect(stats(d)).toMatchObject({ nands: 0, transistors: 0 });
    expect(d).toBe(deckReader(deck, 'word', { bits: 32, feed: 0 }));
    expect(readerSpecOf(d)!.items).toEqual(words);
    expect(idPrefix({ reader: deckRef(deck) })).toBe('cr');
    expect(partDef({ reader: { ...deckRef(deck), bits: 0 } }, () => undefined)).toMatchObject({ error: expect.stringMatching(/bits/) });
    expect(partDef({ reader: { ...deckRef(deck), cards: [{ holes: 'xyz' }] } }, () => undefined)).toMatchObject({ error: expect.stringMatching(/holes/) });
  });

  it('reads its deck card by card in a compiled chip, then says empty', () => {
    const r = run(readerChip(deckRef(deck)));
    expect(r.read()).toEqual([words[0], 1, 0]);
    expect(r.take(0)).toEqual([words[0], 1, 0]); // a clock without next takes nothing
    expect(r.take()).toEqual([words[1], 1, 0]);
    expect(r.take()).toEqual([words[2], 1, 0]);
    expect(r.take()).toEqual([words[3] >>> 0, 1, 0]);
    expect(r.take()).toEqual([0, 0, 1]);
    r.es.reset();
    expect(r.read()).toEqual([words[0], 1, 0]); // Reset puts the deck back in the hopper
  });

  it('waits `feed` edges for the next card, and reads narrow words from row 9', () => {
    const d8 = programDeck('bytes', [0x48, 0x49].map((word) => ({ word })), 8);
    const r = run(readerChip(deckRef(d8, { bits: 8, feed: 2 })));
    expect(r.read()).toEqual([0x48, 1, 0]);
    expect(r.take()).toEqual([0, 0, 0]);
    expect(r.take(0)).toEqual([0, 0, 0]);
    expect(r.take(0)).toEqual([0x49, 1, 0]);
  });

  it('reads column by column in column mode, 80 a card', () => {
    const src = { name: 'src', cards: [textCard('LI A0, 1'), textCard('Z')] };
    const r = run(readerChip(deckRef(src, { mode: 'column' })));
    expect(r.read()).toEqual([punchOf('L'), 1, 0]);
    expect(r.take()[0]).toBe(punchOf('I'));
    expect(r.take()[0]).toBe(0); // the blank column
    expect(r.take()[0]).toBe(punchOf('A'));
    for (let k = 3; k < 80; k++) r.take();
    expect(r.read()).toEqual([punchOf('Z'), 1, 0]);
  });

  it('the palette reader spells HELLO, CARDS in 8-bit words', () => {
    const ref = sampleReaderRef();
    expect(deckWords(refDeck(ref), 8).map((c) => String.fromCharCode(c)).join('')).toBe('HELLO, CARDS\n');
    expect(readerRefDef(ref)).not.toHaveProperty('error');
  });
});

describe('the deck in the document', () => {
  it('stores a card as its holes without the blank columns at the end, and reads it back', () => {
    const c = textCard('HELLO');
    const d = cardDoc(c);
    expect(d.holes.length).toBe(15);
    expect(cardOf(d)).toEqual(c);
    expect(cardDoc(blankCard())).toEqual({ holes: '' });
    const o = objectCard(0x12345678, 'lui x0, 0x12345', seqText(0));
    expect(cardOf(cardDoc(o))).toEqual(o);
  });

  it('survives the sanitizer; broken readers are dropped', () => {
    const ref = deckRef(programDeck('p', [{ word: 1, source: 'one' }, { word: 2 }]), { feed: 3, bits: 16 });
    const c = sanitizeChip({ id: 'u_k', parts: [{ id: 'cr1', ref: { reader: ref }, at: [0, 0] }] })!;
    expect(c.parts[0].ref).toEqual({ reader: ref });
    expect(sanitizeReaderRef({ ...ref, cards: [{ holes: 'ABC', print: 'x  ' }] })).toEqual({ ...ref, cards: [{ holes: 'abc', print: 'x' }] });
    const bad = [{ ...ref, bits: 33 }, { ...ref, feed: -1 }, { ...ref, cards: [{ holes: '12' }] }, { ...ref, cards: 'no' }, { ...ref, feed: 256 }];
    expect(sanitizeChip({ id: 'u_k', parts: bad.map((reader, i) => ({ id: `p${i}`, ref: { reader }, at: [0, 0] })) })!.parts).toEqual([]);
    expect(sanitizeReaderRef({ ...ref, mode: 'column' })!.mode).toBe('column');
  });

  it('a card reader of a circuit the site shows comes into the sandbox with its words (remix)', () => {
    const d = deckReader(programDeck('d', [{ word: 5 }, { word: 6 }]), 'word', { bits: 8, feed: 1 });
    const ref = readerRefOf(d)!;
    expect(ref).toMatchObject({ mode: 'word', bits: 8, feed: 1, name: 'd' });
    expect(readerRefDef(ref)).toBe(d);
    const col = deckReader({ name: 'c', cards: [textCard('AB')] }, 'column');
    expect(readerRefDef(readerRefOf(col)!)).toBe(col);
  });
});

describe('ROM programs as decks', () => {
  const rv32 = (src: string): RomRef => ({ k: 8, w: 32, addr: 'rv32', lang: 'asm', src });

  it('punches one card a word with its source line; a pseudo-instruction\'s later words print their disassembly', () => {
    const src = '  li   t0, 0x12345678   # two words\nloop: j loop\n';
    const d = romDeck(rv32(src), 'li');
    if ('error' in d) throw new Error(d.error);
    expect(d.cards.length).toBe(3);
    expect(deckWords(d)).toEqual(assemble(src).words.map((w) => w >>> 0));
    expect(cardSource(d.cards[0])).toBe('LI T0, 0X12345678');
    expect(cardSource(d.cards[1])).toBe(disasm(assemble(src).words[1], 4).toUpperCase().replace(/\s+/g, ' '));
    expect(cardSource(d.cards[2])).toBe('LOOP: J LOOP');
    expect(romDeck(rv32('bogus x1'), 'x')).toMatchObject({ error: expect.stringMatching(/does not build/) });
  });

  it.each(PROGRAMS.slice(0, 4).map((p) => [p.id, p.source] as const))('RV32 %s: program → deck → program keeps every word and its source', (_id, src) => {
    const r = rv32(src);
    const img = romImage(r);
    const d = romDeck(r, 'p');
    if ('error' in d) throw new Error(d.error);
    expect(deckWords(d)).toEqual(img.words.map((w) => w >>> 0));
    const back = romWithDeck(r, d);
    if ('error' in back) throw new Error(back.error);
    expect(back.lang).toBe('hex');
    expect(romImage(back).words.map((w) => w >>> 0)).toEqual(img.words.map((w) => w >>> 0));
    // each word's line says what its card printed
    const lines = back.src.split('\n').filter((l) => /^0x/.test(l));
    lines.forEach((l, i) => expect(l).toContain(`# ${cardSource(d.cards[i])}`));
    // and the hex program punches the same cards again (sources from its comments)
    const again = romDeck(back, 'p');
    if ('error' in again) throw new Error(again.error);
    expect(again.cards.map((c) => c.print)).toEqual(d.cards.map((c) => c.print));
  });

  it('RV16 and 4-bit CPU programs punch 16-bit words', () => {
    for (const r of [
      { k: 6, w: 16, addr: 'word', lang: 'rv16', src: RV16_LEDS } as RomRef,
      { k: 8, w: 16, addr: 'word', lang: 'cpu4', src: PROGRAMS4[0].src } as RomRef,
    ]) {
      const d = romDeck(r, 'p');
      if ('error' in d) throw new Error(d.error);
      expect(deckWords(d, 16)).toEqual(romImage(r).words);
      expect(widerCards(d, 16)).toEqual([]);
      const back = romWithDeck(r, d);
      if ('error' in back) throw new Error(back.error);
      expect(romImage(back).words).toEqual(romImage(r).words);
    }
  });

  it('refuses a deck whose words are wider than the ROM, and grows a ROM to hold a long deck', () => {
    const d32 = romDeck(rv32(PROGRAMS[0].source), 'p');
    if ('error' in d32) throw new Error(d32.error);
    const narrow: RomRef = { k: 2, w: 16, addr: 'word', lang: 'hex', src: '' };
    expect(romWithDeck(narrow, d32)).toMatchObject({ error: expect.stringMatching(/wider than this ROM's 16 bits/) });
    const long = programDeck('long', Array.from({ length: 40 }, (_, i) => ({ word: i })), 16);
    const back = romWithDeck(narrow, long);
    if ('error' in back) throw new Error(back.error);
    expect(back.k).toBe(6);
    expect(romImage(back).words).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it('a deck as .word lines assembles back to its words (the chapters\' CPU panel)', () => {
    const src = PROGRAMS[0].source;
    const a = assemble(src);
    const d = programCards('fib', src, a.lines.map((l) => ({ word: l.word, srcLine: l.srcLine, dis: disasm(l.word, l.addr) })));
    const text = deckProgram(d, 32, 'asm');
    const b = assemble(text);
    expect(b.errors).toEqual([]);
    expect(b.words.map((w) => w >>> 0)).toEqual(a.words.map((w) => w >>> 0));
    expect(codeOf('loop:  addi x1, x1, 1   # count')).toBe('loop: addi x1, x1, 1');
  });
});
