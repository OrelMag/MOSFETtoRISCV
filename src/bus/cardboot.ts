// How long chapter 35's card boot takes, from the golden model: the boot ROM run on the ISS over a BusModel with the
// card reader, its clock advanced by what each instruction costs on the bus computer (boot ROM code: 1 cycle, a load
// or a store 2, the bus's address and data handshakes). tests/buscards.test.ts pins it against the gates.

import { assemble } from '../riscv/asm';
import { ISS } from '../riscv/iss';
import { BusModel } from './model';
import { CARD_BOOT_SOURCE, LOAD_AT } from './programs';

export interface CardBootTime {
  /** Cycles from power-on to the first instruction fetched at LOAD_AT. */
  cycles: number;
  /** Boot ROM instructions retired meanwhile. */
  instructions: number;
  /** Polls of STATUS that found no card at the station (the CPU waiting for the feed). */
  idlePolls: number;
}

/** Cycles a boot ROM instruction takes on the bus computer. */
const romCost = (word: number) => ((word & 0x7f) === 0x03 || (word & 0x7f) === 0x23 ? 2 : 1);

/** The card boot of `items` (a word a card) with the reader's `feed`, on the golden model. */
export function cardBootTime(items: readonly number[], feed: number, maxInstr = 100000): CardBootTime {
  const a = assemble(CARD_BOOT_SOURCE), rom = a.words;
  const bus = new BusModel(12, [], 4096, { cards: { items, feed } });
  const iss = new ISS(rom, { system: true, imemWords: 128, bus });
  const status = a.labels.get('next')!;
  let cycles = 0, n = 0, idle = 0;
  while (iss.pc >>> 0 !== LOAD_AT && n < maxInstr) {
    const pc = iss.pc >>> 0;
    cycles += romCost(rom[pc >>> 2] ?? 0);
    bus.now = cycles;
    iss.step();
    n++;
    if (pc === status && (iss.x[5] & 3) === 0) idle++;
  }
  return { cycles, instructions: n, idlePolls: idle };
}
