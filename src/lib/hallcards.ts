// The machine hall's program on cards (chapter silicon, "The same CPU in relays and tubes"): the hall leaves the program ROM
// out because a relay or tube machine took its program off cards. This is that reader. The program is a deck of object
// cards (one instruction a card, its source printed on top, cards/program.ts) and the machine is fed one of two ways:
//   - stream ("read as it runs", Harvard Mark I's way): each instruction is the card at the read station; a jump back runs
//     the loop's cards round again (a loop deck, as Mark I glued its tape into loops), so a backward jump costs nothing
//     extra. The reader delivers a card every CARD_S: a machine slower than that never waits for it;
//   - load ("load, then run", the IBM 701's way): the deck is read once into a program store, priced as the site's RAM in
//     the hall's technology and added to the hall as racks of its own, and the machine then runs at its own speed.
// The simulation is the hall's gate-level CPU as before (its program ROM a lookup leaf, as everywhere): the reader decides
// which card is at the station and how long the hall waits for it, in the time ledger. The golden model, stepped with the
// clock, says which card each cycle fetches. DOM-free: widgets/hallview.ts draws it, tests/hallcards.test.ts pins it.

import { type Deck } from '../cards/card';
import { programCards } from '../cards/program';
import { assemble4 } from '../isa4/asm4';
import { Iss4 } from '../isa4/iss4';
import { COUNTER4 } from '../isa4/programs4';
import { assemble } from '../riscv/asm';
import { ISS } from '../riscv/iss';
import { PROGRAMS } from '../riscv/programs';
import type { ComponentDef } from '../sim/types';
import type { HallDesign, HallTech } from './hall';
import { ram } from './memory';

/**
 * One card read: 0.4 s. "all at the regular card reading speed of 150 cards per minute, or 0.4 seconds per card", the IBM 701
 * Speedcoding System (IBM Scientific Computing Service, 1953), of the IBM 711 reader the 701 shipped with.
 */
export const CARD_S = 0.4;

/**
 * The IBM 711's cabinet: 32 × 30 inches, 31⅝ inches high, 560 lb (IBM 7090/7094 Installation Manual, Physical Planning,
 * GC22-6706-2, October 1964: the 711 as attached to a 7090, its faster model 2 in the same frame). In metres and kilograms;
 * w along the aisle, d across it.
 */
export const READER_711 = { w: 32 * 0.0254, d: 30 * 0.0254, h: 31.625 * 0.0254, kg: 560 * 0.45359237 };

export type FeedMode = 'stream' | 'load';

/** Each technology starts in its own: a relay machine keeps up with the reader, a tube machine would idle on it. */
export const defaultFeed = (tech: HallTech): FeedMode => (tech === 'relay' ? 'stream' : 'load');

export interface HallProgram {
  /** The deck: one object card a word, numbered 10, 20, … */
  deck: Deck;
  /** Bits a card holds (the word: 32 for RV32I, 16 for the 4-bit CPU's instruction words). */
  bits: number;
  words: number[];
  /** Bytes an instruction takes in the program counter's units (RV32I: 4; the 4-bit CPU counts words). */
  pcStep: number;
}

const programs = new Map<HallDesign, HallProgram>();

/** The program the hall runs (the same as hall.ts hallCpu builds its ROM from), as a deck. */
export function hallProgram(design: HallDesign): HallProgram {
  let p = programs.get(design);
  if (!p) {
    if (design === 'cpu4') {
      const a = assemble4(COUNTER4);
      p = { deck: programCards('count on the LEDs', COUNTER4, a.lines.map((l) => ({ word: l.word, srcLine: l.srcLine })), 16), bits: 16, words: a.words, pcStep: 1 };
    } else {
      const src = PROGRAMS.find((q) => q.id === 'fib')!;
      const a = assemble(src.source);
      p = { deck: programCards(src.name, src.source, a.lines.map((l) => ({ word: l.word, srcLine: l.srcLine })), 32), bits: 32, words: a.words, pcStep: 4 };
    }
    programs.set(design, p);
  }
  return p;
}

const stores = new Map<HallDesign, ComponentDef>();

/** The program store "load, then run" needs: the site's RAM, as many words as the deck rounded up to a power of two. */
export function programStore(design: HallDesign): ComponentDef {
  let s = stores.get(design);
  if (!s) {
    const p = hallProgram(design);
    s = ram(Math.max(1, Math.ceil(Math.log2(p.deck.cards.length))), p.bits);
    stores.set(design, s);
  }
  return s;
}

/** Seconds of the hall's time, by what it spent them on. */
export interface Ledger { compute: number; wait: number; load: number }

/**
 * The reader beside the hall's CPU: which card each clock cycle fetches (from the golden model, stepped once a cycle as the
 * single-cycle CPUs retire one instruction a cycle), the counts the panel shows and the time ledger.
 */
export class HallFeed {
  readonly program: HallProgram;
  /** Card at the read station (0-based; −1 none yet). */
  at = -1;
  /** Cards through the reader: in stream mode one an instruction, in load mode the deck once. */
  read = 0;
  /** Times the deck went back to an earlier card (a backward jump: round the loop again). */
  passes = 0;
  instructions = 0;
  loaded = false;
  outOfCards = false;
  ledger: Ledger = { compute: 0, wait: 0, load: 0 };
  private iss: { pc: number; step(): unknown };

  constructor(readonly design: HallDesign, readonly mode: FeedMode, readonly period: number) {
    this.program = hallProgram(design);
    this.iss = design === 'cpu4' ? new Iss4(this.program.words) : new ISS(this.program.words);
  }

  get cards(): number { return this.program.deck.cards.length; }

  /** Seconds one instruction takes on the wall clock: in stream mode the reader's card when it is the slower. */
  get instrTime(): number { return this.mode === 'stream' ? Math.max(this.period, CARD_S) : this.period; }

  /** Load mode: the whole deck read into the store before the first instruction (stream mode: nothing). */
  load(): void {
    if (this.mode !== 'load' || this.loaded) return;
    this.loaded = true;
    this.read = this.cards;
    this.ledger.load = this.cards * CARD_S;
  }

  /** The card the next cycle fetches, without taking it. */
  peek(): number { return Math.floor(this.iss.pc / this.program.pcStep); }

  /** One clock cycle: the instruction at the PC fetched (stream mode: its card read), the golden model stepped. */
  cycle(): void {
    if (this.mode === 'load' && !this.loaded) this.load();
    const k = this.peek();
    if (k < 0 || k >= this.cards) { this.outOfCards = true; return; }
    if (this.at >= 0 && k < this.at) this.passes++;
    this.at = k;
    this.instructions++;
    this.ledger.compute += this.period;
    if (this.mode === 'stream') {
      this.read++;
      this.ledger.wait += Math.max(0, CARD_S - this.period);
    }
    this.iss.step();
  }
}
