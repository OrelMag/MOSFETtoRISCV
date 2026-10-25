// The end of each act: what the learner's machine can do now, what it still cannot, and the way on
// (thread.ts ActEnd). Shown in the after-pass card of the level that completes an act and as the act's
// footer on the map once it is done. Every number is a level's par or a measured part (tests/thread.test.ts
// pins them). No DOM.

import type { ActEnd } from './thread';

export const ACT_ENDS: Record<number, ActEnd> = {
  0: {
    can: 'Switch a 1 or a 0 with four transistors. Every function from here on is NANDs.',
    cannot: 'Anything a CPU does: a single NAND cannot choose, compare or route. Act 1 builds those from it.',
    next: 'g_not', side: 't_nor',
  },
  1: {
    can: 'Any truth table as gates (K-map, NAND–NAND), choose between words (bus mux), pick one of eight (decoder, 30 NANDs), tell whether two words are equal (110 NANDs, depth 12).',
    cannot: 'Treat a word as a number. There is no adding, so an RV16 <code>add</code> is still out of reach. Act 2.',
    next: 'a_ha',
  },
  2: {
    can: 'Every one of RV16\'s ten ALU operations in one pass: 1 055 NANDs, depth 64.',
    cannot: 'Keep a result: the ALU\'s output changes the moment its inputs do. <code>sum += i</code> needs somewhere for sum and i to live between steps, and the machine needs a PC to know which step it is on. Act 3.',
    next: 's_sr', side: 'o_fastadd',
  },
  3: {
    can: 'Hold state: the PC, eight registers (2 172 NANDs, nearly half the core to come), memories as parts.',
    cannot: 'Decide what to do with them: every mux and enable you built waits for someone to set it. The instruction word does that, so first learn what the words say, by programming. Act 4.',
    next: 'i_isa', side: 'm_ram',
  },
  4: {
    can: 'On the golden model: loops, arrays, calls, a stack. Multiplying took 28 to 134 instructions per product, 74 on average.',
    cannot: 'Run any of it on hardware you built. Each instruction you used is a path through blocks you have; Act 5 wires them.',
    next: 'c_lesson', side: 'p_sort',
  },
  5: {
    can: 'Run Act 4\'s programs on your own core: 4 720 NANDs, one instruction per 98-delay cycle, the 28 test programs in 121 128 NAND delays.',
    cannot: 'Go faster without changing something: every instruction waits for the slowest (a load), and the ripple ALU alone is 50 of the 98 delays. Shorten that path first, then cut it into stages.',
    next: 'pi_lesson', nextLabel: 'Act 6: cut the path into stages',
    side: 'c_fast', sideLabel: 'Side quest: shorten it (A faster core, period 76)',
  },
  6: {
    can: 'Five instructions in flight at period 78 (9 218 NANDs), with forwarding, the load-use stall and branch flushes. On these programs the plain pipeline is only 4% faster than Core III: branch prediction is how it earns its keep.',
    cannot: 'Survive its own mistakes or listen to the world: an illegal word, an <code>ecall</code> or a device that needs attention has no handler. Act 7.',
    next: 'y_lesson', side: 'o_bpred',
  },
  7: {
    can: 'The complete RV16: 12 038 NANDs, precise traps and interrupts.',
    cannot: 'Still idealised: memory answers in the cycle it is asked (Act 10), there is one instruction stream (Act 9), and no multiply, divide or floats in hardware (Act 8).',
    side: 'k_lesson', sideLabel: 'Optional: Act 9, a GPU',
  },
};
