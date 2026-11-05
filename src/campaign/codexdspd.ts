// Codex entries for the Signal processing level: converters, filters that learn, pictures. Same shape as codex.ts, gathered by codexdsp.ts; the fuller texts are codexmore9d.ts, the questions codexcheck11d.ts,
// the numbers pinned by tests/content-codexdspd.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_D: CodexEntry[] = [
  E('enob', 'SNR and ENOB', 'law', 'STUB'),
  E('sar', 'Successive approximation', 'component', 'STUB'),
  E('r2r', 'R–2R ladder', 'component', 'STUB'),
  E('jitter', 'Sampling jitter', 'concept', 'STUB'),
  E('sigmadelta', 'Sigma-delta modulator', 'component', 'STUB'),
  E('noiseshaping', 'Noise shaping', 'concept', 'STUB'),
  E('wiener', 'Wiener filter', 'law', 'STUB'),
  E('lms', 'LMS and NLMS', 'tool', 'STUB'),
  E('echocancel', 'Adaptive echo canceller', 'component', 'STUB'),
  E('separable', 'Separable 2-D filter', 'trick', 'STUB'),
  E('resampling', 'Resizing an image', 'tool', 'STUB'),
  E('dct', 'Discrete cosine transform', 'tool', 'STUB'),
  E('quanttable', 'Quantization table', 'concept', 'STUB'),
  E('zigzag', 'Zig-zag and run lengths', 'trick', 'STUB'),
  E('huffman', 'Huffman code', 'tool', 'STUB'),
  E('jpeg', 'Baseline JPEG', 'concept', 'STUB'),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_D: Record<string, string> = {
  enob: 'signals',
  sar: 'converters',
  r2r: 'converters',
  jitter: 'converters',
  sigmadelta: 'converters',
  noiseshaping: 'converters',
  wiener: 'adaptive',
  lms: 'adaptive',
  echocancel: 'adaptive',
  separable: 'pictures',
  resampling: 'pictures',
  dct: 'pictures',
  quanttable: 'pictures',
  zigzag: 'pictures',
  huffman: 'pictures',
  jpeg: 'pictures',
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_D: Record<string, string[]> = {
  enob: ['ENOB', 'effective number of bits'],
  sar: ['SAR ADC', 'flash ADC'],
  r2r: ['R-2R'],
  jitter: ['aperture jitter'],
  sigmadelta: ['sigma-delta', 'delta-sigma'],
  noiseshaping: ['noise-shaping'],
  wiener: ['Wiener'],
  lms: ['LMS', 'NLMS', 'least mean squares'],
  resampling: ['bilinear interpolation'],
  dct: ['DCT'],
  quanttable: ['quantization matrix'],
  zigzag: ['zig-zag', 'run-length'],
  huffman: ['Huffman'],
};
