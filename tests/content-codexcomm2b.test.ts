// Group B of the extension's codex entries (glass, radio, wifi, cellular: codexcomm2b.ts, codexmore8b.ts, codexcheck10b.ts): every number
// they quote equal to the model that computes it, or to the chapter step that prints it. Completeness and form: tests/content-codexcomm2.test.ts.

import { describe, expect, it } from 'vitest';
import { codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { CODEX_B, TAUGHT_B } from '../src/campaign/codexcomm2b';
import { moreOf } from '../src/campaign/codexmore';
import { chapterById } from '../src/chapters';
import { dbToRatio } from '../src/comm/limits';
import { ACK_US, airtimeUs, bianchi, CW_MAX, CW_MIN, DIFS_US, goodputMbps, RATES, RESP_TIMEOUT, RETRY_LIMIT, RTS_US, SIFS_US, SLOT_US } from '../src/comm/wifi';
import { beta2Of, cdTaps, C_BAND, dispersionD, FEC_RATE, gridChannels, L_BAND, osnrDb, photonFloorDbm, QAMS, reachNarrowKm, reachWideKm, requiredSnrDb, snrFromOsnr, spacingNm } from '../src/phys/fibre';
import { apertureM2, bpskAwgn, bpskMrc, bpskRayleigh, coherenceMHz, coherenceTime, dopplerHz, fadeMarginDb, fsplDb, linkBudget, noiseFloorDbm, wavelengthM } from '../src/phys/radio';
import { crossingM, harmonic, reuseSweep, schedule, sirClosedDb, zfMeanSnr } from '../src/phys/cellular';
import { BUDGET_DEFAULT as D, WALL_DB } from '../src/widgets/radio';
import { hiddenCompare, HIDDEN_LEN_US, mimoCurves } from '../src/widgets/wifi';

const IDS = CODEX_B.map((e) => e.id);
const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
/** Everything an entry says: summary, fuller text, questions. */
function text(id: string): string {
  const m = moreOf(id)!;
  const qs = CHECKS[id] ?? [];
  return strip([codexById(id)!.body, m.idea, m.example?.title, m.example?.body, ...(m.mistakes ?? []),
    ...qs.flatMap((q) => [q.question, q.explain, ...q.options, ...(q.why ?? [])])].join(' '));
}
/** Digit groups spelled with a comma or a space compare equal (3,439 = 3 439). */
const flat = (s: string) => s.replace(/(\d)[, ](?=\d{3}(?!\d))/g, '$1');
const quotes = (id: string, ...s: (string | number)[]) => { const t = flat(text(id)); for (const x of s) expect(t, `${id}: ${x}`).toContain(flat(String(x))); };
/** The chapter step's prose (body and layers, tags stripped) contains the string. */
const says = (ch: string, step: number, s: string) => {
  const st = chapterById(ch)!.steps[step];
  expect(flat(strip([st.body, ...Object.values(st.more ?? {})].map(String).join(' '))), `${ch} ${step}: ${s}`).toContain(flat(s));
};
const nf = (x: number, d = 1) => x.toFixed(d);
const n0 = (x: number) => Math.round(x).toLocaleString('en-US').replace(/,/g, ' ');
/** Radio's solver: the SNR in dB at which a BER falls to a target. */
function solveDb(f: (x: number) => number, target: number): number {
  let lo = -5, hi = 60;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (f(dbToRatio(m)) > target) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

describe('the group B codex entries', () => {
  it('are the fourteen, each taught where its chapter says so', () => {
    expect(IDS).toEqual(['dispersion', 'wdm', 'edfa', 'coherent', 'linkbudget', 'fading', 'mimo', 'csmaca', 'hiddenterminal', 'rateadapt', 'cellreuse', 'handover', 'pfscheduler', 'beamforming']);
    expect(Object.keys(TAUGHT_B).sort()).toEqual([...IDS].sort());
  });

  it('dispersion: D, beta2 and the reach of a clean and of a wide source', () => {
    const D1550 = dispersionD(1550), B2 = beta2Of(D1550, 1550);
    expect(dispersionD(1310)).toBeCloseTo(0, 9);
    expect(nf(D1550)).toBe('17.5');
    expect(nf(Math.abs(B2))).toBe('22.3');
    expect(n0(reachNarrowKm(10, B2))).toBe('28');
    expect(nf(reachNarrowKm(40, B2))).toBe('1.8');
    expect(reachNarrowKm(10, B2) / reachNarrowKm(40, B2)).toBeCloseTo(16, 9);
    expect(nf(reachNarrowKm(10, B2) / reachNarrowKm(20, B2), 0)).toBe('4');
    expect(nf(reachNarrowKm(10, B2) / 4)).toBe('7.0');
    expect(nf(reachWideKm(10, D1550, 1))).toBe('1.4');
    expect(reachWideKm(10, D1550, 1) / reachWideKm(40, D1550, 1)).toBeCloseTo(4, 9);
    quotes('dispersion', '17.5 ps/(nm·km)', '22.3 ps²/km', '28 km', '1.8 km', '1.4 km', '7.0 km', '1310 nm');
    says('glass', 3, `${nf(D1550)} ps/(nm·km)`);
    says('glass', 3, `${n0(reachNarrowKm(10, B2))} km at 10 Gb/s and ${nf(reachNarrowKm(40, B2))} km at 40`);
    says('glass', 3, `${nf(reachWideKm(10, D1550, 1))} km at 10 Gb/s`);
    says('glass', 3, `${nf(B2)} ps²/km`);
  });

  it('wdm: the grid, the rates and the fibre\'s total', () => {
    const c50 = gridChannels(50), cl = c50 + gridChannels(50, L_BAND);
    const thz = 299792.458 / C_BAND[0] - 299792.458 / C_BAND[1];
    const r4 = 2 * 32 * QAMS[0].bitsPerPolSym * FEC_RATE, r16 = 2 * 32 * QAMS[1].bitsPerPolSym * FEC_RATE;
    expect([c50, gridChannels(100), cl]).toEqual([87, 44, 229]);
    expect(Math.round(thz * 1000 / 25)).toBe(175);
    expect(nf(thz)).toBe('4.4');
    expect(nf(spacingNm(50, 1550), 1)).toBe('0.4');
    expect(nf(spacingNm(100, 1550), 1)).toBe('0.8');
    expect(FEC_RATE).toBe(0.8);
    expect([r4.toFixed(0), r16.toFixed(0), nf(r16, 1)]).toEqual(['102', '205', '204.8']);
    expect(nf((c50 * r16) / 1000)).toBe('17.8');
    quotes('wdm', '87 channels', '0.4 nm', '229', '4.4 THz', '102 Gb/s', '205 Gb/s', '17.8 Tb/s', '193.1 THz', '150 GHz', '37.5 GHz');
    quotes('wdm', '1530 to 1565 nm');
    says('glass', 4, `${c50} channels at 50 GHz, each ${nf(spacingNm(50, 1550))} nm apart`);
    says('glass', 4, `it is ${cl}`);
    says('glass', 4, `QPSK is ${r4.toFixed(0)} Gb/s a channel and 16-QAM ${r16.toFixed(0)}`);
    says('glass', 4, `${nf((c50 * r16) / 1000)} Tb/s`);
    says('glass', 4, '193.1 THz');
    says('glass', 4, '128 GBd in 150 GHz');
    says('glass', 4, '32 GBd in 37.5 GHz');
  });

  it('edfa: the photon floor, the OSNR of a hundred spans and the five dB of shorter ones', () => {
    const o = osnrDb(0, 4.5, 16, 100), req = QAMS.map((q) => requiredSnrDb(q));
    expect(nf(photonFloorDbm(1550))).toBe('-58.0');
    expect(nf(o)).toBe('17.5');
    expect(nf(snrFromOsnr(o, 32))).toBe('13.4');
    expect(req.map((r) => nf(r))).toEqual(['6.3', '12.7', '18.4']);
    expect(nf(snrFromOsnr(o, 32) - req[1])).toBe('0.7');
    expect(snrFromOsnr(o, 32)).toBeLessThan(req[2]);
    expect(nf(8 - 10 * Math.log10(2), 0)).toBe('5');
    expect(nf(10 * Math.log10(2))).toBe('3.0');
    expect(osnrDb(0, 4.5, 16, 1000) - o).toBeCloseTo(-10, 9);
    quotes('edfa', '−58.0 dBm', '17.5 dB', '13.4 dB', '6.3', '12.7', '18.4', '0.7 dB', '980 or 1480 nm', '4.5 to 6', '1530 to 1565 nm', '50 to 80 km');
    says('glass', 5, `${nf(photonFloorDbm(1550))} dBm`);
    says('glass', 5, `OSNR = ${nf(o)} dB, an SNR of ${nf(snrFromOsnr(o, 32))} dB at 32 GBd`);
    says('glass', 5, `QPSK at the code's threshold needs ${nf(req[0])} dB, 16-QAM ${nf(req[1])}, 64-QAM ${nf(req[2])}`);
    says('glass', 5, 'gains 5 dB');
    says('glass', 5, '980 or 1480 nm');
    says('glass', 5, '3 dB at the quantum limit and about 4.5 to 6 in practice');
    says('glass', 5, 'ten times the spans costs only 10 dB');
    says('glass', 5, '50 to 80 km');
  });

  it('coherent: the taps of six thousand kilometres and the eight photodiodes', () => {
    const B2 = beta2Of(dispersionD(1550), 1550);
    expect(n0(cdTaps(B2, 6000, 32))).toBe('3 439');
    quotes('coherent', '3 439 taps', '6000 km', '32 GBd', '64 GS/s', 'Q(√SNR)', 'eight');
    says('glass', 6, `${n0(cdTaps(B2, 6000, 32))} taps at 64 GS/s`);
    says('glass', 6, 'Q(√SNR)');
    says('glass', 6, 'eight in all');
    says('glass', 6, 'fourth power');
    says('glass', 6, '90° hybrid');
  });

  it('linkbudget: the floor, the default budget and the move to 5.5 GHz', () => {
    const b0 = linkBudget({ txDbm: D.tx, gtDbi: D.ga, grDbi: D.ga, km: D.m / 1000, ghz: D.ghz, extraDb: D.walls * WALL_DB(D.ghz), mhz: D.mhz, nfDb: D.nf });
    const b5 = linkBudget({ txDbm: D.tx, gtDbi: D.ga, grDbi: D.ga, km: D.m / 1000, ghz: 5.5, extraDb: D.walls * WALL_DB(5.5), mhz: 80, nfDb: D.nf });
    expect([D.tx, D.ga, D.nf, D.m, D.walls, D.ghz, D.mhz]).toEqual([20, 2, 6, 50, 2, 2.4, 20]);
    expect(WALL_DB(2.4)).toBe(12);
    expect(nf(10 * Math.log10(20e6), 0)).toBe('73');
    expect(nf(noiseFloorDbm(20, 6), 0)).toBe('-95');
    expect(nf(noiseFloorDbm(20, 0), 0)).toBe('-101');
    expect(nf(noiseFloorDbm(80, 6), 0)).toBe('-89');
    expect([nf(b0.path), nf(b0.rx), nf(b0.noise), nf(b0.snr), nf(b0.capacityMbps, 0)]).toEqual(['74.0', '-74.0', '-95.0', '20.9', '139']);
    expect(D.walls * WALL_DB(D.ghz)).toBe(24);
    expect(nf(fsplDb(D.m / 1000, 5.5) - fsplDb(D.m / 1000, D.ghz))).toBe('7.2');
    expect(nf((WALL_DB(5.5) - WALL_DB(2.4)) * D.walls, 0)).toBe('8');
    expect([nf(b5.snr), nf(b5.capacityMbps, 0)]).toEqual(['-0.3', '76']);
    expect(nf(apertureM2(0, 2.4) * 1e4, 0)).toBe('12');
    expect(nf(apertureM2(0, 28) * 1e4, 2)).toBe('0.09');
    expect(fsplDb(0.1, 2.4) - fsplDb(0.05, 2.4)).toBeCloseTo(6.02, 2);
    expect(fsplDb(0.05, 4.8) - fsplDb(0.05, 2.4)).toBeCloseTo(6.02, 2);
    // the closed form quoted: 20 log d + 20 log f + 92.45
    expect(fsplDb(0.05, 2.4)).toBeCloseTo(20 * Math.log10(0.05) + 20 * Math.log10(2.4) + 92.45, 2);
    quotes('linkbudget', '−174 dBm/Hz', '73 dB', '−95 dBm', '−101 dBm', '−89 dBm', '74.0 dB', '24 dB', '−74.0 dBm', '−95.0 dBm', '20.9 dB', '139 Mb/s', '7.2 dB', '−0.3 dB', '76 Mb/s', '12 cm²', '0.09 cm²', '92.45');
    says('radio', 2, `the path is ${nf(b0.path)} dB, ${nf(b0.rx)} dBm arrives, the SNR is ${nf(b0.snr)} dB, and Shannon says ${nf(b0.capacityMbps, 0)} Mb/s`);
    says('radio', 2, `${nf(fsplDb(D.m / 1000, 5.5) - fsplDb(D.m / 1000, D.ghz))} dB more path, 8 dB more walls and 6 dB more noise, leaving ${nf(b5.snr)} dB, for ${nf(b5.capacityMbps, 0)} Mb/s`);
    says('radio', 2, `a ${D.nf} dB noise figure makes ${nf(noiseFloorDbm(20, D.nf), 0)} dBm`);
    says('radio', 2, '−174 dBm/Hz');
    says('radio', 1, '20 log d + 20 log f + 92.45');
    says('radio', 0, `${nf(apertureM2(0, 2.4) * 1e4, 0)} cm², at 28 GHz only ${nf(apertureM2(0, 28) * 1e4, 2)} cm²`);
  });

  it('fading: Doppler, coherence time and bandwidth, the BER and the margin', () => {
    const fd = dopplerHz(100, 2);
    const aw = solveDb(bpskAwgn, 1e-3), ray = solveDb(bpskRayleigh, 1e-3), two = solveDb((x) => bpskMrc(x, 2), 1e-3), four = solveDb((x) => bpskMrc(x, 4), 1e-3);
    expect(nf(fd, 0)).toBe('185');
    expect(nf(coherenceTime(fd) * 1000)).toBe('2.3');
    expect(nf(coherenceTime(dopplerHz(200, 2)) * 1000)).toBe('1.1');
    expect(nf(coherenceMHz(50), 0)).toBe('4');
    expect(coherenceMHz(1000) * 1000).toBeCloseTo(200, 6);
    expect(20 / 256 * 1000).toBeCloseTo(78.125, 6);
    expect(bpskAwgn(dbToRatio(10)).toExponential(0)).toBe('4e-6');
    expect(bpskRayleigh(dbToRatio(10)).toExponential(0)).toBe('2e-2');
    const g = dbToRatio(10);
    expect(bpskRayleigh(g)).toBeCloseTo(0.5 * (1 - Math.sqrt(g / (1 + g))), 12);
    expect(nf(fadeMarginDb(0.01), 0)).toBe('20');
    expect([nf(aw), nf(ray), nf(two), nf(four)]).toEqual(['6.8', '24.0', '11.1', '4.0']);
    expect(nf(ray - two, 0)).toBe('13');
    quotes('fading', '185 Hz', '2.3 ms', '1.1 ms', '4 MHz', '200 kHz', '78 kHz', '4 × 10⁻⁶', '2 × 10⁻²', '20 dB', '6.8 dB', '24.0 dB', '0.42 / f');
    says('radio', 6, `${nf(fd, 0)} Hz at 100 km/h at 2 GHz`);
    says('radio', 6, `${nf(coherenceTime(fd) * 1000)} ms`);
        says('radio', 6, 'At 10 dB, 4 × 10⁻⁶ without fading and 2 × 10⁻² with it');
    says('radio', 6, `fade margin of ${nf(fadeMarginDb(0.01), 0)} dB`);
    says('radio', 6, '0.42 / f');
    says('radio', 5, 'about 1 / (5 τ)');
    says('radio', 5, `τ = 50 ns, ${nf(coherenceMHz(50), 0)} MHz`);
  });

  it('mimo: the diversity and the multiplexing numbers', () => {
    const aw = solveDb(bpskAwgn, 1e-3), ray = solveDb(bpskRayleigh, 1e-3), two = solveDb((x) => bpskMrc(x, 2), 1e-3), four = solveDb((x) => bpskMrc(x, 4), 1e-3);
    const M = mimoCurves(0);
    expect([nf(M.mean(30)), nf(M.siso(30))]).toEqual(['17.8', '9.2']);
    expect([nf(M.mean(40) - M.mean(37)), nf(M.siso(40) - M.siso(37))]).toEqual(['2.0', '1.0']);
    quotes('mimo', '24.0 dB', '11.1 dB', '4.0 dB', '6.8 dB', '13 dB', '17.8 b/s/Hz', '9.2', '+2.0', '400 channels');
    says('radio', 7, `${nf(aw)} dB with no fading and ${nf(ray)} dB in Rayleigh fading with one antenna. Two antennas: ${nf(two)} dB. Four: ${nf(four)}`);
    says('radio', 7, `worth ${nf(ray - two, 0)} dB`);
    says('wifi', 6, `${nf(M.mean(30))} b/s/Hz against ${nf(M.siso(30))}`);
    says('wifi', 6, 'each 3 dB buys <em>2</em> b/s/Hz'.replace(/<\/?em>/g, ''));
    says('wifi', 6, 'Foschini and Telatar');
  });

  it('csmaca: the timings, Bianchi and the goodput', () => {
    const R54 = RATES[7], L = airtimeUs(1528, R54.ndbps), b2 = bianchi(2, L), b20 = bianchi(20, L);
    expect([SLOT_US, SIFS_US, DIFS_US, ACK_US, RESP_TIMEOUT, CW_MIN, CW_MAX, RETRY_LIMIT]).toEqual([9, 16, 34, 28, 53, 15, 1023, 7]);
    expect(DIFS_US).toBe(SIFS_US + 2 * SLOT_US);
    expect(L).toBe(248);
    expect([nf(b2.throughput * 100, 0), nf(b20.throughput * 100, 0), nf(b20.p * 100, 0)]).toEqual(['65', '52', '48']);
    expect(nf(goodputMbps(1500, R54), 0)).toBe('30');
    expect(nf((CW_MIN / 2) * SLOT_US, 0)).toBe('68');
    quotes('csmaca', '9 µs', '16 µs', '34 µs', '28 µs', '53 µs', '15', '1023', '248 µs', '65 %', '52 %', '48 %', '30 Mb/s', '54 Mb/s', '10 %');
    says('wifi', 1, `${DIFS_US} µs`);
    says('wifi', 1, `from ${CW_MIN} up to ${CW_MAX}`);
    says('wifi', 1, `${RETRY_LIMIT} tries in all`);
    says('wifi', 1, `${RESP_TIMEOUT} µs in all`);
    says('wifi', 1, 'DIFS = SIFS + 2 slots');
    says('wifi', 1, 'Priority is time');
    says('wifi', 2, `2 stations get ${nf(b2.throughput * 100, 0)} % of the air and 20 get ${nf(b20.throughput * 100, 0)} %, with ${nf(b20.p * 100, 0)} % of tries colliding`);
    says('wifi', 2, 'within 10 %');
    says('wifi', 5, `The goodput is ${nf(goodputMbps(1500, R54), 0)} Mb/s of 54`);
    says('wifi', 5, `average backoff (${nf((CW_MIN / 2) * SLOT_US, 0)})`);
  });

  it('csmaca: a neighbour 20 m away is 73 dB under the station\'s own signal', () => {
    expect(nf(fsplDb(0.02, 5.5), 0)).toBe('73');
    quotes('csmaca', '73 dB');
    says('wifi', 0, `${nf(fsplDb(0.02, 5.5), 0)} dB under what you are sending`);
  });

  it('hiddenterminal: the model\'s frames with and without RTS / CTS', () => {
    const H = hiddenCompare();
    expect([H.plain, H.plainDropped, H.rts, H.a, H.b]).toEqual([120, 25, 314, 199, 115]);
    expect(H.a + H.b).toBe(H.rts);
    expect([RTS_US, HIDDEN_LEN_US, RETRY_LIMIT]).toEqual([28, 1000, 7]);
    quotes('hiddenterminal', '120 frames', '25 dropped', '314 frames', '199 to 115', '28 µs', '1000 µs', '400 ms');
    says('wifi', 3, `deliver ${H.plain} frames without it (dropping ${H.plainDropped}) and ${H.rts} with it`);
    says('wifi', 3, `${H.a} against ${H.b}`);
    says('wifi', 3, `${RTS_US} µs`);
    says('wifi', 3, `${HIDDEN_LEN_US} µs frames`);
    says('wifi', 3, `after ${RETRY_LIMIT} tries`);
    says('wifi', 3, 'exposed terminal');
  });

  it('rateadapt: the eight rates, their airtime and goodput, and the ARF rule', () => {
    const at = (i: number) => airtimeUs(1528, RATES[i].ndbps), gp = (i: number) => goodputMbps(1500, RATES[i]);
    expect(RATES.length).toBe(8);
    expect([RATES[0].mbps, RATES[0].snrDb, RATES[7].mbps, RATES[7].snrDb, RATES[4].mbps, RATES[4].snrDb]).toEqual([6, 5, 54, 23, 24, 13]);
    expect([at(0), at(4), at(7)]).toEqual([2064, 532, 248]);
    expect([nf(gp(0)), nf(gp(4)), nf(gp(7))]).toEqual(['5.4', '17.7', '30.5']);
    expect(nf(gp(7) / gp(0))).toBe('5.7');
    expect(54 / 6).toBe(9);
    expect(nf(at(0) / at(7))).toBe('8.3');
    quotes('rateadapt', '6 Mb/s', '54 Mb/s', '2064 µs', '532 µs', '248 µs', '5.4 Mb/s', '17.7 Mb/s', '30.5 Mb/s', '5.7 times', '10 good frames', '2 lost in a row', '5 dB', '23 dB', '13 dB', '1997', '34', '68', '16', '28');
    says('wifi', 4, 'after 10 good frames go up a rate; after 2 lost in a row come down');
    says('wifi', 4, 'Auto Rate Fallback (1997)');
    says('wifi', 4, '6 Mb/s');
    says('wifi', 4, '54 Mb/s');
    says('wifi', 4, 'Minstrel');
    says('wifi', 4, 'by tens of dB in a fraction of a second');
    says('wifi', 5, `lasts ${at(7)} µs`);
    says('wifi', 5, 'preamble 20 µs');
  });

  it('cellreuse: the closed-form SIR and the model\'s reuse sweep', () => {
    const S1 = reuseSweep(1, 3.5, 1500), S3 = reuseSweep(3, 3.5, 1500), S7 = reuseSweep(7, 3.5, 1500);
    expect(nf(sirClosedDb(7, 4))).toBe('18.7');
    expect(nf(sirClosedDb(3, 4))).toBe('11.3');
    expect(nf(Math.sqrt(21), 2)).toBe('4.58');
    expect(Math.round(21 ** 2)).toBe(441);
    expect(nf(441 / 6)).toBe('73.5');
    expect(nf(10 * Math.log10(441), 1)).toBe('26.4');
    expect(nf(10 * Math.log10(21 / 6), 1)).toBe('5.4');
    expect([nf(S1.medianDb, 0), nf(S3.medianDb, 0), nf(S7.medianDb, 0)]).toEqual(['4', '14', '21']);
    expect([nf(S1.perCell, 2), nf(S3.perCell, 2), nf(S7.perCell, 2)]).toEqual(['2.67', '1.79', '1.09']);
    expect(nf(S1.perCell / S7.perCell)).toBe('2.5');
    quotes('cellreuse', '18.7 dB', '11.3 dB', '4.58', '441', '73.5', '26.4 dB', '5.4 dB', '2.67', '1.79', '1.09', '2.5 times', '4 dB', '21 dB', '14 dB', 'four times', '18 dB');
    says('cellular', 0, `${nf(sirClosedDb(7, 4))} dB`);
    says('cellular', 0, `median SIR of ${nf(S1.medianDb, 0)} dB`);
    says('cellular', 0, `${nf(S1.perCell, 2)} b/s/Hz a cell; K = 3 carries ${nf(S3.perCell, 2)} and K = 7 ${nf(S7.perCell, 2)}`);
    says('cellular', 0, 'D = √(3K) R');
    says('cellular', 0, 'SIR ≈ (D / R)ⁿ / 6');
    says('cellular', 0, 'FM voice needed about 18 dB');
    says('cellular', 0, 'Ring and Young');
  });

  it('handover: where the switch happens', () => {
    expect(nf(crossingM(1000, 3.5, 3), 0)).toBe('549');
    expect(nf(crossingM(1000, 3.5, 0), 0)).toBe('500');
    quotes('handover', '549 m', '500', '3 dB', '320 ms', '−110 dBm', '1 km', 'A3');
    says('cellular', 3, `${nf(crossingM(1000, 3.5, 3), 0)} m rather than 500`);
    says('cellular', 3, '320 ms');
    says('cellular', 3, '−110 dBm');
    says('cellular', 3, 'A3 event');
    says('cellular', 3, 'ping-pong');
  });

  it('pfscheduler: the harmonic gain and the model\'s two schedulers', () => {
    const m = Array<number>(8).fill(10);
    const rr = schedule('rr', m, 20000, 1).total, mx = schedule('max', m, 20000, 2).total;
    expect(nf(harmonic(8), 2)).toBe('2.72');
    expect([nf(rr, 2), nf(mx, 2)]).toEqual(['2.90', '4.69']);
    quotes('pfscheduler', '2.72', '4.69', '2.90', '8 users', '10 dB');
    says('cellular', 2, `A cell with 8 users serves at ${nf(harmonic(8), 2)} times the mean SNR`);
    says('cellular', 2, `${nf(mx, 2)} against round robin's ${nf(rr, 2)} b/s/Hz for 8 users at 10 dB`);
    says('cellular', 2, 'multi-user diversity');
  });

  it('beamforming: zero-forcing SNR for 8 and 64 antennas, and the added users', () => {
    const db = (K: number, M: number) => 10 * Math.log10(zfMeanSnr(K, M, 0));
    expect([nf(db(4, 8)), nf(db(4, 64))]).toEqual(['1.0', '11.8']);
    expect(zfMeanSnr(4, 8, 0)).toBeCloseTo(5 / 4, 12);
    expect(zfMeanSnr(4, 64, 0)).toBeCloseTo(61 / 4, 12);
    expect(nf(10 * Math.log10(8))).toBe('9.0');
    expect(nf(10 * Math.log10(5))).toBe('7.0');
    expect(nf(zfMeanSnr(4, 64, 0) / zfMeanSnr(8, 64, 0), 2)).toBe('2.14');
    expect(zfMeanSnr(8, 64, 0)).toBeCloseTo(57 / 8, 12);
    expect(nf(wavelengthM(28) * 500, 1)).toBe('5.4');
    quotes('beamforming', '1.0 dB', '11.8 dB', '9.0 dB', '7.0 dB', '5 / 4', '1.25', '15.25', '61 / 4', '57/8', '2.14', '5.4 mm', '2010', '1 / √M', '32 to 64');
    says('cellular', 4, `8 antennas give ${nf(db(4, 8))} dB each and 64 give ${nf(db(4, 64))}`);
    says('cellular', 4, 'SNR = ρ (M − K + 1) / K');
    says('cellular', 4, 'Marzetta, 2010');
    says('cellular', 4, '1 / √M');
    says('cellular', 4, '32 to 64 digital chains');
    says('cellular', 4, 'pilot contamination');
    says('radio', 0, `${nf(wavelengthM(28) * 500, 1)} mm`);
    says('radio', 0, '10 log n dB');
    says('wifi', 6, 'Multi-user MIMO');
  });
});
