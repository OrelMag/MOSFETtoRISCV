// Codex entries for the Signal processing level: IIR and stability, changing the rate, CORDIC. Same shape as codex.ts, gathered by codexdsp.ts; the fuller texts are codexmore9c.ts, the questions codexcheck11c.ts,
// the numbers pinned by tests/content-codexdspc.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_C: CodexEntry[] = [
  E('iirfilter', 'IIR filter', 'component', 'STUB'),
  E('bilinear', 'Bilinear transform', 'tool', 'STUB'),
  E('biquad', 'Biquad', 'component', 'STUB'),
  E('coefsens', 'Coefficient sensitivity', 'concept', 'STUB'),
  E('limitcycle', 'Limit cycle', 'concept', 'STUB'),
  E('decimation', 'Decimation', 'tool', 'STUB'),
  E('interpolation', 'Upsampling and interpolation', 'tool', 'STUB'),
  E('polyphase', 'Polyphase filter', 'trick', 'STUB'),
  E('halfband', 'Half-band filter', 'trick', 'STUB'),
  E('cic', 'CIC filter', 'component', 'STUB'),
  E('cordic', 'CORDIC', 'component', 'STUB'),
  E('cordicgain', 'CORDIC gain', 'law', 'STUB'),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_C: Record<string, string> = {
  iirfilter: 'zplane',
  bilinear: 'iir',
  biquad: 'iir',
  coefsens: 'iir',
  limitcycle: 'iir',
  decimation: 'radio',
  interpolation: 'multirate',
  polyphase: 'multirate',
  halfband: 'multirate',
  cic: 'radio',
  cordic: 'cordic',
  cordicgain: 'cordic',
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_C: Record<string, string[]> = {
  iirfilter: ['recursive filter'],
  bilinear: ['prewarp'],
  biquad: ['biquads', 'second-order section'],
  limitcycle: ['limit cycles'],
  decimation: ['decimate', 'decimator'],
  interpolation: ['interpolator', 'upsample', 'upsampling'],
  polyphase: ['polyphase'],
  halfband: ['half-band'],
  cic: ['CIC'],
};
