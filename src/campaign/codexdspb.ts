// Codex entries for the Signal processing level: measuring a spectrum, FIR design. Same shape as codex.ts, gathered by codexdsp.ts; the fuller texts are codexmore9b.ts, the questions codexcheck11b.ts,
// the numbers pinned by tests/content-codexdspb.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_B: CodexEntry[] = [
  E('leakage', 'Spectral leakage', 'concept', 'STUB'),
  E('windowfn', 'Window function', 'tool', 'STUB'),
  E('zeropad', 'Resolution and zero padding', 'concept', 'STUB'),
  E('spectrogram', 'Spectrogram', 'tool', 'STUB'),
  E('overlapsave', 'Overlap-save', 'tool', 'STUB'),
  E('goertzel', 'Goertzel algorithm', 'component', 'STUB'),
  E('linearphase', 'Linear phase', 'concept', 'STUB'),
  E('windowdesign', 'The window method', 'tool', 'STUB'),
  E('parksmcclellan', 'Parks–McClellan', 'tool', 'STUB'),
  E('csd', 'Canonical signed digit', 'trick', 'STUB'),
  E('transposed', 'Transposed form', 'trick', 'STUB'),
  E('multacc', 'Multiply–accumulate', 'component', 'STUB'),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_B: Record<string, string> = {
  leakage: 'spectrum',
  windowfn: 'spectrum',
  zeropad: 'spectrum',
  spectrogram: 'spectrum',
  overlapsave: 'spectrum',
  goertzel: 'spectrum',
  linearphase: 'signals',
  windowdesign: 'firdesign',
  parksmcclellan: 'firdesign',
  csd: 'firdesign',
  transposed: 'firdesign',
  multacc: 'firdesign',
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_B: Record<string, string[]> = {
  windowfn: ['Hann window', 'Blackman window'],
  zeropad: ['zero padding', 'zero-padding'],
  spectrogram: ['STFT'],
  overlapsave: ['overlap-add'],
  goertzel: ['Goertzel', 'DTMF'],
  linearphase: ['linear-phase'],
  parksmcclellan: ['Parks-McClellan', 'equiripple'],
  csd: ['CSD'],
  transposed: ['transposed'],
  multacc: ['multiply-accumulate'],
};
