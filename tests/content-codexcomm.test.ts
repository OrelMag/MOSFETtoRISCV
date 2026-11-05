// The Communication entries (codexcomm.ts, codexmore4/5/6.ts, codexcheck6/7/8.ts): complete, linked to real chapter steps, and every
// number they quote equal to the comm/ and phys/ models and the library, or to the chapter step that prints it.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { CHECK6 } from '../src/campaign/codexcheck6';
import { CHECK7 } from '../src/campaign/codexcheck7';
import { CHECK8 } from '../src/campaign/codexcheck8';
import { CHECK9 } from '../src/campaign/codexcheck9';
import { CODEX_COMM, COMM_AWAITING_LEVELS } from '../src/campaign/codexcomm';
import { moreOf } from '../src/campaign/codexmore';
import { NODES } from '../src/campaign/nodes';
import { chapterById } from '../src/chapters';
import { TAUGHT } from '../src/chapters/taught';
import { ADSL, bitLoad, bitsForTone, bitsOf, gapDb, snrForSer } from '../src/comm/modem';
import { ebn0AtCapacity, EBN0_MIN, levelsSupported, nyquistBitRate, nyquistSymbolRate, ratioToDb, shannonDb, snrNeeded } from '../src/comm/limits';
import { aOf, fullWindow, rttOf, utilization } from '../src/comm/arq';
import { CRC32_POLY, CRC32_REFLECTED, CRC32_RESIDUE, crc32 } from '../src/comm/crc';
import { FCS_BYTES, HEADER_BYTES, MAX_FRAME, MIN_FRAME, MIN_PAYLOAD } from '../src/comm/ethframe';
import { ATTEMPT_LIMIT, BACKOFF_LIMIT, BIT_CLOCKS, GAP_BITS, GAP_CLOCKS, JAM_BYTES, LINK_MBPS, SLOT_BITS, SLOT_CLOCKS, backoffMask, frameBitTimes, maxCableMetres } from '../src/comm/mac';
import { AGE_TICKS, HOL_LIMIT, HOL_N4, STAMP_BITS, binomialTail, cutThroughBits, hashAddr, holSaturation, sharedCapacity, singleFrame, storeAndForwardBits } from '../src/comm/ethswitch';
import { DESCRIPTORS, LEN_MASK, OWN, TX_DROPPED } from '../src/comm/nic';
import { arpFrame, checksum, icmpEchoFrame, ip4, onesSum } from '../src/comm/netframes';
import * as NF from '../src/comm/stack/netfacts';
import NET from '../src/comm/stack/netcosts.json';
import { NIC_BASE, NIC_COSTS, nicPollSource } from '../src/riscv/nicprograms';
import { arbiterN, cam, macRx, macTx, registry, ROUTER_FAST } from '../src/lib';
import { bigRam } from '../src/lib/bigmem';
import { fwdPath } from '../src/lib/ethlevels';
import { chPath } from '../src/chapters/ch-comm-path';
import { MEASURED_MBPS, WIRE_DATA_MBPS } from '../src/chapters/ch-comm-tcp';
import { TTL_DELTA, ttlChecksum } from '../src/net/ipv4';
import { CHAIN3, DistVec, floodAll, INFINITY, NET7 } from '../src/net/routing';
import { TCP_K } from '../src/net/tcp';
import COSTS from '../src/net/tcpcosts.json';
import { queueDelay, runTcp } from '../src/net/tcpsim';
import { ADJ_K, BUF_K, TRIE_K, TRIE_NODES } from '../src/net/trie';
import { engineCycles, FRAME_60, portsServed, wireCycles } from '../src/widgets/router';
import { nic } from '../src/lib/nic';
import { crossbar, ethSwitch, inputBuffer, macTable, outputPort, tablePort } from '../src/lib/ethswitch';
import { BENCH_OPTS } from '../src/widgets/ethswitch';
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
    expect(IDS.length).toBe(36);
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
    expect(Object.keys({ ...CHECK6, ...CHECK7, ...CHECK8, ...CHECK9 }).sort()).toEqual([...IDS].sort());
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
    says('carriers', 0, '2,304'); says('carriers', 0, '262,144'); says('carriers', 0, '114 times'); says('carriers', 0, '19.2 %'); says('carriers', 0, '4058.8');
    says('carriers', 5, '1682'); says('carriers', 5, '6.73 Mb/s'); says('carriers', 5, '370 bits'); says('carriers', 5, '1.48 Mb/s');
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
    says('serial', 5, 'a = 0.351'); says('serial', 5, '9.06 × B'); says('serial', 5, '7.03 σ'); says('serial', 5, 'the eye is 30 % open'); says('serial', 5, '4 × 10⁻14');
    quotes('equalization', '9 %', '23 %', '58 %', '34 %', '1.84', '74 mV', '125 ps', '9.54 dB');
    says('serial', 6, 'a = 0.456'); says('serial', 6, '23 %'); says('serial', 6, '58 %'); says('serial', 6, '1.84'); says('serial', 6, '74 mV'); says('serial', 6, '34 %'); says('serial', 6, '125 ps');
    says('serial', 7, '9.54 dB');
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
    says('codes', 0, '42 NANDs'); says('codes', 0, '122 NANDs'); says('codes', 1, '3,118 NANDs'); says('codes', 1, '101,094'); says('codes', 1, '110,578'); says('codes', 1, '1,579'); says('codes', 1, '160');
    says('codes', 6, '9.59 dB'); says('codes', 6, '5.4 dB'); says('codes', 6, '3.1 dB'); says('codes', 6, '3.4 dB');
    const enc10 = nands(rsEncoder(10)), enc32 = nands(rsEncoder(32)), syn10 = nands(rsSyndrome(10)), mul = nands(gfMulGates());
    expect([enc10, enc32, syn10, mul]).toEqual([2356, 7452, 2366, 416]);
    quotes('reedsolomon', c(enc10), c(enc32), c(syn10), '416 NANDs', '121 bits', '3.4 dB', 'x8 + x4 + x3 + x2 + 1');
    says('codes', 2, '2,356 NANDs'); says('codes', 2, '7,452'); says('codes', 2, '2,366'); says('codes', 2, '416 NANDs'); says('codes', 2, '121 bits');
    expect(1 + 15 * 8).toBe(121);
    expect(burstTolerance(32, 1)).toBe(32);
    expect(burstTolerance(8, 16)).toBe(128);
    expect(8 * 128 - 7).toBe(1017);
    expect(worstPerWord(32, 32)).toBe(1);
    quotes('interleave', '32 bits', '1017', '128 bytes');
    says('codes', 5, '32 bits for 32 SEC-DED words'); says('codes', 5, '1017 bits');
  });

  it('quote the Ethernet frame, the CSMA/CD rules and the MAC as built', () => {
    const n = (d: Parameters<typeof stats>[0]) => stats(d).nands;
    expect([MIN_FRAME, MAX_FRAME, MIN_PAYLOAD, HEADER_BYTES, FCS_BYTES]).toEqual([64, 1518, 46, 14, 4]);
    const bitsMin = frameBitTimes(MIN_FRAME), bitsMax = frameBitTimes(MAX_FRAME);
    expect([bitsMin, bitsMax + GAP_BITS, GAP_BITS, bitsMin + GAP_BITS]).toEqual([576, 12304, 96, 672]);
    expect([Math.round(100 * 8 * MIN_PAYLOAD / (bitsMin + GAP_BITS)), Math.round(100 * 8 * 1500 / (bitsMax + GAP_BITS))]).toEqual([55, 98]);
    expect([bitsMin * BIT_CLOCKS, ((bitsMin / LINK_MBPS)).toFixed(1), LINK_MBPS.toFixed(0)]).toEqual([2304, '9.1', '63']);
    expect(CRC32_RESIDUE.toString(16)).toBe('debb20e3');
    quotes('ethframe', '1,518 bytes', '576 bit times', '55 %', '98 %', '0xDEBB20E3', '0xD5', '2,304 clocks', '9.1 µs', '63 Mb/s', '12304', '672 bit times');
    says('ethernet', 0, '576 bit times'); says('ethernet', 0, '2 304 clocks, 9.1 µs at 63 Mb/s'); says('ethernet', 0, '55 % of the time for minimum frames and 98 %'); says('ethernet', 2, '0xDEBB20E3');
    expect([JAM_BYTES * 8, SLOT_BITS, ATTEMPT_LIMIT, BACKOFF_LIMIT, GAP_CLOCKS, SLOT_CLOCKS]).toEqual([32, 512, 16, 10, 384, 2048]);
    expect([backoffMask(1), backoffMask(2), backoffMask(3), backoffMask(11)]).toEqual([1, 3, 7, 1023]);
    expect((3.5 * SLOT_BITS / 10).toFixed(1)).toBe('179.2');
    const m = (mbps: number) => Math.round(maxCableMetres(SLOT_BITS, 0.66, mbps));
    expect([m(10), m(100), m(1000), m(LINK_MBPS)]).toEqual([5065, 507, 51, 800]);
    expect(bitsMin * BIT_CLOCKS / 2).toBe(1152);
    quotes('csmacd', '5,065 m', '507 m', '51 m', '800 m', '1 152 clocks', '179.2 µs', '2 048 clocks', 'jam of 32 bits', '16 attempts', '96 bit times');
    says('ethernet', 5, '5 065 m'); says('ethernet', 5, '507 m'); says('ethernet', 5, '51 m'); says('ethernet', 5, '800 m'); says('ethernet', 5, '1 152 clocks');
    expect([n(macTx()), n(macRx()), n(crcUnit(32, CRC32_REFLECTED, 8))]).toEqual([3553, 3213, 1027]);
    quotes('ethmac', '3,553 NANDs', '3,213 NANDs', '1,027 NANDs', '0xDEBB20E3', '385 clocks', '2,304 clocks', '384 clocks', '1,518 bytes');
    says('ethernet', 1, '3 553 NANDs'); says('ethernet', 1, '1 027 NANDs'); says('ethernet', 1, `${GAP_CLOCKS + 1} clocks in`); says('ethernet', 2, '3 213 NANDs');
    expect(resolveComponent('eth_mac_rx')).toBeTruthy();
  });

  it('quote the switch as built and as simulated', () => {
    const n = (d: Parameters<typeof stats>[0]) => stats(d).nands;
    const TAB4 = n(macTable(4, 4)), TAB7 = n(macTable(7, 4)), CAM4 = n(cam(4, 48)), CAM7 = n(cam(7, 48)), CAM4W = n(cam(4, 59)), RAM4 = n(registry.get('mac_table4_4_ram')!);
    expect([TAB4, RAM4, CAM4W, CAM4, TAB7, CAM7]).toEqual([28876, 26008, 21229, 17357, 213699, 139748]);
    expect(48 + 1 + 2 + 8).toBe(59);
    expect([AGE_TICKS, STAMP_BITS]).toEqual([64, 8]);
    expect([hashAddr(0x7f, 4), hashAddr(0x80, 4)]).toEqual([8, 8]);
    const SHARE = sharedCapacity(20, 0.1, 1e-6);
    expect([SHARE, binomialTail(20, 0.1, SHARE) < 1e-6]).toEqual([10, true]);
    quotes('learnsw', '28,876 NANDs', '26,008', '21,229', '17,357', '213,699', '139,748', '59 bits', '64 ahead', 'one in a million', '10 units', '20 reserved', '7 ⊕ F = 8', '8 ⊕ 0 = 8');
    says('switch', 2, '28 876 NANDs'); says('switch', 2, '26 008'); says('switch', 2, '21 229'); says('switch', 2, '17 357'); says('switch', 2, '213 699'); says('switch', 2, '139 748');
    says('switch', 2, '59 bits'); says('switch', 0, `takes ${SHARE} units`);
    const XB = n(crossbar()), ARB = n(arbiterN(4)), OUT = n(outputPort()), TP = n(tablePort());
    const IN7 = n(inputBuffer({ cellK: 7 })), IN11 = n(inputBuffer({ cellK: 11 }));
    const BENCH = n(ethSwitch(BENCH_OPTS)), BENCH11 = n(ethSwitch({ ...BENCH_OPTS, cellK: 11 }));
    expect([XB, ARB, OUT, TP, IN7, IN11, BENCH, BENCH11]).toEqual([724, 125, 516, 1292, 142221, 2219295, 1195167, 17810671]);
    const saf = singleFrame({ cellK: 7 }, 64), ct = singleFrame({ cellK: 7, cut: true }, 64);
    expect([saf.firstOut, saf.lastIn, saf.lastOut, ct.firstOut]).toEqual([65, 63, 128, 14]);
    expect([storeAndForwardBits(1518), cutThroughBits(), (storeAndForwardBits(1518) / 100).toFixed(1), (cutThroughBits() / 100).toFixed(1)]).toEqual([12208, 112, '122.1', '1.1']);
    quotes('crossbar', '724 NANDs', '125 NANDs', '516', '1292', '142,221', '2,219,295', '1,195,167', '17,810,671', 'cycle 65', 'cycle 14', '122.1 µs', '1.1 µs', '12 208 bits', '112 bits');
    says('switch', 3, '724 NANDs'); says('switch', 3, '125 NANDs'); says('switch', 3, '516'); says('switch', 3, '1 292'); says('switch', 3, '142 221'); says('switch', 3, '2 219 295');
    says('switch', 4, `cycle ${saf.firstOut}`); says('switch', 4, `cycle ${ct.firstOut}`); says('switch', 6, '1 195 167'); says('switch', 6, '17 810 671');
    const HOL4 = holSaturation(4, false, 400000, 3), HOL4N = holSaturation(4, false, 400000, 3, false), HOLBIG = holSaturation(64, false, 20000, 3);
    expect([HOL4.toFixed(3), HOL4N.toFixed(3), (HOL4N * 64 / 65).toFixed(3), HOLBIG.toFixed(3), HOL_N4, HOL_LIMIT.toFixed(4)]).toEqual(['0.655', '0.691', '0.680', '0.590', 0.6553, '0.5858']);
    const voq = [4, 8, 16].map((cells) => n(inputBuffer({ cellK: 7, cells, voq: true })) - n(inputBuffer({ cellK: 7, cells })));
    expect(voq).toEqual([945, 2059, 4621]);
    quotes('hol', '0.6553', '0.655', '0.5858', '0.590', '0.691', '0.680', '+945', '+2059', '+4621', '0.80', '0.88', '0.92', '142,221');
    says('switch', 5, '0.6553'); says('switch', 5, '0.5858'); says('switch', 5, '0.691'); says('switch', 5, '0.680'); says('switch', 5, '0.590'); says('switch', 5, '+945 NANDs at 4 cells');
    says('switch', 5, 'about 0.80'); says('switch', 5, '0.88'); says('switch', 5, '0.92');
  });

  it('quote the router as built and as the chapter prints it', () => {
    const mem = nands(bigRam(TRIE_K, 24)) + nands(bigRam(BUF_K, 8)) + nands(bigRam(ADJ_K, 8)), all = stats(ROUTER_FAST).nands;
    expect([mem, all - mem, TRIE_NODES]).toEqual([836585, 4214, 1024]);
    expect(Math.round((1000 * mem) / all) / 10).toBe(99.5);
    expect([engineCycles(FRAME_60, 33), wireCycles(FRAME_60), portsServed(FRAME_60, 33)]).toEqual([155, 2688, 17]);
    expect(stats(cam(4, 32)).nands).toBe(11725);
    expect(stats(fwdPath()).nands).toBe(5847);
    quotes('lpm', '33', '1,024 nodes', '11,725 NANDs', '5,847 NANDs');
    quotes('fastpath', '4,214 NANDs', '836,585', '155 cycles', '2,688 cycles', '17 ports', '99.5 %', '0xFEFF', '65 536');
    // RFC 1624's form: the field usually rises by 0x0100, and the one exception is why the form exists
    expect(TTL_DELTA).toBe(0xfeff);
    for (const c of [0x6cea, 0xb861, 0xff12]) { const s = c + 0x0100; expect(ttlChecksum(c)).toBe((s & 0xffff) + (s >>> 16)); }
    expect(ttlChecksum(0xfeff)).toBe(0);
    const d = new DistVec(NET7); d.settle();
    const ch = new DistVec(CHAIN3); ch.settle(); ch.fail(1, 2);
    const po = new DistVec(CHAIN3, true); po.settle(); po.fail(1, 2);
    expect([NET7.names.length, NET7.links.length, d.rounds, d.messages, floodAll(NET7), ch.settle(), po.settle(), INFINITY]).toEqual([7, 10, 6, 120, 98, 15, 2, 16]);
    quotes('routing', '7 routers', '10 links', '6 rounds', '120 whole tables', '98 short reports', '15 rounds', '2 rounds');
  });

  it('quote TCP as measured, and the queues as the model runs them', () => {
    expect([TCP_K.MSS, TCP_K.RCV / TCP_K.MSS, COSTS.lines, COSTS.words.a, COSTS.fast.clocks, Math.floor(COSTS.fast.clocks / COSTS.fast.bytes)]).toEqual([64, 8, 570, 3241, 1027057, 128]);
    expect([WIRE_DATA_MBPS.toFixed(1), MEASURED_MBPS.toFixed(1), LINK_MBPS.toFixed(1)]).toEqual(['28.5', '15.8', '63.3']);
    quotes('tcp', '570 lines', '3,241 words', '142 bytes', '28.5', '63.3 Mb/s', '1,027,057 cycles', '128 a byte', '15.8 Mb/s', '3.4 s');
    says('tcp', 7, '15.8 Mb/s'); says('tcp', 7, '28.5 Mb/s');
    const { saw, small, fast } = COSTS;
    expect([saw.bytes, saw.o.byteClocks, saw.o.queue, saw.drops, saw.fast, saw.timeouts]).toEqual([6000, 200, 4, 7, 5, 1]);
    expect([small.bytes, small.o.byteClocks, small.o.queue, small.drops, small.fast, small.timeouts]).toEqual([3000, 400, 3, 8, 0, 5]);
    expect([fast.bytes, fast.drops, fast.fast, fast.timeouts, fast.cwnd[fast.cwnd.length - 1].cwnd / TCP_K.MSS]).toEqual([8000, 0, 0, 0, 16]);
    quotes('aimd', '7 drops, 5 fast retransmits, 1 timeout', '8 drops, 0 fast retransmits, 5 timeouts', '32 kb/s to 40 b/s');
    const q = (queue: number) => { const r = runTcp({ bytes: 8000, byteClocks: 200, queue, delay: 20000 }); return [r.doneAt, r.drops, r.timeouts, r.rtts[r.rtts.length - 1]]; };
    expect([q(2), q(4), q(8)]).toEqual([[5834908, 14, 14, 67669], [4280132, 9, 1, 98928], [3054241, 0, 0, 153072]]);
    quotes('bufferbloat', '5,834,908', '4,280,132', '3,054,241', '67,669', '98,928', '153,072', '23,600', '0.8 s');
    expect(queueDelay(1, 200)).toBe(23600);
  });

  it('quote the internet path as chapter 53 computes it', () => {
    const keep = strip(chPath.recap!.keep.join(' ')).replace(/\s+/g, ' ');
    for (const s of ['at most 62 trie nodes', 'customer, then peer, then provider', 'Ridgeway Net → Kestrel Transit → Tarn Backbone → Quillon Hosting', 'A false /24 beats the true /16', '3 questions and 8 messages', '194 ms in sequence', 'takes 47.7 ms and 47.5 of it is light', '615 µs for a full frame on the 20 Mb/s line', '320 µs at half load to 6.1 ms at 95 %', 'about 720 ms']) expect(keep, s).toContain(s);
    quotes('bgp', 'at most 62 trie nodes', 'Ridgeway Net → Kestrel Transit → Tarn Backbone → Quillon Hosting', 'customer, then peer, then provider');
    quotes('internetpath', '47.7 ms', '47.5', '615 µs', '320 µs', '6.1 ms at 95 %', '3 questions and 8 messages', '194 ms', 'about 720 ms', '5 µs a kilometre');
  });

  it('quote the NIC, the checksum, ARP and the ping as built and measured', () => {
    expect([DESCRIPTORS, OWN, LEN_MASK, TX_DROPPED, NIC_BASE]).toEqual([8, 0x80000000, 0x7ff, 0x40000000, 0x70000000]);
    const nicN = stats(nic()).nands;
    expect([nicN, NET.nands.nic, NET.nands.macTx + NET.nands.macRx]).toEqual([15425, 15425, 6766]);
    expect([NF.PING_DMA.send, NF.PING_DMA.receive]).toEqual([{ reads: 22, writes: 1 }, { reads: 2, writes: 20 }]);
    expect(nicPollSource().split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length).toBe(63);
    const C = NIC_COSTS;
    expect([C.doorbellToWire, C.wireClocks, C.pollPass, C.pollSeen, C.irqSeen, C.handler, C.freePermille]).toEqual([279, 2432, 4, 2726, 2718, 11, 996]);
    quotes('nicring', '15,425 NANDs', '6766', '22 reads', '20 writes', '279 clocks', '2432 clocks', '2726 clocks', '2718', '11 clocks', '99.6 %', '63 lines', '0x7000_0000', '1,536-byte');
    says('network', 1, 'Eight descriptors a ring, a buffer of 1536 bytes'); says('network', 1, '0x7000_0000'); says('network', 2, '15 425 NANDs, 6 766 of them');
    says('network', 3, '63 lines'); says('network', 3, '2726 clocks after the doorbell'); says('network', 3, 'seen at 2718'); says('network', 3, 'The handler is 11 clocks'); says('network', 3, '99.6 %');
    says('network', 3, '279 clocks'); says('network', 9, '3 + ⌈len/4⌉ reads and 1 write');
    const w = (a: number[]) => a.flatMap((x) => [x >> 8, x & 255]);
    const rfc = w([0x0001, 0xf203, 0xf4f5, 0xf6f7]);
    expect([0x0001 + 0xf203 + 0xf4f5 + 0xf6f7, onesSum(rfc), checksum(rfc)]).toEqual([0x2ddf0, 0xddf2, 0x220d]);
    expect(0xddf0 + 2).toBe(0xddf2);
    const hdr = [0x4500, 0x0073, 0x0000, 0x4000, 0x4011, 0, 0xc0a8, 0x0001, 0xc0a8, 0x00c7];
    expect([checksum(w(hdr)), onesSum(w(hdr.map((x, i) => (i === 5 ? 0xb861 : x))))]).toEqual([0xb861, 0xffff]);
    expect(2 ** 16).toBe(65536);
    quotes('inetcksum', '0xDDF2', '0x220D', '0xB861', '0x2DDF0', '0xFFFF', '0xDDF0 + 2 = 0xDDF2', '48 %');
    says('network', 4, '0xB861'); says('network', 9, '48 % of the echo request');
    expect(NF.BYTES_PERCENT).toBe(48);
    const arp = arpFrame({ op: 1, sha: [2, 0, 0, 0, 0, 1], spa: ip4(10, 0, 0, 1), tha: [0, 0, 0, 0, 0, 0], tpa: ip4(10, 0, 0, 2) });
    expect([arp.bytes.length, arp.bytes.length - HEADER_BYTES, NF.wireClocks(42), (NF.wireClocks(42) * 3.95 / 1000).toFixed(1)]).toEqual([42, 28, 2688, '10.6']);
    expect([NF.win('a', 0).total.instr, NF.win('a', 0).total.clocks, NF.win('b', 0).total.instr, NF.win('b', 0).total.clocks]).toEqual([410, 510, 719, 912]);
    quotes('arp', '42 bytes', '28-byte', '0x0806', '2,688 clocks', '410 instructions', '510 clocks', '719', '912 clocks', '10.6 µs');
    says('network', 5, '2 688 clocks'); says('network', 5, '410 instructions and 510 clocks'); says('network', 5, '719 instructions and 912 clocks');
    const echo = icmpEchoFrame({ src: ip4(10, 0, 0, 1), dst: ip4(10, 0, 0, 2), id: 1, srcMac: [2, 0, 0, 0, 0, 1], dstMac: [2, 0, 0, 0, 0, 2], ident: 1, seq: 1, data: Array.from({ length: 32 }, (_, i) => 16 + i) });
    expect([echo.bytes.length, echo.bytes[14], (echo.bytes[16] << 8) | echo.bytes[17], echo.bytes[23]]).toEqual([74, 0x45, 60, 1]);
    const RT = NF.roundTrip();
    expect([NF.PING_FRAME, NF.PING_SERIAL, NF.PING_SERIAL / 32, NF.PING_FRAME_TIME, NET.rtt, RT.cable, RT.software, RT.turnaround, Math.round(100 * RT.cable / NET.rtt)]).toEqual([74, 2752, 86, 3136, 14689, 11008, 3673, 8, 75]);
    expect(RT.cable).toBe(4 * NF.PING_SERIAL);
    expect((NET.rtt * 3.95 / 1000).toFixed(1)).toBe('58.0');
    expect([NF.B_ECHO.total.instr, NF.B_ECHO.total.clocks, NF.B_BUSY_PERCENT, NET.words.a, NET.words.b, NET.nands.lan]).toEqual([1491, 1882, 60, 1711, 1322, 12471821]);
    quotes('ipv4', '74 bytes', '2752 clocks', '3136', '14,689 clocks', '58.0 µs', '11008', '3673', '1491 instructions, 1882 clocks', '60 %', '48 %', '12,471,821 NANDs', '1,711 instructions', '1,322', '0x003C', '75 %', '86 bytes');
    says('network', 0, '86 bytes on the cable'); says('network', 8, '14 689 clocks'); says('network', 8, '58.0 µs'); says('network', 8, '11 008'); says('network', 8, '3 673'); says('network', 8, '2 752 clocks');
    says('network', 8, '12 471 821 NANDs'); says('network', 8, '1 711 instructions in A, 1 322 in B'); says('network', 7, '1 491 instructions in 1 882 clocks'); says('network', 9, '60 % of a frame time');
    says('network', 9, '3 136'); says('network', 9, 'adds 8 clocks');
  });
});
