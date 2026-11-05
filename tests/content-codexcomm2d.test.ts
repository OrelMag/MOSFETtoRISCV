// The numbers the codex entries for carriers, codes, queues and datacentre quote, against the models, the library and the chapter steps.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { moreOf } from '../src/campaign/codexmore';
import { flatBest, flatPower, loadBits, waterFill } from '../src/comm/carriers';
import { ecmpExpected, ecmpNoCollision, fanoutSlow, fatTree, gbnGoodput, incast, oversubscription, pfcHeadroom, pfcRun } from '../src/comm/dc';
import { streamLatency, twiddleCount } from '../src/comm/fftfix';
import { fftMults } from '../src/comm/fourier';
import { becThreshold, ebn0OfSigma, AWGN_SIGMA, ldpcTrial, regularCode } from '../src/comm/ldpc';
import { DOWN_TONES, gapDb, toneSnrDb, ADSL } from '../src/comm/modem';
import { bottleneck, cubicK, cubicWindow, dctcpAlpha, dctcpAmplitude, dctcpMinK, mm1Quantile, mm1Wait, renoWindow } from '../src/comm/queues';
import { shannonBinaryDb, convSoftBound } from '../src/comm/ber';
import { CONV_K7 } from '../src/comm/conv';
import { fftNet, fftStream, fxCmul, fxCore, fxRot45 } from '../src/lib/fft';
import { resolveComponent } from '../src/lib/resolve';
import { stats } from '../src/sim/stats';
import { duelRun, labRun, type LabPreset } from '../src/widgets/queues';

const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
function text(id: string): string {
  const m = moreOf(id)!;
  return strip([codexById(id)!.body, m.idea, m.example?.title, m.example?.body, ...(m.mistakes ?? []), ...(CHECKS[id] ?? []).flatMap((q) => [q.question, q.explain, ...q.options, ...(q.why ?? [])])].join(' '));
}
const flat = (s: string) => s.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
const quotes = (id: string, ...s: (string | number)[]) => { const t = flat(text(id)); for (const x of s) expect(t, `${id}: ${x}`).toContain(flat(String(x))); };
const n = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const c = (x: number) => Math.round(x).toLocaleString('en-US');

describe('many carriers', () => {
  it('fft: the costs measured, the twiddles counted', () => {
    expect([n(fxCore(10, false)), n(fxRot45(10)), n(fxCmul(10)), n(fftNet(8, 10)), n(fftNet(16, 10)), n(fftStream(16, 10)), n(fftStream(64, 10))]).toEqual([416, 1752, 6884, 8496, 51360, 22591, 54598]);
    expect(streamLatency(16)).toBe(19);
    quotes('fft', '416', '1,752', '6,884', '8,496', '51,360', '22,591', '54,598', '19 edges');
    const t = twiddleCount(8);
    expect([t.one, t.minusj, t.root1 + t.root3, t.general, fftMults(8)]).toEqual([7, 3, 2, 0, 12]);
    expect(resolveComponent(moreOf('fft')!.lib!)).toBeTruthy();
  });
  it('water-filling: the hand case and the loop', () => {
    const p = waterFill([1, 2], 3);
    expect([p.level, p.power[0], p.power[1]]).toEqual([2.25, 1.25, 1.75]);
    expect([p.total.toFixed(2), flatPower([1, 2], 3).total.toFixed(2)]).toEqual(['3.34', '3.32']);
    const G = 10 ** (gapDb(1e-7) / 10), g = (km: number) => DOWN_TONES.map((k) => 10 ** (toneSnrDb(k, km, -120) / 10));
    const g3 = g(3), g5 = g(5), B = g3.length;
    expect(B).toBe(223);
    expect([waterFill(g3, B, G), flatPower(g3, B, G), loadBits(g3, B, G, ADSL.maxBits)].map((x) => Math.round(x.total))).toEqual([1796, 1795, 1788]);
    const f5 = flatBest(g5, B, G);
    expect([Math.round(flatPower(g5, B, G).total), f5.used, Math.round(f5.total), Math.round(waterFill(g5, B, G).total)]).toEqual([429, 89, 522, 524]);
    quotes('waterfill', '1,796', '1,795', '1,788', '429', '522', '524', '3.34', '3.32', 'best 89');
  });
});

describe('codes near the limit', () => {
  it('ldpc: the threshold, the bracket, the limit', () => {
    expect(becThreshold().toFixed(4)).toBe('0.4294');
    expect([ebn0OfSigma(AWGN_SIGMA[1]).toFixed(2), ebn0OfSigma(AWGN_SIGMA[0]).toFixed(2), shannonBinaryDb(0.5).toFixed(2)]).toEqual(['1.01', '1.16', '0.19']);
    expect(Math.round(convSoftBound(CONV_K7, 2.4) * 1000)).toBe(6);
    const run = ldpcTrial(regularCode(2016, 3, 6, 5), 2, 40, { seed: 2, maxIter: 60 }); // the chapter's own run
    expect(Math.abs(run.meanIter - 10.8)).toBeLessThan(0.1);
    expect(Math.round(12 * run.meanIter)).toBe(130);
    quotes('ldpc', '0.4294', '1.01 and 1.16', '0.19 dB', '10.8', '130');
  });
});

describe('queues and congestion', () => {
  const lab = (p: Partial<LabPreset>, cc: 'reno' | 'cubic' | 'bbr' = 'cubic', ecn = false) => labRun({ aqm: 'tail', buffer: 1000, rtt: 50, flows: [{ cc, rttMs: 50, ecn }], ...p });
  it('the wait against load', () => {
    expect([0.5, 0.8, 0.9, 0.99].map((r) => Math.round(mm1Wait(r)))).toEqual([1, 4, 9, 99]);
    expect(Math.round(mm1Quantile(0.9, 0.01))).toBe(45);
    expect(((1500 * 8) / 100e6) * 1000).toBeCloseTo(0.12, 9);
    expect(((1500 * 8) / 1e6) * 1000).toBeCloseTo(12, 9);
    quotes('littleslaw', '0.12 ms', '12 ms', 'waits 45');
  });
  it('CUBIC on a long fat pipe', () => {
    const pipe = (1e9 * 0.1) / 12000;
    expect(c(pipe)).toBe('8,333');
    expect(c(pipe / 2)).toBe('4,167');
    expect(Math.round((pipe / 2) * 0.1 / 60)).toBe(7);
    expect((pipe * pipe / 1.5).toExponential(1)).toBe('4.6e+7');
    expect(cubicK(pipe).toFixed(1)).toBe('18.4');
    expect([Math.round(renoWindow(1e-4)), Math.round(cubicWindow(1e-4, 0.1))]).toEqual([122, 187]);
    quotes('cubic', '8,333', '4,167', '18.4 s', '1.054', 'Reno 122', 'CUBIC 187');
  });
  it('the disciplines on the lab\'s link', () => {
    const t = lab({}), r = lab({ aqm: 'red' }), co = lab({ aqm: 'codel' });
    expect([Math.round(t.pingMeanMs), Math.round(r.pingMeanMs), Math.round(co.pingMeanMs), Math.round(100 * co.utilization), co.drops]).toEqual([504, 101, 3, 96, 17]);
    quotes('aqm', '504 ms', '101 ms', '3 ms', '17 packets');
  });
  it('fair queueing against tail drop', () => {
    const f: LabPreset = { aqm: 'fq', buffer: 1000, rtt: 50, flows: [{ cc: 'cubic', rttMs: 50 }, { cc: 'reno', rttMs: 20 }, { cc: 'cubic', rttMs: 200 }] };
    const a = labRun({ ...f, aqm: 'tail' }), b = labRun(f), g = (r: typeof a) => r.goodputMbps.map((x) => x.toFixed(1)).join(', ');
    quotes('fairqueue', g(a), g(b), a.jain.toFixed(2), b.jain.toFixed(2), `${Math.round(a.pingMeanMs)} ms`, `${b.pingMeanMs.toFixed(1)} ms`);
  });
  it('ECN: the same throughput, no loss', () => {
    const a = lab({ aqm: 'codel' }), b = lab({ aqm: 'codel' }, 'cubic', true);
    expect([a.drops, b.drops, b.marks]).toEqual([17, 0, 17]);
    quotes('ecn', `${a.goodputMbps[0].toFixed(1)} Mb/s`, `${b.goodputMbps[0].toFixed(1)} Mb/s`);
  });
  it('BBR, alone, under loss and against CUBIC', () => {
    const m = lab({}, 'bbr');
    expect(Math.round(m.pingMeanMs)).toBe(35);
    const L: LabPreset = { aqm: 'tail', buffer: 500, rtt: 100, flows: [{ cc: 'bbr', rttMs: 100 }], lossP: 0.01 };
    const bl = labRun(L, 40), rl = labRun({ ...L, flows: [{ cc: 'reno', rttMs: 100 }] }, 40), mathis = (renoWindow(0.01) * 1500 * 8) / 0.1 / 1e6;
    const s = duelRun(40), d = duelRun(320), fq = duelRun(40, 'fq'), two = (r: typeof s) => `${r.goodputMbps[0].toFixed(1)} and ${r.goodputMbps[1].toFixed(1)} Mb/s`;
    quotes('bbr', '35 ms', `BBR ${bl.goodputMbps[0].toFixed(1)} of 20`, `Reno ${rl.goodputMbps[0].toFixed(1)}`, `Mathis: ${mathis.toFixed(2)}`, two(s), two(d), two(fq));
  });
});

describe('inside the data centre', () => {
  it('the fabric', () => {
    const f = fatTree(48), g = fatTree(4);
    expect([f.hosts, f.switches, f.core, g.hosts, g.switches, g.core]).toEqual([27648, 2880, 576, 16, 20, 4]);
    expect(oversubscription(40, 25, 8, 100)).toBeCloseTo(1.25, 9);
    quotes('fattree', '27,648', '2,880', '576', '1.25 to 1');
  });
  it('ECMP', () => {
    expect([Math.round(100 * ecmpExpected(32, 32)), Math.round(100 * ecmpExpected(100000, 100000)), Math.round(100 * (1 - ecmpNoCollision(8, 64)))]).toEqual([64, 63, 37]);
    quotes('ecmp', '64 %', '63 %', '37 %');
  });
  it('incast: as the entry says, in the model', () => {
    const read = (s: number, rto = 200, b = 32) => incast({ senders: s, blockBytes: 256 * 1024, bufferPkts: b, rtoMs: rto });
    expect(read(2).timeouts).toBe(0);
    expect(read(40).timeouts).toBeGreaterThan(0);
    expect(read(40).share).toBeLessThan(0.5);
    expect(read(40, 1).share).toBeGreaterThan(0.9);
    expect(read(40, 200, 512).share).toBeGreaterThan(0.9);
    expect(read(40, 1, 512).share).toBeLessThan(0.5);
  });
  it('DCTCP', () => {
    const star = 83 + 20, r = (cc: 'dctcp' | 'reno') => bottleneck({ mbps: 10000, bufferPkts: 400, aqm: 'step', markK: 20 }, [{ cc, rttMs: 0.1, ecn: true }], 0.6, 0.2), d = r('dctcp');
    expect([dctcpAlpha(star).toFixed(3), Math.round(dctcpAmplitude(star)), Math.round(dctcpMinK(83))]).toEqual(['0.139', 7, 12]);
    expect([Math.round(100 * d.utilization), Math.round(d.meanQueue), Math.round(d.meanQueue * 1.2), d.dctcpAlpha!.toFixed(2), Math.round(100 * r('reno').utilization)]).toEqual([100, 17, 21, '0.10', 76]);
    quotes('dctcp', '0.139', '≈ 7 packets', '17 packets (21 µs)', 'α = 0.10', '76 %');
  });
  it('RDMA: the pipe and go-back-N', () => {
    const W = Math.round((100e9 * 10e-6) / (1024 * 8));
    expect(W).toBe(122);
    expect([(100 * gbnGoodput(1e-5, W)).toFixed(2), Math.round(100 * gbnGoodput(1e-3, W))]).toEqual(['99.88', 89]);
    expect(Math.round((1024 * 8) / 100 / 10) * 10).toBe(80);
    quotes('rdma', 'W = 122', '99.88 %', '89 %', '99.9 %', '80 ns');
  });
  it('PFC: the victim and the headroom', () => {
    const b = { r1: 0.25, buffer: 64, headroom: pfcHeadroom(8), oneWay: 8, slots: 30000 }, lossy = pfcRun({ ...b, lossless: false }), pf = pfcRun({ ...b, lossless: true });
    expect([lossy.f1.toFixed(2), lossy.f2.toFixed(2), lossy.drops, pf.f1.toFixed(2), pf.f2.toFixed(2), pf.drops, Math.round(100 * pf.pausedShare)]).toEqual(['0.25', '0.50', 7434, '0.25', '0.25', 0, 50]);
    expect(pfcHeadroom(8)).toBe(18);
    expect(pfcHeadroom(6.25)).toBeCloseTo(14.5, 9);
    quotes('pfc', '7,434', '18 for a delay of 8', 'about 15 packets');
  });
  it('the tail', () => {
    expect([Math.round(100 * fanoutSlow(100, 0.01)), Math.round(100 * fanoutSlow(50, 0.01)), Math.round(100 * fanoutSlow(50, 0.02)), Math.round(100 * fanoutSlow(50, 0.0004))]).toEqual([63, 39, 64, 2]);
    expect(fanoutSlow(50, 0.0002)).toBeCloseTo(0.01, 3);
    quotes('tailscale', '63 %', '39 %', '1 in 5,000');
  });
});
