// Codex entries for the chapter "Designing state machines" (chapters/ch-fsm.ts): state encoding, a state machine with a datapath,
// debouncing. Same shape as codex.ts, appended to CODEX there; the fuller texts are codexmorefsm.ts, the questions codexcheckfsm.ts.
// The numbers are the chapter's own (editor/fsmchip.ts encodingCosts, editor/fsmd.ts, lib/debounce.ts); tests/content-fsm.test.ts
// pins them. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_FSM: CodexEntry[] = [
  E('stateenc', 'State encoding', 'tool',
    'The code a state machine\'s flip-flops hold for each state. <b>Binary</b> counts the states (fewest flip-flops); <b>Gray</b> changes one bit per step along adjacent states; <b>one-hot</b> gives each state its own flip-flop, so a next-state bit is the OR of the arcs entering its state. The code changes the cost, never the behaviour: the 101 detector costs 32 / 37 / 51 NANDs in binary / Gray / one-hot, its four-state Moore version 36 / 51 / 74. One-hot wins when there are many states with few arcs into each. Codes no state has need an arc back, or a glitch can lock the machine up.',
    ['fsm', 'dontcare', 'kmap']),
  E('fsmd', 'FSM with a datapath', 'concept',
    'A small <b>controller</b> (a state machine) steering a <b>datapath</b> (registers, an arithmetic unit, comparators): the controller reads the datapath\'s status bits and drives its loads and selects, so the numbers live in registers and the controller holds only the phase of the algorithm. Euclid\'s GCD on two 8-bit registers is a five-state controller of 76 NANDs steering a datapath of 598 (674 NANDs in all), 10 cycles for gcd(48, 18). Every control unit in the book has this shape.',
    ['fsm', 'datapath', 'stateenc', 'microcode']),
  E('debounce', 'Debouncing', 'trick',
    'A mechanical contact bounces for milliseconds, so a pressed button reads as several presses. After a two-flip-flop synchronizer, a <b>debouncer</b> accepts a new level only when it has differed from the output for 2<sup>n</sup> clock samples in a row: a counter counts the samples that disagree and is cleared when they agree. Three bits ignore any bounce shorter than 8 samples; 5 ms of bounce at 1 kHz needs 3 bits.',
    ['metastability', 'fsm', 'dff']),
];

/** No campaign level lists these (they belong to the chapter): the test that wants every entry in a level skips them (tests/campaign.test.ts). */
export const FSM_AWAITING_LEVELS: ReadonlySet<string> = new Set(['stateenc', 'fsmd', 'debounce']);

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_FSM: Record<string, string[]> = {
  stateenc: ['state encodings', 'state code', 'state codes', 'one-hot encoding'],
  fsmd: ['FSMD', 'controller and datapath'],
  debounce: ['debouncer', 'debouncers', 'debounced', 'debouncing'],
};
