// Codex entry for the logic chapter (chapters/ch-logic.ts): the static hazard and the consensus term that cures it. Same shape as
// codex.ts, appended to CODEX there; the fuller text is codexmorelogic.ts, the questions codexchecklogic.ts. The numbers are the
// chapter's own (tests/content-logic.test.ts pins them against the gates). No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_LOGIC: CodexEntry[] = [
  E('hazard', 'Static hazard', 'concept',
    'A momentary wrong value on an output that should not change. In a two-level circuit it happens when an input change turns one product term off a gate delay before another turns on: the multiplexer y = s·b + ¬s·a with a = b = 1 dips to 0 for one delay when s falls. The cure is the <b>consensus term</b> (here a·b), a loop on the Karnaugh map that bridges the two: it changes no settled value and costs gates.',
    ['glitch', 'kmap', 'sop', 'mux']),
];

/** No campaign level lists this entry yet: the test that wants every entry in a level skips it (tests/campaign.test.ts). */
export const LOGIC_AWAITING_LEVELS: ReadonlySet<string> = new Set(['hazard']);

/** Codex id → the chapter that teaches it. */
export const TAUGHT_LOGIC: Record<string, string> = { hazard: 'logic' };

/** Other names an entry goes by in the chapters' prose (glossary.ts). A bare "hazard" is the pipeline's (codex id hazards). */
export const ALIASES_LOGIC: Record<string, string[]> = {
  hazard: ['static hazard', 'static-1 hazard', 'static-0 hazard', 'consensus term'],
};
