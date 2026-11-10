// Authored walkthroughs, act 7's virtual-memory levels (references: lib/rv16/vm16.ts through buildvm.ts). See walks.ts for the
// conventions. No DOM.

import type { WalkScript } from './walk';

export const WALKSVM: Record<string, WalkScript> = {
  y_tlb: [
    {
      title: 'A pointer that says which entry is next',
      text: 'ptr is a 2-bit register that advances only on a fill (u0 adds 1), and u1 decodes it, enabled by fill, into one write line for each of the four entries. Entries are replaced in turn: 0, 1, 2, 3, 0 and so on.',
      why: 'A TLB has to throw something away when it is full. Round robin needs no history of use, only a counter, and a counter is the cheapest rule there is.',
      whyNot: { text: 'Least-recently-used needs an age for every entry, updated on every hit. For four entries the extra logic costs more than the misses it saves.' },
      parts: ['ptr', 'u0', 'u1'], codex: ['tlb'],
    },
    {
      title: 'The word an entry holds',
      text: 'u2 puts the key, the physical page number and the flags side by side in one 19-bit word. The same word goes to all four entries; only the one with its write line high takes it.',
      why: 'The page number you looked up and the translation the walker found are stored together: the first is what a later lookup is compared with, the second is what it returns.',
      parts: ['u2'],
    },
    {
      title: 'Entries, valid bits and flush',
      text: 'e0 to e3 are 19-bit registers, each enabled by its write line. A valid flip-flop (v0 to v3) says whether the entry means anything: its next value is not flush (u3), and it changes when its entry is written or when flush is high (u4 to u7). Flush therefore clears all four, and wins over a fill on the same edge.',
      why: 'At power-on the registers hold nothing true, and after a flush the translations are wrong. A valid bit separates "holds a translation" from "holds whatever bits are in it", without erasing the entry.',
      whyNot: { text: 'Clearing the key bits of every entry on a flush would work too, but it takes a reset path on 19 flip-flops times four, where valid needs one.' },
      parts: ['e0', 'e1', 'e2', 'e3', 'v0', 'v1', 'v2', 'v3', 'u3', 'u4', 'u5', 'u6', 'u7'],
    },
    {
      title: 'Compare every entry with the key',
      text: 'A splitter (p0 to p3) cuts each entry into its page number, physical page number and flags. An 8-bit comparator per entry (u8, u10, u12, u14) checks the page number against key, and an AND with valid (u9, u11, u13, u15) makes the match line. All four compare at once.',
      why: 'The key may be in any entry, so every entry looks: one comparator each, in parallel. This is what makes the TLB a content-addressable memory instead of an array.',
      parts: ['p0', 'p1', 'p2', 'p3', 'u8', 'u9', 'u10', 'u11', 'u12', 'u13', 'u14', 'u15'], codex: ['comparator'],
    },
    {
      title: 'Which one matched?',
      text: 'u16 gathers the four match lines into one bus and u17, a priority encoder, gives hit (any line) and the index of the one that matched.',
      ask: {
        question: 'Two entries hold the same page number, both valid. What does the lookup return?',
        options: ['The lower-numbered entry: the priority encoder picks the first match, which is why a TLB must never be filled with a page it already holds', 'Both, ORed together', 'Neither: two matches is a miss', 'The newer entry'],
        answer: 0,
        explain: 'The encoder reports the lowest match line. The bench never fills a page already present, and a real walker only starts on a miss, so a duplicate cannot arise; if one did, the answer would depend on which entry the pointer had reached, not on which was newer.',
        why: ['', 'There is a single index; the outputs come from one entry.', 'Nothing in a priority encoder makes two matches a miss: it reports the first.', 'The hardware has no age; the lowest index wins.'],
      },
      why: 'Several lines could be high in a buggy design, and the multiplexers need one number. A priority encoder gives one even then, and its valid output is the hit.',
      parts: ['u16', 'u17'],
    },
    {
      title: 'Deliver the matching entry',
      text: 'Two multiplexers choose, by that index, the matching entry\'s physical page number (u18, 8 bits) and its flags (u19, 3 bits). Without a hit they show entry 0; hit says whether to believe them.',
      why: 'The answer is a lookup in the flip-flops and a mux: combinational, no clock in the way, which is what lets a real CPU translate an address in the same cycle that it uses it.',
      parts: ['u18', 'u19'], codex: ['mux'],
    },
  ],
  y_walk: [
    {
      title: 'The state, decoded',
      text: 's0 and s1 hold the state: idle 00, level 1 01, level 0 10, fault 11. Two inverters (u0, u1) and four ANDs (u2 idle, u3 level 1, u4 level 0, u5 fault) give one line for each; u6 ORs the two reading states into walk.',
      why: 'Everything the walker does depends on which state it is in. Decoding the two bits once gives named wires, and the rest of the machine is written in terms of them.',
      whyNot: { text: 'One flip-flop per state (one-hot) would need no decoder, but it also needs four flip-flops and a reset into a legal state. Two bits are enough for four states.' },
      parts: ['s0', 's1', 'u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6'], codex: ['fsm'],
    },
    {
      title: 'Which table, which index',
      text: 'u7 splits the page number into vpn0 and vpn1. At level 1 the table is root and the index vpn1; at level 0 the table is the one tbl remembered and the index vpn0. Two multiplexers (u8, u9) pick them by the level-1 line, and u10 joins them into the 12-bit address of the entry: {table, index}.',
      why: 'The two reads are the same operation on different inputs. One multiplexer per input, switched by the state, lets one datapath do both.',
      parts: ['tbl', 'u7', 'u8', 'u9', 'u10'], codex: ['mux'],
    },
    {
      title: 'Read the entry',
      text: 'u11 splits the word the memory returned into V, R, W, X and the physical page number. u12 to u15 find a bad entry: not V, or W without R (u15 is the OR). u16 to u18 find a pointer: R and X both 0.',
      why: 'The same few flag tests apply at both levels. They are computed once from the word, and the state decides which ones matter.',
      parts: ['u11', 'u12', 'u13', 'u14', 'u15', 'u16', 'u17', 'u18'],
    },
    {
      title: 'What the entry means in this state',
      text: 'u19 and u20 make ok: walking, and not bad. ptrOk (u21) is ok at level 1 on a pointer; leafOk (u23) is ok at level 0 on something that is not a pointer. Anything else while walking is a fault (u24 to u26): invalid, a leaf at level 1, a pointer at level 0.',
      ask: {
        question: 'At level 1 the entry is valid, readable, and not a pointer: a leaf. Real Sv32 would accept it as a 4 MiB superpage. What does this walker do?',
        options: ['Faults: it has no superpages, so a leaf is only accepted at level 0', 'Fills the TLB with it, as at level 0', 'Reads level 0 from it anyway', 'Waits for the next cycle'],
        answer: 0,
        explain: 'leafOk needs the level-0 line. A leaf at level 1 satisfies neither ptrOk nor leafOk, so faultNow is high and the walker goes to the fault state. Sv32 adds a rule for aligned superpages, and the system CPU of the chapter does it; this miniature leaves it out.',
        why: ['', 'Only leafOk fills, and it requires the level-0 state.', 'A leaf\'s page number is a frame, not a table; reading it as one would walk through data.', 'The fault state is entered at the next edge, not waited for.'],
      },
      why: 'Each case has a name, and fault is whatever is neither. Written that way, no combination of flags can leave the machine in a state with no way out.',
      parts: ['u19', 'u20', 'u21', 'u22', 'u23', 'u24', 'u25', 'u26'],
    },
    {
      title: 'Next state, fill and stall',
      text: 'go (u27) is idle with start. s0 next (u28) is go or a fault: into level 1 or into 11. s1 next (u29) is a followed pointer or a fault: into level 0 or into 11. A leaf sends both to 0, back to idle, and pulses fill. u30 joins r, w and x into the flags the TLB stores; u31 makes stall: walking, or starting.',
      why: 'The state register only needs to know where to go. Three lines (go, ptrOk, faultNow) decide it, and fill and stall are read straight off the lines already computed.',
      parts: ['u27', 'u28', 'u29', 'u30', 'u31'],
    },
  ],
};
