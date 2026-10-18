// Examples ▸ Boot from cards: the RV32I core's boot ROM reads the card reader's deck into a two-port RAM and
// jumps to it. Compiled from its document, it draws without lint warnings, runs on EditorSim's cycle engine to
// the payload's `j .`, prints what the payload says and holds the deck's words in RAM; a dropped deck loads
// garbage and a sorted one works again. The CPU drawer's golden model stands aside (no card reader in it).

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { type Deck, deckWords, dropDeck, sortDeck } from '../src/cards/card';
import { CARDS_NO_GOLDEN, simHasCardReader } from '../src/editor/cardparts';
import { CpuMonitor, resolveCpu } from '../src/editor/cpu';
import {
  CARDS_LOAD_AT, CARDS_LOADER_SOURCE, CARDS_PAYLOAD_SOURCE, CARDS_RAM_K, CARDS_TEXT, cardsBootChip, cardsDeck,
} from '../src/editor/examplecards';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { consoleText, type ConsoleState, ioNodes, ioState } from '../src/editor/ioparts';
import { UserLibrary } from '../src/editor/library';
import { deadParts, lintChip, openInputs } from '../src/editor/lint';
import { readRam } from '../src/editor/memory';
import { emptyWorkspace, type PartRef, polyline, type Workspace } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { registry } from '../src/lib/define';
import { regenerable } from '../src/lib/resolve';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { breathe } from './setup';

const atLoad = new Set(registry.keys());
const EX = EXAMPLES.find((e) => e.id === 'cardboot')!;

function open(deck?: Deck): { ws: Workspace; id: string; es: EditorSim; lib: UserLibrary } {
  let { ws, id } = addExample(emptyWorkspace(), EX);
  if (deck) ws = { ...ws, chips: { ...ws.chips, [id]: cardsBootChip(id, ws.chips[id].name, deck) } };
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  return { ws, id, es, lib };
}

const con = (es: EditorSim) => consoleText(ioState(es.sim!, ioNodes(es.sim!.design.root).find((x) => x.info.kind === 'console')!.node) as ConsoleState);

async function run(es: EditorSim, cap: number): Promise<void> {
  while (es.cycles < cap && !es.halted) {
    es.runCycles(Math.min(1000, cap - es.cycles), () => es.halted, 1e9);
    await breathe();
  }
}

describe('Examples ▸ Boot from cards', () => {
  it('the loader fits the 32-word boot ROM; the deck is the payload, a word a card, each printed with its source line', () => {
    const boot = assemble(CARDS_LOADER_SOURCE);
    expect(boot.errors).toEqual([]);
    expect(boot.words.length).toBeLessThanOrEqual(32);
    const pay = assemble(CARDS_PAYLOAD_SOURCE);
    const deck = cardsDeck();
    expect(deckWords(deck, 32)).toEqual(pay.words.map((w) => w >>> 0));
    expect(deck.cards.length).toBeLessThanOrEqual(2 ** CARDS_RAM_K);
    expect(deck.cards[1].print).toMatch(/^LI T1, 67 /);
    expect(deck.cards[deck.cards.length - 1].print).toMatch(/^HALT: J HALT /);
    // the payload on the golden model (loaded where the loader puts it, running from there)
    const iss = new ISS(pay.words, { mmio: true });
    iss.run(1000);
    expect(iss.halted).toBe(true);
    expect(iss.console).toBe(CARDS_TEXT);
    expect(CARDS_LOAD_AT & (4 * 2 ** CARDS_RAM_K - 1)).toBe(0); // the RAM's word 0
  });

  it('places only parts a fresh page load resolves, and draws without lint warnings', () => {
    const { ws, id } = addExample(emptyWorkspace(), EX);
    const lib = new UserLibrary(ws);
    const doc = ws.chips[id];
    const lost = doc.parts.flatMap((p) => ('lib' in p.ref && !atLoad.has(p.ref.lib) && !regenerable(p.ref.lib) ? [p.ref.lib] : []));
    expect(lost).toEqual([]);
    const c = lib.compiled(id)!;
    expect(c.diags).toEqual([]);
    const defOf = (p: { ref: PartRef }) => {
      const d = partDef(p.ref, (x) => lib.defOf(x));
      return !d || 'error' in d ? undefined : d;
    };
    const polys = new Map(doc.wires.flatMap((w) => { const p = polyline(doc, w, defOf); return p ? [[w.id, p] as const] : []; }));
    expect(lintChip(doc, c, polys).diags).toEqual([]);
    expect(deadParts(doc, c)).toEqual([]);
    expect(openInputs(c)).toEqual([]);
    expect(doc.notes).toMatch(/0xC000_0000/);
  });

  it('boots from the deck on the cycle engine: the console prints the payload, the RAM holds the deck', async () => {
    const { ws, id, es } = open();
    const mon = new CpuMonitor(es, () => ws.chips[id], () => ws.chips);
    // the drawer sees the core, but its golden model stands aside: it has no card reader
    expect(resolveCpu(ws.chips[id], ws.chips)).toMatchObject({ rom: 'imem', regs: 'cpu.rf' });
    expect(simHasCardReader(es.sim)).toBe(true);
    expect(mon.problem).toBe(CARDS_NO_GOLDEN);
    expect(mon.iss).toBeNull();
    await run(es, 2000);
    expect(es.engine).toBe('cycle');
    expect(es.halted).toBe(true);
    expect(con(es)).toBe(CARDS_TEXT);
    const words = deckWords(cardsDeck(), 32);
    expect(readRam(es.sim!, 'ram')!.slice(0, words.length)).toEqual(words);
    expect(mon.mismatch).toBeNull();
    mon.destroy();
  });

  it('a dropped deck loads garbage; sorted, it boots again (Reset puts the deck back in the hopper)', async () => {
    const deck = cardsDeck();
    const dropped: Deck = { name: deck.name, cards: dropDeck(deck.cards, 7) };
    expect(deckWords(dropped, 32)).not.toEqual(deckWords(deck, 32));
    const { es, id, ws } = open(dropped);
    await run(es, 3000);
    expect(con(es)).not.toBe(CARDS_TEXT);
    expect(readRam(es.sim!, 'ram')!.slice(0, deck.cards.length)).not.toEqual(deckWords(deck, 32));
    // sorted by the sequence numbers in columns 73–80, then Reset and Run
    const sorted = { name: deck.name, cards: sortDeck(dropped.cards) };
    const ws2 = { ...ws, chips: { ...ws.chips, [id]: cardsBootChip(id, ws.chips[id].name, sorted) } };
    const lib2 = new UserLibrary(ws2);
    es.update(lib2.compiled(id)!, ws2.chips[id].pins);
    es.reset();
    await run(es, es.cycles + 2000);
    expect(es.halted).toBe(true);
    expect(con(es)).toBe(CARDS_TEXT);
  });
});
