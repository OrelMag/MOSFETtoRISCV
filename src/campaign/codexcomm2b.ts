// Codex entries for the Communication extension: glass, radio, wifi, cellular. Same shape as codex.ts, gathered by codexcomm2.ts; the fuller texts are codexmore8b.ts, the questions codexcheck10b.ts,
// the numbers pinned by tests/content-codexcomm2b.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_B: CodexEntry[] = [
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_B: Record<string, string> = {
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_B: Record<string, string[]> = {
};
void E;
