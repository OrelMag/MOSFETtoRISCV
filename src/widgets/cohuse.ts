// What an instruction uses of the coherent dual-core (the Coherence panel's listing marks and Slow mode), DOM-free.

import { decode, OPCODES } from '../riscv/isa';
import type { InstrUse } from './insthw';

/** Memory instruction: goes through the cache (lw, sw, amo*, lr.w, sc.w). */
export const isMem = (word: number): boolean => {
  const op = decode(word).opcode;
  return op === OPCODES.LOAD || op === OPCODES.STORE || op === OPCODES.AMO;
};

/**
 * Top-level instances an instruction of core `core` uses. `bus`: its access needs the bus now (a miss or an upgrade); `answers`:
 * the other core's cache supplies a line (a Flush). Without a memory access only the core.
 */
export function cohUse(word: number, core: number, now: { bus?: boolean; flush?: boolean } = {}): InstrUse {
  const units = [`core${core}`];
  let path = 'registers and ALU only: no cache access';
  if (isMem(word)) {
    units.push(`cache${core}`);
    path = 'address → cache: tag compare, a hit answers in the cycle';
    const name = decode(word).name;
    if (name === 'lr.w' || name === 'sc.w') path += '; the reservation is set (lr.w) or tested and cleared (sc.w)';
    if (now.bus) { units.push('bus', 'dm'); path = 'a miss or an upgrade: the cache asks the bus, which moves the line to or from memory'; }
    if (now.flush) { units.push(`cache${1 - core}`); path += '; the other cache holds it Modified and supplies it (Flush)'; }
  }
  return { units, path };
}
