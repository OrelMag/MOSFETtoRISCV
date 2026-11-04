// The Communication entries (codexcomm.ts, codexmore4/5.ts, codexcheck6/7.ts): complete, linked to real chapter steps, and every
// number they quote equal to the comm/ and phys/ models and the library, or to the chapter step that prints it.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { CHECK6 } from '../src/campaign/codexcheck6';
import { CHECK7 } from '../src/campaign/codexcheck7';
import { CODEX_COMM, COMM_AWAITING_LEVELS } from '../src/campaign/codexcomm';
import { moreOf } from '../src/campaign/codexmore';
import { NODES } from '../src/campaign/nodes';
import { chapterById } from '../src/chapters';
import { TAUGHT } from '../src/chapters/taught';
import { ADSL, bitLoad, bitsForTone, bitsOf, gapDb, snrForSer } from '../src/comm/modem';
import { ebn0AtCapacity, EBN0_MIN, levelsSupported, nyquistBitRate, nyquistSymbolRate, ratioToDb, shannonDb, snrNeeded } from '../src/comm/limits';
import { aOf, fullWindow, rttOf, utilization } from '../src/comm/arq';
import { CRC32_POLY, crc32 } from '../src/comm/crc';
import { fftMults } from '../src/comm/fourier';
import { burstTolerance, worstPerWord } from '../src/comm/interleave';
import { I2C_MODES, RISE_30_70, rpMax, rpMin } from '../src/comm/i2c';
import { overhead } from '../src/comm/linecode';
import { SPI_MODES, modeNumber } from '../src/comm/spi';
import { divisorFor } from '../src/comm/uart';
import { crcNext, crcUnit } from '../src/lib/crc';
import { resolveComponent } from '../src/lib/resolve';
import { rsEncoder, rsSyndrome, gfMulGates } from '../src/lib/rs';
import { SYNC2, PULSE_SYNC, BIN2GRAY, GRAY2BIN, asyncFifo } from '../src/lib/sync';
import { fifo } from '../src/lib/storage';
import { convEncoder } from '../src/lib/viterbi';
import { CONV_K3, CONV_K7 } from '../src/comm/conv';
import { stats } from '../src/sim/stats';

const IDS = CODEX_COMM.map((e) => e.id);
const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
/** Everything an entry says: summary, fuller text, questions. */
function text(id: string): string {
  const m = moreOf(id)!;
  const qs = CHECKS[id] ?? [];
  return strip([codexById(id)!.body, m.idea, m.example?.title, m.example?.body, ...(m.mistakes ?? []),
    ...qs.flatMap((q) => [q.question, q.explain, ...q.options, ...(q.why ?? [])])].join(' '));
}
const c = (n: number) => n.toLocaleString('en-US');
const nands = (d: { id: string }) => stats(resolveComponent(d.id) ?? (d as never)).nands;
/** Digit groups spelled with a comma or a space compare equal (7,452 = 7 452). */
const flat = (s: string) => s.replace(/(\d)[, ](?=\d{3}(?!\d))/g, '$1');
const quotes = (id: string, ...s: (string | number)[]) => { const t = flat(text(id)); for (const x of s) expect(t, `${id}: ${x}`).toContain(flat(String(x))); };
/** The chapter step's prose (body and layers, tags stripped) contains the string. */
const says = (ch: string, step: number, s: string) => {
  const st = chapterById(ch)!.steps[step];
  expect(flat(strip([st.body, ...Object.values(st.more ?? {})].map(String).join(' '))), `${ch} ${step}: ${s}`).toContain(flat(s));
};

describe('the Communication codex entries', () => {
  it('are complete: summary, fuller text, chapters, answer-first questions, a TAUGHT row, no level yet', () => {
    expect(IDS.length).toBe(18);
    for (const e of CODEX_COMM) {
      const m = moreOf(e.id)!;
      expect(m?.idea, `${e.id}: idea`).toBeTruthy();
      expect(m.example?.body, `${e.id}: example`).toBeTruthy();
      expect(m.mistakes?.length, `${e.id}: mistakes`).toBeGreaterThanOrEqual(3);
      expect(m.chapters?.length, `${e.id}: chapters`).toBeGreaterThan(0);
      expect(e.related?.length, `${e.id}: related`).toBeGreaterThan(0);
      for (const r of e.related!) expect(codexById(r), `${e.id} → ${r}`).toBeTruthy();
      expect(CHECKS[e.id]?.length, `${e.id}: questions`).toBe(2);
      for (const q of CHECKS[e.id]) expect(q.answer, `${e.id}: answer first`).toBe(0);
      expect(TAUGHT[e.id], `${e.id}: TAUGHT`).toBeTruthy();
      expect(m.chapters!.map((l) => l.chapter), `${e.id}: taught chapter is a link`).toContain(TAUGHT[e.id]);
    }
    expect(Object.keys({ ...CHECK6, ...CHECK7 }).sort()).toEqual([...IDS].sort());
  });

  it('link real chapter steps by their titles, and real library parts', () => {
    for (const e of CODEX_COMM) {
      const m = moreOf(e.id)!;
      for (const l of m.chapters!) {
        const ch = chapterById(l.chapter);
        expect(ch, `${e.id}: ${l.chapter}`).toBeTruthy();
        expect(l.step ?? 0).toBeLessThan(ch!.steps.length);
        if (l.step !== undefined) expect(l.label, `${e.id}: ${l.chapter} step ${l.step}`).toBe(ch!.steps[l.step].title);
      }
      for (const id of [m.lib, ...(m.compare ?? [])]) if (id) expect(resolveComponent(id), `${e.id}: part ${id}`).toBeTruthy();
    }
    for (const id of ['metastability', 'ecc']) for (const l of moreOf(id)!.chapters!) {
      const ch = chapterById(l.chapter)!;
      if (l.step !== undefined) expect(l.label, `${id}: ${l.chapter} step ${l.step}`).toBe(ch.steps[l.step].title);
    }
  });

  it('wait for Act 12\'s levels: the exemption holds only ids no level lists', () => {
    const taught = new Set(NODES.flatMap((n) => n.codex));
    for (const id of COMM_AWAITING_LEVELS) expect(taught.has(id), `${id} is taught now: drop it from COMM_AWAITING_LEVELS`).toBe(false);
    for (const id of IDS) expect(taught.has(id) || COMM_AWAITING_LEVELS.has(id), `${id}: in a level or awaiting one`).toBe(true);
  });

  it('quote the limits as computed', () => {
    expect(nyquistSymbolRate(3100)).toBe(6200);
    expect(nyquistBitRate(3100, 16) / 1000).toBeCloseTo(24.8, 5);
    expect(shannonDb(3100, 30) / 1000).toBeCloseTo(30.9, 1);
    expect(levelsSupported(1000)).toBeCloseTo(31.6, 1);
    expect(snrNeeded(4)).toBe(15);
    expect(16 ** 2 - 1).toBe(255);
    expect(levelsSupported(255)).toBe(16);
    expect(ratioToDb(255)).toBeCloseTo(24.1, 1);
    expect(ratioToDb(EBN0_MIN)).toBeCloseTo(-1.59, 2);
    quotes('shannon', '6200 symbols', '31.6 levels', '30.9 kb/s', '24.8 kb/s', '255 (24.1 dB)', '-1.59 dB'.replace('-', '−'), '9.2 dB');
    says('telegraph', 5, '31.6 levels and 30.9 kb/s');
    says('telegraph', 4, '24.8 kb/s');
    expect(ebn0AtCapacity(0)).toBeDefined();
  });

  it('quote the line as computed', () => {
    const launch = 1.8 * 50 / (10 + 50), gd = (10 - 50) / (10 + 50);
    expect(launch).toBeCloseTo(1.5, 10);
    expect(2 * launch).toBeCloseTo(3.0, 10);
    expect(gd).toBeCloseTo(-0.67, 2);
    expect(1.8 * 50 / (40 + 10 + 50)).toBeCloseTo(0.9, 10);
    expect((2 * 150 * 6.67 / 1000).toFixed(2)).toBe('2.00'); // 300 mm · 6.67 ps/mm
    quotes('reflection', '1.50 V', '3.00 V', '−0.67', '2.00 ns', '0.90 V', '45 mW', '13 Ω');
    says('wire', 4, '1.50 V'); says('wire', 4, '3.00 V'); says('wire', 4, '2.00 ns'); says('wire', 4, '13 Ω');
    says('wire', 5, '0.90 V'); says('wire', 5, '45 mW');
  });

  it('quote the clock crossing as built', () => {
    expect(nands(SYNC2)).toBe(22);
    expect(nands(PULSE_SYNC)).toBe(52);
    expect(nands(BIN2GRAY(4))).toBe(12);
    expect(nands(GRAY2BIN(4))).toBe(12);
    const af = nands(asyncFifo(2, 8)), sf = nands(fifo(2, 8));
    expect([af, sf]).toEqual([998, 757]);
    expect(Math.round(100 * (af / sf - 1))).toBe(32);
    quotes('cdc', '22 NANDs', '52 NANDs', 'Gray');
    quotes('asyncfifo', '998 NANDs', '757 NANDs', '+32 %', '132 NANDs');
    says('clocks', 8, '998 NANDs'); says('clocks', 8, '757'); says('clocks', 8, '132 NANDs'); says('clocks', 5, '22 NANDs'); says('clocks', 6, '52 NANDs');
    says('clocks', 7, '33 %'); says('clocks', 7, '12 NANDs for 4 bits');
    const g = (b: number) => b ^ (b >> 1);
    expect([g(7), g(8)]).toEqual([0b0100, 0b1100]);
  });

  it('quote the UART as built and as searched', () => {
    const d27 = divisorFor(50e6, 115200), d12 = divisorFor(12e6, 115200);
    expect(d27.div).toBe(27);
    expect(Math.round(d27.actual)).toBe(115741);
    expect((d27.error * 100).toFixed(2)).toBe('0.47');
    expect([d12.div, (d12.error * 100).toFixed(1)]).toEqual([7, '-7.0']);
    expect(divisorFor(1843200, 115200).div).toBe(1);
    expect(Math.round(50e6 / 27)).toBe(1851852);
    expect((10 / 115200 * 1e6).toFixed(1)).toBe('86.8');
    expect((10 / 3e6 * 1e6).toFixed(1)).toBe('3.3');
    expect(nands(resolveComponent('uart_rx')!)).toBe(526);
    expect(nands(fifo(4, 8))).toBe(2803);
    expect(nands(resolveComponent('uart_full')!)).toBe(7307);
    quotes('uart', '115 741', '0.47 %', '86.8 µs', '526 NANDs', '2 803 NANDs', '7 307', '5.55 %', '4.9 %', '1 851 852', 'divisor (7)', '7.0 %', '3.3 µs');
    says('uart', 3, '526 NANDs'); says('uart', 3, '5.55 % slower and 4.9 % faster'); says('uart', 3, '±5.56 %'); quotes('uart', '±5.56 %');
    says('uart', 5, '86.8 µs'); says('uart', 5, '2 803 NANDs'); says('uart', 5, '7 307');
    says('uart', 2, '0.47 %');
  });

  it('quote SPI and I²C as built and computed', () => {
    expect(nands(resolveComponent('spi_master')!)).toBe(397);
    expect(SPI_MODES.map(modeNumber)).toEqual([0, 1, 2, 3]);
    says('spi', 2, '397 NANDs'); says('spi', 1, '34 system clocks');
    quotes('spi', '397 NANDs', '34 system clocks');
    const [std, fast, plus] = I2C_MODES;
    expect(RISE_30_70).toBeCloseTo(0.8473, 4);
    expect(Math.round(rpMax(fast, 100e-12))).toBe(3541);
    expect(Math.round(rpMax(std, 100e-12))).toBe(11802);
    expect(Math.round(rpMin(fast, 3.3))).toBe(967);
    expect(Math.round(rpMax(fast, 400e-12))).toBe(885);
    expect(Math.round(1e12 * fast.trMax / (RISE_30_70 * rpMin(fast, 3.3)))).toBe(366);
    expect(plus.iol).toBe(20e-3);
    quotes('i2c', '3541 Ω', '11802 Ω', '967 Ω', '885 Ω', '366 pF', '0.8473', '659 NANDs', '1 638');
    says('spi', 5, '3541 Ω'); says('spi', 5, '11802 Ω'); says('spi', 5, '967 Ω'); says('spi', 5, '885 Ω'); says('spi', 5, '366 pF');
    says('spi', 6, '659 NANDs'); says('spi', 6, '1 638 NANDs');
  });

  it('quote the modem as computed', () => {
    const need = (M: number) => snrForSer('qam', M, 1e-6).toFixed(1);
    expect([need(4), need(16), need(64), need(256), need(1024)]).toEqual(['13.8', '20.9', '27.2', '33.3', '39.3']);
    expect(bitsOf(256)).toBe(8);
    expect((3429 * 8 / 1000).toFixed(1)).toBe('27.4');
    quotes('qam', '13.8 dB', '20.9', '27.2', '33.3', '39.3 dB', '27.4 kb/s', '3429', '9.2 dB', '747 NANDs', '342 NANDs');
    says('modem', 5, '13.8 dB'); says('modem', 5, '39.3 dB'); says('modem', 5, '27.4 kb/s'); says('modem', 5, '9.2 dB'); says('modem', 4, '747 NANDs');
    expect(fftMults(512)).toBe(2304);
    expect(512 ** 2).toBe(262144);
    expect(Math.round(262144 / 2304)).toBe(114);
    expect(ADSL.tones * ADSL.spacingHz).toBe(1104000);
    expect(512 * ADSL.spacingHz).toBe(2208000);
    expect((2208000 / 544).toFixed(1)).toBe('4058.8');
    const l3 = bitLoad(3, -120, gapDb(1e-7)), l5 = bitLoad(5, -120, gapDb(1e-7));
    expect(gapDb(1e-7).toFixed(1)).toBe('10.0');
    expect(bitsForTone(100, 10.0)).toBe(15);
    quotes('ofdm', '2,304', '262,144', '114', '4,312.5 Hz', '1.104 MHz', '4 058.8', '19.2 %', '15');
    says('modem', 7, '2,304'); says('modem', 7, '262,144'); says('modem', 7, '114 times'); says('modem', 7, '19.2 %'); says('modem', 7, '4058.8');
    says('modem', 8, '1682'); says('modem', 8, '6.73 Mb/s'); says('modem', 8, '370 bits'); says('modem', 8, '1.48 Mb/s');
    expect([l3.total, l5.total]).toEqual([1682, 370]);
    quotes('ofdm', '1682', '6.73 Mb/s', '370 bits', '1.48 Mb/s');
  });

  it('quote the serial link as built and as the chapter prints it', () => {
    expect(overhead).toMatchObject({ manchester: 1, '8b/10b': 0.25 });
    expect((overhead['64b/66b'] * 100).toFixed(1)).toBe('3.1');
    expect(10 * 66 / 64).toBe(10.3125);
    expect(nands(resolveComponent('manch_enc')!)).toBe(5);
    expect(nands(resolveComponent('enc8b10b')!)).toBe(1195);
    expect(nands(resolveComponent('dec8b10b')!)).toBe(1795);
    expect(nands(resolveComponent('cdr')!)).toBe(487);
    quotes('linecode', '5 NANDs', '25 %', '3.1 %', '10.3125', '1.25 Gbaud', '141 of the 268', '464', '560', '1195', '1795', '113 NANDs', '58 bits');
    says('serial', 1, '141 of the 268'); says('serial', 1, '464'); says('serial', 1, '560'); says('serial', 1, '1195 NANDs for the encoder and 1795');
    says('serial', 2, '10.3125'); says('serial', 2, '113 NANDs'); says('serial', 0, '5 NANDs');
    quotes('cdr', '487 NANDs', '1.25 %', '3.7 %', '5.8 %', '2.0 %', '3.1 %', '±3.0 %', '100 ppm');
    says('serial', 4, '487 NANDs'); says('serial', 4, '1.25 %'); says('serial', 4, 'ρ ⁄ (4 × 4)');
    for (const s of ['59 % edges, ceiling 3.7 %', '93 % edges, ceiling 5.8 %', '33 % edges, ceiling 2.0 %', '50 % edges, ceiling 3.1 %']) says('serial', 4, s);
    expect([0.2 / 16, 0.59 / 16, 0.93 / 16, 0.33 / 16, 0.5 / 16].map((x) => (x * 100).toFixed(2))).toEqual(['1.25', '3.69', '5.81', '2.06', '3.13']);
  });

  it('quote the eye and the equalizers from the one-pole closed forms', () => {
    const a = (R: number) => Math.exp(-2 * Math.PI * 1 / R);
    expect(a(6).toFixed(3)).toBe('0.351');
    expect(a(8).toFixed(3)).toBe('0.456');
    expect(Math.round(100 * (1 - 2 * a(6)))).toBe(30);
    expect(Math.round(100 * (1 - 2 * a(8)))).toBe(9);
    expect(Math.round(100 * (1 - a(8) - a(8) ** 2))).toBe(34);
    expect((2 * Math.PI / Math.LN2).toFixed(2)).toBe('9.06');
    quotes('eye', '0.351', '0.456', '30 %', '9 %', '9.06', '7.03 σ');
    says('serial', 6, 'a = 0.351'); says('serial', 6, '9.06 × B'); says('serial', 6, '7.03 σ'); says('serial', 6, 'the eye is 30 % open'); says('serial', 6, '4 × 10⁻14');
    quotes('equalization', '9 %', '23 %', '58 %', '34 %', '1.84', '74 mV', '125 ps', '9.54 dB');
    says('serial', 7, 'a = 0.456'); says('serial', 7, '23 %'); says('serial', 7, '58 %'); says('serial', 7, '1.84'); says('serial', 7, '74 mV'); says('serial', 7, '34 %'); says('serial', 7, '125 ps');
    says('serial', 8, '9.54 dB');
  });

  it('quote the codes as built and as computed', () => {
    expect(crc32(Uint8Array.from('123456789', (ch) => ch.charCodeAt(0)))).toBe(0xcbf43926);
    expect(CRC32_POLY).toBe(0x04c11db7);
    expect((2 ** -32).toExponential(1)).toBe('2.3e-10');
    expect((2 ** 32 / 5260 / 86400).toFixed(1)).toBe('9.5');
    expect(nands(crcUnit(32, undefined, 1, true))).toBe(795);
    expect(nands(crcUnit(32, undefined, 8, true))).toBe(1027);
    expect(nands(crcNext(32, undefined, 1, true))).toBe(56);
    expect(nands(crcNext(32, undefined, 8, true))).toBe(288);
    quotes('crc', '0x04C11DB7', '0xCBF43926', '795 NANDs', '1,027 NANDs', '56 NANDs', '288', '880', '9.5 days', '5 260', '12 032', '2.3 × 10−10', '2.50 GHz', '14.5 Gb/s');
    says('errors', 2, '0xCBF43926'); says('errors', 3, '9.5 days'); says('errors', 3, '5,260'); says('errors', 4, '795 NANDs'); says('errors', 4, '56 NANDs');
    says('errors', 5, '880 NANDs'); says('errors', 5, '288 NANDs'); says('errors', 5, '1,027 NANDs'); says('errors', 5, '14.5 Gb/s');
    // ARQ
    const a = aOf(10e-3, 12032, 63.2e6);
    expect(a).toBeCloseTo(52.7, 0);
    const A = 52.7;
    expect((100 * utilization('saw', A, 1, 0.01)).toFixed(2)).toBe('0.93');
    expect((100 * utilization('gbn', A, fullWindow(A), 0.01)).toFixed(1)).toBe('48.2');
    expect(fullWindow(A)).toBe(107);
    expect(Math.floor(rttOf(A))).toBe(106);
    quotes('arq', '0.93 %', '48.2 %', '52.7', '107 frames', '106 slots');
    says('errors', 7, '0.93 %'); says('errors', 7, '48.2 %'); says('errors', 7, '106 slots'); says('errors', 7, '107 frames'); says('errors', 7, 'a = 52.7');
    // Viterbi, RS, interleaving
    expect([nands(convEncoder(CONV_K3)), nands(convEncoder(CONV_K7))]).toEqual([42, 122]);
    quotes('viterbi', '42 NANDs', '122', '3,118', '101,094', '110,578', '1,579', '160', '5.4 dB', '3.1 dB', '9.59 dB', '2.4 dB');
    says('errors', 9, '42 NANDs'); says('errors', 9, '122 NANDs'); says('errors', 10, '3,118 NANDs'); says('errors', 10, '101,094'); says('errors', 10, '110,578'); says('errors', 10, '1,579'); says('errors', 10, '160');
    says('errors', 13, '9.59 dB'); says('errors', 13, '5.4 dB'); says('errors', 13, '3.1 dB'); says('errors', 13, '3.4 dB');
    const enc10 = nands(rsEncoder(10)), enc32 = nands(rsEncoder(32)), syn10 = nands(rsSyndrome(10)), mul = nands(gfMulGates());
    expect([enc10, enc32, syn10, mul]).toEqual([2356, 7452, 2366, 416]);
    quotes('reedsolomon', c(enc10), c(enc32), c(syn10), '416 NANDs', '121 bits', '3.4 dB', 'x8 + x4 + x3 + x2 + 1');
    says('errors', 11, '2,356 NANDs'); says('errors', 11, '7,452'); says('errors', 11, '2,366'); says('errors', 11, '416 NANDs'); says('errors', 11, '121 bits');
    expect(1 + 15 * 8).toBe(121);
    expect(burstTolerance(32, 1)).toBe(32);
    expect(burstTolerance(8, 16)).toBe(128);
    expect(8 * 128 - 7).toBe(1017);
    expect(worstPerWord(32, 32)).toBe(1);
    quotes('interleave', '32 bits', '1017', '128 bytes');
    says('errors', 12, '32 bits for 32 SEC-DED words'); says('errors', 12, '1017 bits');
  });
});
