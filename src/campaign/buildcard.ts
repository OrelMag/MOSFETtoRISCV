// Act P's last level, "Program on cards": a 4-bit CPU with an empty program memory and its program in a card reader,
// one instruction a card. The learner builds the loader (an address counter, a write per card, the end of the deck,
// a run flag that hands the memory to the CPU and lets its clock through). Given: the reader with its deck, the RAM
// and the CPU core (lib/cpu4.ts CPU4_CORE). The bench loads two decks (the reader's own and a second one it puts in
// the hopper), checks the memory once run rises and the outputs at halt against the golden model, and prices the
// learner's logic in relays (lib/tech.ts: a coil per NAND, one more per four more contacts); the given parts are free.
// No DOM.

import type { BuildChallenge, CustomRun, LibRule, PinSpec } from '../editor/challenges';
import { deckRef, type ReaderRef } from '../editor/cardparts';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc, PartDoc, PartRef } from '../editor/model';
import { partDef } from '../editor/parts';
import { programDeck } from '../cards/card';
import { CARD_READER_PREFIX, type CardReaderState, loadedReader, readerLeaves } from '../cards/reader';
import { assemble4 } from '../isa4/asm4';
import { Iss4 } from '../isa4/iss4';
import { MULTIPLY4 } from '../isa4/programs4';
import { isRamState, ramWords } from '../lib/bigmem';
import { Builder } from '../lib/builder';
import { busMux2 } from '../lib/combinational';
import { CPU4_CORE, IO4_OUTS } from '../lib/cpu4';
import { AND, NOT } from '../lib/gates';
import { counter, DFF } from '../lib/sequential';
import { price } from '../lib/tech';
import { TIE0, TIE1 } from '../lib/transistors';
import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import { B0, B1, type ComponentDef, netlistOf } from '../sim/types';

/** Clock edges between taking a card and the next one at the read station. */
export const LOADER_FEED = 3;

/** The deck in the given reader: a loop, a decimal adjust and three output ports, so every word matters. */
export const LOADER_SUM = `; 1 + 2 + 3 + 4 + 5 = 15 in decimal on digits 2 and 3, the count on the LEDs
        FIM  P0, 0x0B      ; R0 = 0: the tens; R1 = 11: ISZ counts it to 0 in five turns
        CLB                ; A = 0: the ones; CY = 0
loop:   INC  R2            ; R2 = 1, 2, 3, 4, 5
        ADD  R2            ; A = A + R2 (CY is 0 here)
        DAA                ; past 9: + 6 and CY = 1
        JCN  C0, next      ; no carry: on
        INC  R0            ; a carry into the tens
        CLC
next:   ISZ  R1, loop
        XCH  R3            ; R3 = the ones
        FIM  P7, 0x20      ; digit 2: the tens
        SRC  P7
        LD   R0
        WRR
        FIM  P7, 0x30      ; digit 3: the ones
        SRC  P7
        LD   R3
        WRR
        FIM  P7, 0x40      ; the LEDs: how many numbers
        SRC  P7
        LD   R2
        WRR
done:   JUN  done`;

export interface LoaderDeck { name: string; words: number[]; ref: ReaderRef }

function loaderDeck(name: string, src: string): LoaderDeck {
  const a = assemble4(src);
  if (a.errors.length) throw new Error(`loader deck ${name}: ${a.errors[0].message}`);
  const text = new Map(a.lines.map((l) => [l.addr, l.text]));
  const deck = programDeck(name, a.words.map((word, i) => ({ word, source: text.get(i) })), 16);
  return { name, words: a.words, ref: deckRef(deck, { bits: 16, feed: LOADER_FEED }) };
}

let decks: LoaderDeck[] | null = null;
/** The bench's decks: the one in the given reader, then one the bench puts in its hopper (one card longer). */
export function loaderDecks(): LoaderDeck[] {
  return (decks ??= [loaderDeck('sum', LOADER_SUM), loaderDeck('multiply', MULTIPLY4)]);
}

const RAM_REF: PartRef = { ram: { k: 8, w: 16 } };
const ZERO4_REF: PartRef = { const: { width: 4, value: 0 } };
const built = (r: PartRef): ComponentDef => {
  const d = partDef(r, () => undefined);
  if ('error' in d) throw new Error(d.error);
  return d;
};
let readerPart: PartRef | null = null;
/** The given reader's part reference (one object, so its definition is one object too: cardparts.ts memoizes by reference). */
const readerRef = (): PartRef => (readerPart ??= { reader: loaderDecks()[0].ref });

/** The given parts' definitions (the reader with the first deck, the RAM) and the switches' constant 0. */
export const loaderParts = (): { reader: ComponentDef; ram: ComponentDef; zero4: ComponentDef } =>
  ({ reader: built(readerRef()), ram: built(RAM_REF), zero4: built(ZERO4_REF) });

/** Parts placed in the level's chip: the reader with its deck, the program RAM and the CPU core (ids as in the reference). */
export function loaderGiven(): PartDoc[] {
  return [
    { id: 'reader', ref: readerRef(), at: [8, 6], label: 'card reader' },
    { id: 'ram', ref: RAM_REF, at: [36, 6], label: 'program memory' },
    { id: 'cpu', ref: { lib: CPU4_CORE.id }, at: [62, 4], label: '4-bit CPU' },
  ];
}

/** What the loader may be built from: NAND and a few unlocked conveniences, constants, and the given parts. */
export const LOADER_RULE: LibRule = {
  lib: ['nand', 'not', 'and', 'or', 'dff', 'counter8', 'mux2x8', CPU4_CORE.id, 'ram256x16'],
  label: 'NAND, NOT, AND, OR, D flip-flops, an 8-bit counter, an 8-bit 2:1 mux, constants and the given parts',
  strict: true,
};

export const LOADER_PORTS: PinSpec[] = [
  { name: 'clk', dir: 'in', width: 1, clock: true },
  { name: 'run', dir: 'out', width: 1 },
  { name: 'halt', dir: 'out', width: 1 },
  ...IO4_OUTS.map((n): PinSpec => ({ name: n, dir: 'out', width: 4 })),
];

// ---- relays: the learner's logic without the given parts ---------------------------------------

const isUserChip = (d: ComponentDef) => d.category === 'custom' && d.id.startsWith('u_');
const isGiven = (d: ComponentDef, ram: ComponentDef) => d === CPU4_CORE || d === ram || d.id.startsWith(CARD_READER_PREFIX);
const logicMemo = new WeakMap<ComponentDef, ComponentDef>();

/** A user chip without the CPU core, the program RAM and card readers, at any depth (their nets lose those ends). */
export function loaderLogic(def: ComponentDef): ComponentDef {
  const hit = logicMemo.get(def);
  if (hit) return hit;
  const nl = netlistOf(def);
  if (!nl || !isUserChip(def)) return def;
  const ram = built(RAM_REF);
  const drop = new Set(nl.instances.filter((i) => isGiven(i.def, ram)).map((i) => i.name));
  const keep = (end: string) => !end.includes('.') || !drop.has(end.slice(0, end.indexOf('.')));
  const d: ComponentDef = {
    ...def, id: `${def.id}~logic`, preferBehavior: false, behavior: undefined,
    netlist: () => ({
      ...nl,
      instances: nl.instances.filter((i) => !drop.has(i.name)).map((i) => ({ ...i, def: loaderLogic(i.def) })),
      nets: nl.nets.map((n) => ({ ...n, ends: n.ends.filter(keep), via: undefined, tags: undefined })).filter((n) => n.ends.length),
    }),
  };
  logicMemo.set(def, d);
  return d;
}

/** How many CPU cores and program RAMs a user chip places, at any depth (each is free once: the given one). */
function givenCounts(def: ComponentDef, ram: ComponentDef): { cpu: number; ram: number } {
  const n = { cpu: 0, ram: 0 };
  const walk = (d: ComponentDef) => {
    for (const i of netlistOf(d)?.instances ?? []) {
      if (i.def === CPU4_CORE) n.cpu++;
      else if (i.def === ram) n.ram++;
      else if (isUserChip(i.def)) walk(i.def);
    }
  };
  walk(def);
  return n;
}

/** Relays of the learner's logic: a coil per NAND, one more for every four contacts past the first four. */
export const loaderRelays = (def: ComponentDef): number => price(loaderLogic(def), 'relay', null)?.devices ?? 0;

// ---- the bench ---------------------------------------------------------------------------------

/** Cycles allowed after the last card before run must have risen, and after the golden model's steps before halt. */
const LOAD_SLACK = 16, RUN_SLACK = 32;

export function runLoader(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode !== 'gate') return { failures: ['the loader is logic: NAND gates, the unlocked parts and the given ones (a transistor or relay part makes the chip switch level)'], tested: 0 };
  const sim = new GateSim(flatten(def, { mode: 'gate' }));
  const readers = readerLeaves(sim);
  if (readers.length !== 1) return { failures: [readers.length ? 'one card reader, please: the given one' : 'the card reader is missing: it was given in the chip'], tested: 0 };
  const rd = readers[0];
  if (rd.spec.mode !== 'word' || rd.spec.bits !== 16) return { failures: ['the card reader must read 16-bit words (word mode), as given'], tested: 0 };
  const ramDef = built(RAM_REF);
  const n = givenCounts(def, ramDef);
  if (n.cpu !== 1 || n.ram !== 1) {
    const what = (k: number, one: string) => (k ? `one ${one}, please: the given one (there are ${k})` : `the ${one} is missing: it was given in the chip`);
    return { failures: [...(n.cpu !== 1 ? [what(n.cpu, '4-bit CPU')] : []), ...(n.ram !== 1 ? [what(n.ram, 'program memory (256 × 16 RAM)')] : [])], tested: 0 };
  }
  const ramLeaf = sim.design.leaves.findIndex((l) => l.def === ramDef);

  const port = (p: string): number => {
    const bits = sim.getBits(sim.design.root.ports[p]);
    return bits.every((x) => x === B0 || x === B1) ? bits.reduce((a: number, x, i) => a + (x === B1 ? 2 ** i : 0), 0) : -1;
  };
  const show = (v: number) => (v < 0 ? 'X' : String(v));
  const cycle = () => {
    sim.setInput('clk', 1);
    sim.settle();
    sim.setInput('clk', 0);
    sim.settle();
    if (sim.unstable) throw new Error('it does not settle (it oscillates)');
  };

  const failures: string[] = [];
  const failed: number[] = [];
  let cycles = 0;
  loaderDecks().forEach((deck, k) => {
    const fail = (msg: string) => {
      failures.push(`deck “${deck.name}” (${deck.words.length} cards): ${msg}`);
      failed.push(k);
    };
    sim.setInput('clk', 0);
    sim.reset('zero');
    // The deck in the hopper and the reader's feed as given, whatever the part was set to.
    const st = sim.leafState(rd.li) as CardReaderState;
    sim.poke(rd.li, { ...loadedReader(st, deck.words), per: 1, feed: LOADER_FEED });
    sim.settle();
    const cards = deck.words.length;
    const loadLimit = 1 + (cards - 1) * (LOADER_FEED + 1) + LOAD_SLACK;
    let c = 0, emptyAt = -1;
    for (;;) {
      const r = port('run');
      const left = (() => { const s = sim.leafState(rd.li) as CardReaderState; return s.q.length - s.i; })();
      if (r === 1 && left > 0) return fail(`run = 1 after ${c} cycles with ${left} card${left > 1 ? 's' : ''} still in the reader`);
      if (r === 1) break;
      if (!left && emptyAt < 0) emptyAt = c;
      if (r < 0 && c > 0) return fail(`run is X after ${c} cycles`);
      if (c >= loadLimit) return fail(left ? `run never rose: ${left} of ${cards} cards still in the reader after ${c} cycles (is next taking them?)` : `run never rose: the last card went after ${emptyAt} cycles, and run was still 0 ${c - emptyAt} cycles later`);
      cycle();
      c++;
    }
    cycles += c;
    // The memory once run rises: card i in word i.
    const s = sim.leafState(ramLeaf);
    if (!isRamState(s)) return fail('cannot read the program memory');
    const mem = ramWords(s);
    const bad = deck.words.findIndex((w, i) => mem[i] !== w);
    if (bad >= 0) {
      const hex = (w: number) => (w < 0 ? 'X' : `0x${w.toString(16).padStart(4, '0')}`);
      const at = mem.findIndex((w) => w === deck.words[bad]);
      return fail(`when run rose, RAM word ${bad} holds ${hex(mem[bad])} where card ${bad + 1} (${hex(deck.words[bad])}) belongs${at >= 0 ? `; ${hex(deck.words[bad])} is in word ${at}` : ''}`);
    }
    // Run to halt, against the golden model.
    const iss = new Iss4(deck.words);
    const steps = iss.run(10000);
    for (let n = 0; ; n++) {
      if (port('run') !== 1) return fail(`run fell back to ${show(port('run'))} ${n} cycles after it rose`);
      if (port('halt') === 1) break;
      if (n >= steps + RUN_SLACK) return fail(`halt never read 1 in ${n} cycles after run rose (the program halts after ${steps} instructions)`);
      cycle();
    }
    const wrong = IO4_OUTS.map((p, i) => [p, port(p), iss.ports[i]] as const).filter(([, got, want]) => got !== want);
    if (wrong.length) fail(`at halt ${wrong.map(([p, g]) => `${p}=${show(g)}`).join(' ')}, expected ${wrong.map(([p, , w]) => `${p}=${w}`).join(' ')}`);
  });
  return { failures, tested: loaderDecks().length, failed, cycles, relays: loaderRelays(def) };
}

// ---- the reference -----------------------------------------------------------------------------

let refDef: ComponentDef | null = null;
/**
 * The reference loader: the reader takes a card at every edge one waits (next = 1), so ready writes the RAM and counts
 * the address; run is empty taken at the falling edge, so the gated CPU clock (clk AND run) starts with a whole pulse.
 */
export function loaderDef(): ComponentDef {
  if (refDef) return refDef;
  const { reader: READER, ram: RAM, zero4: ZERO4 } = loaderParts();
  const b = new Builder(10, 12, 6);
  b.pins('clk');
  const one = b.op1(TIE1, [], 'take every card');
  const nclk = b.op1(NOT, ['clk'], 'falling edge');
  b.next();
  const rd = b.op(READER, [one, 'clk'], 'card reader', 'reader');
  const ready = b.name(`${rd}.ready`, 'ready', true);
  b.next();
  const cnt = b.op(counter(8), [ready, 'clk'], 'address', 'cnt');
  const run = b.name(b.op1(DFF, [`${rd}.empty`, nclk], 'run', 'runff'), 'run', true);
  const gclk = b.name(b.op1(AND, ['clk', run], 'CPU clock', 'gate'), 'cpuclk', true);
  b.next();
  const mux = b.op(busMux2(8), [`${cnt}.q`, '', run], 'address', 'amux');
  b.next();
  const ram = b.op(RAM, [`${mux}.y`, `${rd}.data`, ready, 'clk'], 'program memory', 'ram');
  b.next();
  const test = b.op1(TIE0, [], 'TEST');
  const sw = b.op1(ZERO4, [], 'switches');
  b.next();
  const cpu = b.op(CPU4_CORE, [gclk, test, sw, `${ram}.dout`], '4-bit CPU', 'cpu');
  b.wire(`${cpu}.pc`, `${mux}.b`);
  b.wire(run, 'run');
  b.wire(`${cpu}.halt`, 'halt');
  for (const p of IO4_OUTS) b.wire(`${cpu}.${p}`, p);
  const R = b.right;
  const outs = LOADER_PORTS.filter((p) => p.dir === 'out');
  refDef = {
    id: 'cp_loader_ref', name: 'Card loader', category: 'cpu',
    summary: 'The reader takes a card at every edge one waits (next = 1): ready writes the card\'s word into the RAM word the counter addresses and counts the address on. empty, taken at the falling edge, is run: it switches the RAM\'s address to the CPU\'s pc and lets the clock through to the CPU (clk AND run), starting with a whole pulse.',
    ports: LOADER_PORTS.map((p) => ({ name: p.name, width: p.width, dir: p.dir, ...(p.clock ? { clock: true } : {}) })),
    symbol: { kind: 'box', label: 'LOADER' },
    netlist: () => ({ pins: { clk: [0, 8], ...Object.fromEntries(outs.map((p, i) => [p.name, [R, 4 + 4 * i] as [number, number]])) }, instances: b.instances, nets: b.nets() }),
  };
  return refDef;
}

let answer: ChipDoc[] | null = null;

export const BUILDCARD: Record<string, () => BuildChallenge> = {
  h_loader: () => ({
    id: 'h_loader', title: 'Program on cards', level: 'cpu', allowed: LOADER_RULE,
    brief: `A 4-bit CPU with an empty program memory, and its program in the card reader, one 16-bit instruction a card (row 9). Build the loader: card <i>k</i> goes into RAM word <i>k</i>; then <code>run</code> = 1 and the CPU runs from address 0. The reader: <code>ready</code> = 1 while a card waits at the station, <code>next</code> = 1 at a rising clk edge takes it and the next one arrives ${LOADER_FEED} edges later, <code>empty</code> = 1 once the last one is taken. Keep run = 0 until then, and the CPU still (hold back its clock); after it, the RAM's address is the CPU's <code>pc</code>. Outputs: run, and the CPU's halt, d0–d3 and leds. Check loads the deck in the reader and a second one (a multiply, one card longer), compares the memory when run rises, then the outputs at halt with the golden model. Scored in relays (your logic: a coil per NAND, one more per four more contacts; the given parts are free) and in clock cycles until run = 1.`,
    ports: LOADER_PORTS,
    given: loaderGiven(),
    check: { kind: 'custom', describe: `two decks (sum, ${loaderDecks()[0].words.length} cards; multiply, ${loaderDecks()[1].words.length}): the memory when run rises, the outputs at halt against the golden model`, run: runLoader },
    answer: () => {
      if (!answer) {
        const { reader: READER, ram: RAM, zero4: ZERO4 } = loaderParts();
        const refOf = (d: ComponentDef): PartRef | undefined => (d === READER ? readerRef() : d === RAM ? RAM_REF : d === ZERO4 ? ZERO4_REF : undefined);
        const doc = docFromDef(loaderDef(), { id: 'u_ref_cp_h_loader', name: 'Program on cards ref', refOf });
        if ('error' in doc) throw new Error(`reference h_loader: ${doc.error}`);
        answer = [{ ...doc, notes: `Reference answer. ${loaderDef().summary}` }];
      }
      return answer;
    },
  }),
};
