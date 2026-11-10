// Codex entries for Appendix F, the Apollo Guidance Computer (chapters/ch-agc.ts): core rope and the machine. Same shape
// as codex.ts, appended to CODEX there; the fuller texts are codexmoreagc.ts, the questions codexcheckagc.ts. Numbers
// are R-700 vol. III's (E. C. Hall, 1972) or the chapter's own; tests/content-agc.test.ts pins them. No DOM, no library
// import: the chapters' hover cards load this. "AGC" is no alias: the radio chapters use it for automatic gain control.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_AGC: CodexEntry[] = [
  E('corerope', 'Core rope', 'component',
    'Read-only memory woven from wire (MIT Instrumentation Laboratory, used in the Apollo Guidance Computer). Each core is a small magnetic ring; reading switches one core, and every <b>sense wire</b> threaded through it picks up a pulse. A wire that threads the core reads a 1, a wire routed around it a 0, so the program is in the weaving and cannot be changed by the computer. Inhibit wires choose the core: every core but the addressed one carries a current that cancels the switching current. In Block II each core stores 12 words, so 192 sense wires pass through or past it and a diode switch sends the addressed word\'s 16 to the sense amplifiers; six modules held 36 864 words. The cores were permalloy ribbon wound on steel bobbins, not ferrite.',
    ['rom', 'coremem', 'senseamp', 'decoder']),
  E('agc', 'Apollo Guidance Computer', 'concept',
    'The computer of the Apollo command and lunar modules, designed at the MIT Instrumentation Laboratory. Block II: 15-bit words in one\'s complement with 16-bit central registers (the extra bit catches overflow), 36 864 words of core rope and 2048 of erasable core memory, a memory cycle of 11.7 µs, 34 instructions (a 3-bit code, stretched by partial codes and EXTEND). Its logic is a single circuit, a three-input NOR in resistor-transistor logic, two to a chip: about 5600 gates, 70 pounds, 55 watts (R-700 Table 2-1).',
    ['nor', 'isa', 'corerope', 'coremem', 'multicycle']),
];

/** No campaign level teaches these (Appendix F is an optional appendix): the test that wants every entry in a level skips them (tests/campaign.test.ts). */
export const AGC_AWAITING_LEVELS: ReadonlySet<string> = new Set(['corerope', 'agc']);

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_AGC: Record<string, string[]> = {
  corerope: ['rope memory', 'core-rope'],
  agc: [],
};
