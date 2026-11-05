// Codex entries for the Communication extension: message, signals, noise. Same shape as codex.ts, gathered by codexcomm2.ts; the fuller texts are codexmore8a.ts, the questions codexcheck10a.ts,
// the numbers pinned by tests/content-codexcomm2a.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_A: CodexEntry[] = [
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_A: Record<string, string> = {
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_A: Record<string, string[]> = {
};
void E;
