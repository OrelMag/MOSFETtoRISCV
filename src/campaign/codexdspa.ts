// Codex entries for the Signal processing level: numbers that fit, the z-plane. Same shape as codex.ts, gathered by codexdsp.ts; the fuller texts are codexmore9a.ts, the questions codexcheck11a.ts,
// the numbers pinned by tests/content-codexdspa.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_A: CodexEntry[] = [
  E('qformat', 'Q format', 'tool', 'STUB'),
  E('saturate', 'Saturating arithmetic', 'concept', 'STUB'),
  E('guardbits', 'Guard bits', 'concept', 'STUB'),
  E('headroom', 'Scaling and headroom', 'concept', 'STUB'),
  E('diffeq', 'Difference equation', 'tool', 'STUB'),
  E('convolution', 'Convolution', 'tool', 'STUB'),
  E('ztransform', 'The z-transform', 'tool', 'STUB'),
  E('polezero', 'Poles and zeros', 'concept', 'STUB'),
  E('minphase', 'Minimum phase and group delay', 'concept', 'STUB'),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_A: Record<string, string> = {
  qformat: 'fixed',
  saturate: 'fixed',
  guardbits: 'fixed',
  headroom: 'fixed',
  diffeq: 'zplane',
  convolution: 'signals',
  ztransform: 'zplane',
  polezero: 'zplane',
  minphase: 'zplane',
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_A: Record<string, string[]> = {
  qformat: ['Q15', 'Q1.15'],
  saturate: ['saturating adder'],
  guardbits: ['guard bit'],
  diffeq: ['difference equation'],
  convolution: ['convolve', 'convolves', 'convolved'],
  ztransform: ['z-transform'],
  polezero: ['poles and zeros'],
  minphase: ['minimum phase', 'group delay'],
};
