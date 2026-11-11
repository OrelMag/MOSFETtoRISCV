// Codex entry for the PDP-8 (the sandbox's two PDP-8 examples and the multicycle chapter's state-table step): what the
// examples assume. Same shape as codex.ts, appended to CODEX there; the fuller text is codexmorepdp8.ts, the questions
// codexcheckpdp8.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry } from './codex';

export const CODEX_PDP8: CodexEntry[] = [
  {
    id: 'pdp8', title: 'PDP-8', kind: 'concept',
    body: 'DEC\'s 12-bit computer of 1965: 4096 words of core read and rewritten in a 1.5 µs memory cycle, one accumulator (AC) with a link bit (L), '
      + 'and eight instructions, each one to three <b>major states</b> of one memory cycle each (Fetch, Defer, Execute). Its numbers are written in '
      + '<b>octal</b>, an address reaches page zero or the instruction\'s own 128-word page, and its front panel loads and runs a program by hand. '
      + 'The sandbox runs it twice: Examples ▸ PDP-8 front panel and Examples ▸ PDP-8 in gates.',
    related: ['multicycle', 'coremem', 'isa', 'fde', 'mmio'],
  },
];

/** No campaign level teaches it (the sandbox examples and a Layers paragraph do): the test that wants every entry in a level skips it. */
export const PDP8_AWAITING_LEVELS: ReadonlySet<string> = new Set(['pdp8']);

/** Other names it goes by in the chapters' prose (glossary.ts). */
export const ALIASES_PDP8: Record<string, string[]> = {
  pdp8: ['PDP-8/E'],
};
