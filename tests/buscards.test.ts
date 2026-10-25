import { describe, expect, it } from 'vitest';
import { cardBootTime } from '../src/bus/cardboot';
import { BusModel, CardModel } from '../src/bus/model';
import { CARD_BOOT_SOURCE, CARD_FEED, CARD_PAYLOAD_SOURCE, LOAD_AT } from '../src/bus/programs';
import { type Deck, deckWords, dropDeck, inSequence, sortDeck } from '../src/cards/card';
import { type CardReaderState, deckReader, readerProgress } from '../src/cards/reader';
import { AXI_CARDS, slavePorts } from '../src/lib/axi';
import { ramLeafState } from '../src/lib/bigmem';
import { asmDeck, busComputer, CARD_COMPUTER, CARD_DECK, cardComputer, CHAPTER_COMPUTER, SYSTEM_COMPUTER, socDevices, type SocOptions } from '../src/lib/soc';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { ComponentDef } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { cardComputerScene } from '../src/widgets/bus';

// Chapter 38's card computer: the card reader's slave alone against the golden model's CardModel, then the whole
// computer booting from a deck at gate level in lock-step with the golden model (bus/model.ts: the reader is the
// one device that needs the edge count, BusModel.now).

const words = (src: string) => {
  const a = assemble(src);
  if (a.errors.length) throw new Error(a.errors[0].message);
  return a.words;
};

/** The slave and a reader holding `items`, the slave's bus side as pins. */
function slaveBench(items: number[], feed: number): ComponentDef {
  const reader = deckReaderOf(items, feed);
  const sp = slavePorts();
  return {
    id: `t_cardslave_${reader.id}`, name: 'card slave bench', category: 'memory',
    ports: [...sp, { name: 'clk', width: 1, dir: 'in', clock: true }, { name: 'next', width: 1, dir: 'out' }, { name: 'empty', width: 1, dir: 'out' }],
    symbol: { kind: 'box' },
    netlist: () => ({
      instances: [{ name: 'port', def: AXI_CARDS, at: [10, 0] }, { name: 'cards', def: reader, at: [60, 0] }],
      nets: [
        ...sp.map((p) => (p.dir === 'in' ? { ends: [p.name, `port.${p.name}`] } : { ends: [`port.${p.name}`, p.name] })),
        { ends: ['clk', 'port.clk', 'cards.clk'] },
        { ends: ['port.next', 'cards.next', 'next'] },
        { ends: ['cards.data', 'port.data'] }, { ends: ['cards.ready', 'port.ready'] }, { ends: ['cards.empty', 'port.empty', 'empty'] },
      ],
    }),
  };
}

/** A reader whose cards hold these words (object cards: their words read back exactly). */
const deckReaderOf = (items: number[], feed: number) => deckReader(asmDeck('t', items.map((w) => `.word 0x${w.toString(16)}`).join('\n')), 'word', { feed });

function slaveRunner(items: number[], feed: number) {
  const sim = new GateSim(flatten(slaveBench(items, feed)));
  sim.reset('zero');
  for (const p of slavePorts()) if (p.dir === 'in') sim.setInput(p.name, 0);
  sim.setInput('rready', 1); sim.setInput('bready', 1); sim.setInput('clk', 0);
  sim.settle();
  const out = (p: string) => pack(sim.getBits(sim.design.root.ports[p])) >>> 0;
  let edges = 0, nexts = 0;
  const edge = () => {
    if (out('next') === 1) nexts++;
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    edges++;
  };
  /** A read: the address handshake at the next edge, the answer the cycle after; returns it and the handshake's edge. */
  const read = (addr: number) => {
    sim.setInput('arvalid', 1); sim.setInput('araddr', addr); sim.settle();
    expect(out('arready')).toBe(1);
    edge();
    const at = edges;
    sim.setInput('arvalid', 0); sim.settle();
    expect(out('rvalid')).toBe(1);
    const v = out('rdata');
    edge();
    return { v, at };
  };
  return { sim, out, edge, read, edges: () => edges, nexts: () => nexts };
}

describe('the card reader slave', () => {
  it('STATUS, DATA, a read takes the card, the feed delay, then the hopper empty', () => {
    const feed = 3, r = slaveRunner([0xcafe0001, 0x12345678], feed);
    expect(r.read(0x70000000).v).toBe(1); // a card waits, the hopper is not empty
    expect(r.read(0x70000004).v).toBe(0xcafe0001);
    expect(r.nexts()).toBe(1); // next was 1 for one cycle, after the read's handshake
    // the read took the card at the edge that completed the answer; the next arrives feed edges later
    expect(r.read(0x70000000).v).toBe(0);
    r.edge();
    expect(r.read(0x70000000).v).toBe(1);
    expect(r.read(0x70000004).v).toBe(0x12345678);
    expect(r.read(0x70000000).v).toBe(2); // the last card taken: empty, nothing waits
    expect(r.read(0x70000004).v).toBe(0);
    expect(r.nexts()).toBe(2);
  });

  it('a write is answered and dropped', () => {
    const r = slaveRunner([7], 0);
    r.sim.setInput('awvalid', 1); r.sim.setInput('wvalid', 1); r.sim.setInput('awaddr', 0x70000004); r.sim.setInput('wdata', 99); r.sim.settle();
    expect(r.out('awready')).toBe(1);
    r.edge();
    r.sim.setInput('awvalid', 0); r.sim.setInput('wvalid', 0); r.sim.settle();
    expect(r.out('bvalid')).toBe(1);
    r.edge();
    expect(r.read(0x70000000).v).toBe(1);
    expect(r.read(0x70000004).v).toBe(7);
  });

  it.each([0, 1, 5, 8])('answers as the golden model\'s CardModel, reads at random times (feed %i)', (feed) => {
    const items = Array.from({ length: 6 }, (_, i) => (0x1000 * (i + 1) + feed) >>> 0);
    const r = slaveRunner(items, feed), m = new CardModel(items, feed);
    let x = 12345 + feed;
    const rnd = (n: number) => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return (x >>> 16) % n; };
    for (let k = 0; k < 80; k++) {
      for (let i = rnd(4); i > 0; i--) r.edge();
      const data = rnd(3) === 0;
      const { v, at } = r.read(data ? 0x70000004 : 0x70000000);
      // the slave latched the reader's outputs before the handshake's edge: its state after at − 1 edges
      expect(v, `${data ? 'DATA' : 'STATUS'} read at edge ${at}`).toBe(data ? m.data(at - 1) : m.status(at - 1));
    }
    expect(m.empty(r.edges())).toBe(true);
  });
});

/**
 * The card computer at gate level, the golden model in lock-step after every retired instruction; it stops
 * 40 cycles after the console has printed `done`.
 */
function runCards(deck: Deck, done: string, feed = CARD_FEED, max = 6000, lock = true) {
  const o: SocOptions = { cards: deck, cardFeed: feed };
  const program = words(CARD_BOOT_SOURCE);
  const def = busComputer(program, [], o);
  const sim = new GateSim(flatten(def));
  sim.reset('zero');
  sim.setInput('clk', 0); sim.setInput('switches', 0); sim.settle();
  const bus = new BusModel(12, [], 4096, socDevices(o));
  const iss = new ISS(program, { system: true, imemWords: 2 ** 7, bus });
  const root = sim.design.root, node = (...p: string[]) => p.reduce((n, k) => n.children!.get(k)!, root);
  const rf = node('cpu', 'rf');
  const out = (p: string) => pack(sim.getBits(root.ports[p]));
  const regs = () => [0, ...Array.from({ length: 31 }, (_, i) => pack(sim.getBits(rf.children!.get(`w${i + 1}`)!.ports.q)) >>> 0)];
  let cycles = 0, gateConsole = '', booted = -1, retired = 0, printed = -1;
  for (; cycles < max && (printed < 0 || cycles < printed + 40); cycles++) {
    if (printed < 0 && gateConsole === done) printed = cycles;
    const retire = out('retire') === 1;
    if (out('consoleValid') === 1) gateConsole += String.fromCharCode(out('consoleData'));
    if (booted < 0 && (out('pcOut') >>> 0) === LOAD_AT) booted = cycles;
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    if (!retire) continue;
    retired++;
    if (!lock) continue;
    bus.now = cycles + 1; // the edge this instruction retired at
    const info = iss.step();
    const x = regs();
    for (let r = 1; r < 32; r++) expect(x[r], `x${r} after ${info.text} at 0x${info.pc.toString(16)} (cycle ${cycles})`).toBe(iss.x[r] >>> 0);
    expect(out('pcOut') >>> 0, `pc after ${info.text} (cycle ${cycles})`).toBe(iss.pc >>> 0);
  }
  const ramLanes = [0, 1, 2, 3].map((i) => ramLeafState(sim, node('ram', `lane${i}`))!);
  const ram = (i: number) => ((ramLanes[0].mem[i] | (ramLanes[1].mem[i] << 8) | (ramLanes[2].mem[i] << 16) | (ramLanes[3].mem[i] << 24)) >>> 0);
  const reader = sim.leafState(node('cards').leafIndex!) as CardReaderState;
  return { iss, bus, cycles, booted, retired, gateConsole, ram, reader, def };
}

describe('booting from cards: chapter 38\'s computer with a card reader', () => {
  it('the boot ROM reads the deck into RAM and runs it, in lock-step with the golden model', () => {
    const r = runCards(CARD_DECK, 'CARDS\n');
    expect(r.def).toBe(CARD_COMPUTER);
    expect(r.gateConsole).toBe('CARDS\n');
    expect(r.iss.console).toBe('CARDS\n');
    const ws = deckWords(CARD_DECK);
    expect(ws).toEqual(words(CARD_PAYLOAD_SOURCE));
    for (let i = 0; i < ws.length; i++) expect(r.ram(LOAD_AT / 4 + i), `RAM word ${i}`).toBe(ws[i]);
    expect(readerProgress(r.reader)).toMatchObject({ taken: ws.length, at: null, cards: ws.length });
    expect(r.bus.cards!.i).toBe(ws.length);
    expect(r.booted).toBeGreaterThan(ws.length * CARD_FEED); // every card waited for the feed
    expect(r.iss.x[10]).toBeGreaterThan(0); // the LEDs count
    expect(cardBootTime(ws, CARD_FEED).cycles, 'the boot time the chapter quotes, from the golden model').toBe(r.booted);
  });

  it.each([0, 3, 21])('the boot loader and the golden model agree with a feed of %i edges', (feed) => {
    const deck = asmDeck('short', 'li t0, 0x80000000\nli t1, 33\nsw t1, 0(t0)\nhalt: j halt');
    const r = runCards(deck, '!', feed, 1200 + 40 * feed);
    expect(r.gateConsole).toBe('!');
    expect(cardBootTime(deckWords(deck), feed).cycles).toBe(r.booted);
  });

  it('a dropped deck boots once the sorter has put it back in sequence order', () => {
    const dropped = dropDeck(CARD_DECK.cards, 7);
    expect(inSequence(dropped)).toBe(false);
    expect(deckWords({ name: 'x', cards: dropped })).not.toEqual(deckWords(CARD_DECK));
    const sorted: Deck = { name: 'sorted', cards: sortDeck(dropped) };
    expect(inSequence(sorted.cards)).toBe(true);
    expect(cardComputer(sorted)).toBe(CARD_COMPUTER); // the same words, the same reader, the same computer
    const r = runCards(sorted, 'CARDS\n', CARD_FEED, 4000, false);
    expect(r.gateConsole).toBe('CARDS\n');
  });

  it('leaves the chapter\'s other computers as they were', () => {
    expect(CHAPTER_COMPUTER.id).toBe('soc_sys_rom_d3ec4879_bus_axiflash_11_d5a49738_12_0');
    expect(SYSTEM_COMPUTER.id).toBe('soc_sys_rom_70ec4879_bus_axiflash_49_6edc009e_12_0_dram_scr_kbd');
    expect(CHAPTER_COMPUTER.netlist!().instances.some((i) => i.name === 'cards')).toBe(false);
  });

  it('runs on the cycle engine and boots as at gate level', () => {
    const scene = cardComputerScene();
    expect(scene.engine).toBe('cycle');
    const design = flatten(scene.root, { mode: 'gate', expand: (d, n) => n.parent === null || !d.preferBehavior });
    const sim = new DualSim(design);
    sim.preferFast = true;
    for (const [k, v] of Object.entries(scene.inputs ?? {})) sim.setInput(k, v);
    sim.reset('zero'); sim.settle(); sim.prepare();
    expect(sim.whyNot, 'the cycle engine takes it').toBe('');
    const out = (p: string) => pack(sim.getBits(design.root.ports[p]));
    let text = '';
    for (let c = 0; c < 4000 && !text.endsWith('\n'); c++) {
      if (out('consoleValid') === 1) text += String.fromCharCode(out('consoleData'));
      sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    }
    expect(sim.engine).toBe('cycle');
    expect(text).toBe('CARDS\n');
  });
});
