// Codex entries for the Communication extension: glass, radio, wifi, cellular. Same shape as codex.ts, gathered by codexcomm2.ts; the fuller texts are codexmore8b.ts, the questions codexcheck10b.ts,
// the numbers pinned by tests/content-codexcomm2b.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_B: CodexEntry[] = [
  E('dispersion', 'Fibre dispersion', 'concept', 'In single-mode fibre the colours of a pulse travel at different speeds: D is about 17.5 ps/(nm·km) at 1550 nm and zero at 1310 nm. A bit rate B widens the spectrum, so with a clean laser the reach goes as 1 / B²: 28 km at 10 Gb/s, 1.8 km at 40 Gb/s. A source a nanometre wide spreads by D · Δλ whatever the rate (1.4 km at 10 Gb/s). Dispersion is linear on the field, so a receiver that has the field can undo it.', ['coherent', 'wdm', 'eye', 'equalization']),
  E('wdm', 'Wavelength-division multiplexing', 'trick', 'Light of different wavelengths hardly interacts in glass and a grating can split it again, so one fibre carries many channels. On the 50 GHz grid the C band (1530 to 1565 nm, 4.4 THz) holds 87 channels; at 32 GBd and a rate-0.8 code, 16-QAM is 205 Gb/s a channel and 17.8 Tb/s a fibre each way. A faster symbol rate needs wider spacing, so the band holds about the same symbols a second either way.', ['edfa', 'qam', 'shannon', 'dispersion']),
  E('edfa', 'Optical amplifier (EDFA)', 'component', 'A few metres of erbium-doped fibre, pumped at 980 or 1480 nm, amplify all of 1530 to 1565 nm at once whatever the bit rate or format. They add noise (noise figure 3 dB at the quantum limit, 4.5 to 6 dB in practice), so OSNR = P − NF − L<sub>span</sub> − 10 log N − hνB, with hνB = −58.0 dBm in 12.5 GHz. Ten times the spans cost only 10 dB, so many short spans beat a few long ones.', ['wdm', 'thermalnoise', 'decibel', 'coherent']),
  E('coherent', 'Coherent detection', 'tool', 'A photodiode measures intensity and loses the phase. A coherent receiver mixes the light with a local laser on a 90° hybrid and reads I and Q in both polarizations (eight photodiodes), so the ADCs hold the optical field itself. Everything linear that the fibre did, dispersion above all, can then be inverted in a DSP; a laser-phase tracker and a polarization equalizer do the rest.', ['dispersion', 'qam', 'mixer', 'fft']),
  E('linkbudget', 'Link budget and path loss', 'tool', 'A radio link is a sum in dB: transmit power, antenna gains, free-space path loss 20 log d + 20 log f + 92.45 (d in km, f in GHz) and walls, against a noise floor of −174 dBm/Hz + 10 log B + NF. A 20 MHz channel with a 6 dB noise figure has a floor of −95 dBm. Shannon turns the SNR into a limit, but at fixed power widening the channel stops helping once SNR is low.', ['decibel', 'thermalnoise', 'shannon', 'fading']),
  E('fading', 'Multipath and fading', 'concept', 'Echoes make a radio channel a filter: frequencies closer than about 1 / (5τ) fade together, 4 MHz for a 50 ns delay spread. Motion changes the phases of the rays, so the sum wanders (Rayleigh fading) over a coherence time of about 0.42 / f<sub>d</sub>: 2.3 ms at 100 km/h and 2 GHz. BER then falls only as 1 / SNR: at 10 dB BPSK errs 2 × 10⁻² of the time against 4 × 10⁻⁶ without fading.', ['ofdm', 'equalization', 'mimo', 'interleave']),
  E('mimo', 'MIMO', 'trick', 'Several antennas at each end make the channel a matrix H. Used for one stream they give diversity: BPSK at a BER of 10⁻³ needs 24.0 dB in Rayleigh fading with one receive antenna and 11.1 dB with two. In a scattering channel whose rows differ they carry several streams: at 30 dB, 2 × 2 reaches 17.8 b/s/Hz against 9.2, and each 3 dB buys 2 b/s/Hz rather than 1. A clear line of sight leaves H nearly rank 1.', ['fading', 'beamforming', 'shannon', 'waterfill']),
  E('csmaca', 'CSMA/CA', 'tool', 'A radio cannot hear a collision while it sends (its own signal is far stronger), so Wi-Fi listens before it talks and then avoids. In 802.11a: a random backoff in 9 µs slots after the medium has been idle for DIFS (34 µs), a window that doubles from 15 to 1023 on a missing ACK, and an ACK after SIFS (16 µs). Priority is time. With 1500-byte frames at 54 Mb/s, 20 stations still get 52 % of the air.', ['csmacd', 'arq', 'hiddenterminal', 'rateadapt']),
  E('hiddenterminal', 'Hidden terminal', 'concept', 'Carrier sense asks whether anyone near the sender is talking, but the collision happens near the receiver. Two stations in range of the access point and not of each other each hear silence and send. RTS / CTS has the receiver announce the exchange: stations that hear its CTS set their NAV and stay quiet. In the chapter\'s model, over 400 ms of 1000 µs frames, 120 are delivered without it and 314 with it.', ['csmaca', 'layers', 'rateadapt']),
  E('rateadapt', 'Rate adaptation', 'trick', 'The transmitter cannot ask the channel its SNR, which can move by tens of dB in a fraction of a second, so it guesses from ACKs. 802.11a has eight rates, 6 to 54 Mb/s. The simplest rule, ARF, goes up after 10 good frames and down after 2 lost in a row; it cannot tell a collision from a fade, so a busy channel drives it down, which lengthens frames and adds collisions. Modern drivers keep statistics per rate and probe the others.', ['qam', 'fading', 'csmaca', 'shannon']),
  E('cellreuse', 'Cells and frequency reuse', 'concept', 'Many low-power masts reuse frequencies at a distance D = √(3K) R, where K = i² + ij + j² colours the hexagonal grid. At the cell edge SIR ≈ (D/R)<sup>n</sup> / 6, 18.7 dB for K = 7 and n = 4, the classic analog choice. Rate grows as log(1 + SIR) but linearly with bandwidth, so digital systems with strong coding went to reuse 1: on the chapter\'s model 2.67 b/s/Hz a cell against 1.09 for K = 7.', ['shannon', 'ofdm', 'pfscheduler', 'decibel']),
  E('handover', 'Handover', 'concept', 'A moving phone measures its neighbours and is handed over when one has been stronger than the serving cell by an offset plus hysteresis for a time to trigger (the LTE A3 event). With 3 dB of hysteresis, n = 3.5 and masts 1 km apart the switch happens at 549 m, not 500. Too little and shadowing makes the connection ping-pong; too much and the phone clings to a weak cell until it drops.', ['cellreuse', 'fading', 'pfscheduler', 'arq']),
  E('pfscheduler', 'Proportional-fair scheduling', 'tool', 'Serve, in each block, the user whose rate now is highest relative to their own recent average. Fading becomes an opportunity: with n users of equal mean SNR in Rayleigh fading the best has H<sub>n</sub> = 1 + ½ + … + 1/n times the mean, 2.72 for 8 users. At 10 dB the chapter\'s model gives 4.69 b/s/Hz to max-rate against 2.90 for round robin; proportional fair keeps most of that and starves no one.', ['fading', 'cellreuse', 'fairqueue', 'waterfill']),
  E('beamforming', 'Beamforming', 'trick', 'M antennas with a phase step each add in one direction and cancel in others: 10 log M dB of array gain. With the channels H of K users known, a zero-forcing precoder cancels each stream at every other user, giving each ρ (M − K + 1) / K. With 4 users at 0 dB, 8 antennas give 1.0 dB each and 64 give 11.8 dB. The price is knowing H: pilots, time-division duplex and pilot contamination.', ['mimo', 'cellreuse', 'fft', 'decibel']),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_B: Record<string, string> = {
  dispersion: 'glass', wdm: 'glass', edfa: 'glass', coherent: 'glass',
  linkbudget: 'radio', fading: 'radio', mimo: 'radio',
  csmaca: 'wifi', hiddenterminal: 'wifi', rateadapt: 'wifi',
  cellreuse: 'cellular', handover: 'cellular', pfscheduler: 'cellular', beamforming: 'cellular',
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_B: Record<string, string[]> = {
  dispersion: ['chromatic dispersion'],
  wdm: ['WDM', 'wavelength division multiplexing'],
  edfa: ['erbium-doped fibre amplifier'],
  linkbudget: ['link budget'],
  fading: ['Rayleigh fading'],
  csmaca: ['DCF', 'distributed coordination function'],
  rateadapt: ['Auto Rate Fallback'],
  cellreuse: ['frequency reuse'],
  pfscheduler: ['proportional fair'],
  beamforming: ['zero-forcing'],
};
