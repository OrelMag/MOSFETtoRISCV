// Codex entries for Appendix E, the Manchester Baby (chapters/ch-baby.ts): the Williams tube and the machine built on it.
// Same shape as codex.ts, appended to CODEX there; the fuller texts are codexmorebaby.ts, the questions codexcheckbaby.ts.
// Every number is the chapter's own, measured on our gates and golden model or taken from Kilburn's report of December 1947
// and S. H. Lavington's History of Manchester Computers; tests/content-codexbaby.test.ts pins them. No DOM, no library
// import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';
import { groupDigits as k } from '../sim/numfmt';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_BABY: CodexEntry[] = [
  E('williamstube', 'Williams tube', 'component',
    `A cathode-ray tube used as a memory (F. C. Williams and Tom Kilburn, Manchester, 1946–47). The beam draws a dot or a short dash on the screen; where it strikes, the phosphor loses electrons and keeps a small patch of charge, different for the two shapes, and a metal <b>pick-up plate</b> against the glass sees a pulse when the beam returns to the spot. A dash is a 1, a dot a 0: the tube holds a raster of bits, the Baby's 32 lines of 32 on one CV1131. The charge leaks, "of the order of 0.2 seconds" in Kilburn's report of December 1947, and a read disturbs it, so every line is read and rewritten ("regenerated") at "a frequency greater than 5 cycles/second": the Baby visited the whole store every 16 instructions, 19.6 ms.`,
    ['refresh', 'senseamp', 'sram', 'ram', 'latch', 'ssem']),
  E('ssem', 'Small-Scale Experimental Machine (SSEM)', 'concept',
    `The Manchester Baby: the Small-Scale Experimental Machine, built at Manchester University by F. C. Williams, Tom Kilburn and Geoff Tootill, ran its first program on 21 June 1948: the first electronic computer to run a program held in its own read-write store. It was a test of that store (hence "experimental"), and small: <b>32 words of 32 digits</b> on one Williams tube, an accumulator A, a control register CI and <b>seven instructions</b>: JMP, JRP, LDN, STO, SUB, CMP, STP. There is no add and no load; numbers are negated on the way in (LDN) and subtracted. A digit lasts 8.5 µs, a beat 306 µs, an instruction four beats. Here it is ${k(22694)} NANDs, ${k(19653)} of them the store.`,
    ['fde', 'cpu', 'isa', 'loader', 'ram', 'williamstube']),
];

/** No campaign level teaches these (Appendix E is an optional appendix): the test that wants every entry in a level skips them (tests/campaign.test.ts). */
export const BABY_AWAITING_LEVELS: ReadonlySet<string> = new Set(['williamstube', 'ssem']);

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_BABY: Record<string, string[]> = {
  williamstube: ['Williams–Kilburn tube', 'Williams-Kilburn tube', 'Williams tubes'],
  ssem: [],
};
