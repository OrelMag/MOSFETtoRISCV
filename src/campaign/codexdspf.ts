// Codex entries for the Signal processing level, group F: image sensors. Same shape as codex.ts, gathered by codexdsp.ts; the fuller texts are codexmore9f.ts, the
// questions codexcheck11f.ts, the numbers pinned by tests/content-codexdspf.test.ts (against phys/imagesensor.ts). No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_F: CodexEntry[] = [
  E('qe', 'Quantum efficiency', 'law', `Quantum efficiency is the share of photons arriving at a pixel that end as counted electrons. Silicon frees one electron per photon above its 1.12 eV gap (below 1107 nm), so QE is about where the light is absorbed: blue within 0.39 µm, red at 650 nm within 3.6 µm, 900 nm only after 33 µm (Green 2008). A back-illuminated pixel lit straight onto its diode reaches 79 % at 525 nm (Sony IMX183, measured to EMVA 1288); light through the metal layers of a front-illuminated one, and colour filters, cost a good part of that.`, ['fullwell', 'aps', 'bayer', 'thermalnoise']),
  E('ccd', 'Charge-coupled device', 'component', `A CCD stores each pixel's electrons in a potential well under a gate and moves every packet at once by clocking the gates in phases, row by row into a serial register and along it to one output amplifier. The e2v CCD42-40 has 2048 × 2048 pixels of 13.5 µm, three phases, 150 000 e⁻ a pixel and 4.5 µV per electron at the output. Each transfer leaves a little behind: at 99.9999 % per transfer in the image and 99.9993 % in the register, the far corner keeps 98.4 % after 4096 transfers. One output reads the frame in 1.4 s at 3 MHz.`, ['cds', 'fullwell', 'aps', 'qe']),
  E('aps', 'Active pixel (4T)', 'component', `A CMOS active pixel turns its own charge into a voltage. The 4T pixel has a pinned photodiode, a transfer gate TX onto a floating diffusion FD, a reset transistor, a source follower and a row-select switch onto the column. FD's capacitance sets the gain, q / C: 60 µV per electron is 2.67 fF. Rows are read one at a time and every column converts at once, so nothing crosses the array as charge and the sensor is made in an ordinary CMOS process with its ADCs and logic beside it.`, ['cds', 'ccd', 'rollingshutter', 'fullwell']),
  E('cds', 'Correlated double sampling', 'trick', `A reset leaves the floating diffusion randomly off its level by √(kTC)/q, 20.8 e⁻ rms at 2.67 fF and 300 K, and the error stays until the next reset. Correlated double sampling samples the reset level, lets the charge in, samples again and keeps the difference, so the reset's error and any fixed offset cancel. A pinned photodiode makes it possible, as it empties completely after the reset. Column ADCs can do it in the count: down through the reset level, up through the signal, leaving signal − reset.`, ['aps', 'thermalnoise', 'sar']),
  E('rollingshutter', 'Rolling and global shutter', 'concept', `A rolling shutter starts each row's exposure one row time after the last and reads each row when its exposure ends, so rows see different moments. The IMX183 reads 3694 rows at 21.98 frames a second: 12.3 µs a row, 45.5 ms top to bottom. A vertical edge crossing at 1000 pixels a second leans by 45 pixels, and a flash shorter than the readout lights a band. A global shutter ends every pixel's exposure at once by moving its charge to a storage node in the pixel, at a cost in area and in the noise and leakage the node adds while it waits.`, ['aps', 'cds']),
  E('bayer', 'Bayer filter and demosaicing', 'concept', `A colour sensor puts one filter over each pixel in a 2 × 2 tile of red, green, green and blue (Bryce Bayer, Kodak, 1976): half the pixels green, where the eye resolves most detail. Each pixel measures one colour, and demosaicing estimates the other two from its neighbours; bilinear demosaicing averages the nearest pixels that have the colour. It is exact on smooth areas and draws colour fringes at sharp edges and fine stripes. The filters cost light: the colour IMX183 measures 63 % blue, 69 % green and 43 % red.`, ['qe', 'jpeg', 'aliasing']),
  E('fullwell', 'Full well and dynamic range', 'law', `The full well is the most charge a pixel can hold; above it the count stops. Over the read noise it gives the dynamic range: 14 837 e⁻ over 3.3 e⁻ is 73.1 dB for the IMX183, 150 000 over 3 is 94.0 dB for the CCD42-40, whose pixels are five and a half times wider. Between the two ends, photon shot noise sets the SNR at √N. A smaller pixel holds less, so phone sensors trade resolution for range by combining neighbouring pixels in low light.`, ['qe', 'ccd', 'aps', 'decibel', 'thermalnoise']),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_F: Record<string, string> = {
  qe: 'sensors', ccd: 'sensors', aps: 'sensors', cds: 'sensors', rollingshutter: 'sensors', bayer: 'sensors', fullwell: 'sensors',
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_F: Record<string, string[]> = {
  qe: ['QE', 'quantum efficiency'],
  ccd: ['CCD', 'CCDs', 'charge-coupled device'],
  aps: ['active pixel', '4T pixel', 'pinned photodiode'],
  cds: ['CDS', 'correlated double sampling'],
  rollingshutter: ['rolling shutter', 'global shutter'],
  bayer: ['Bayer pattern', 'Bayer filter', 'demosaicing'],
  fullwell: ['full well', 'full-well capacity'],
};
