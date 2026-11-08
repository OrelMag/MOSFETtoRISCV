// The DOM-free models of the Communication track's first two chapters, against closed forms and published values.
import { describe, expect, it } from 'vitest';
import { PARIS_UNITS, FIGS, LTRS, SPACE, CR, LF, ITA2_FIGURES, ITA2_LETTERS, ITA2_UNITS, MORSE, codeBits, ita2Encode, morseEncode, morseUnitSeconds } from '../src/comm/codes';
import { bestClos, capacityAt, clos, crossbarCrosspoints, erlangB, foldedCrosspoints, meshWires, offered, trunksFor } from '../src/comm/exchange';
import { EBN0_MIN, dbToRatio, ebn0AtCapacity, levelsSupported, minBandwidth, nyquistBitRate, ratioToDb, shannon, shannonDb, snrNeeded } from '../src/comm/limits';
import { ITA2_START_STOP, UART_8N1, frameUnits, levelAt, parityBit, receive, segments, stopIndex, tolerance, toleranceClosedForm } from '../src/comm/startstop';
import { RELAY, relayStatic } from '../src/phys/relay';
import { PULL_I, PULL_V, SOUNDER, SOUNDER_R, loopCurrent, margin, ohmsPerKm, reachKm, reachWithRepeaters, repeaterDelayMs } from '../src/phys/telegraph';

describe('Morse and ITA2', () => {
  it('PARIS and the word gap after it are 50 units, the definition of words a minute', () => {
    expect(PARIS_UNITS).toBe(50);
    expect(morseEncode('PARIS').units).toBe(43);
    expect(morseUnitSeconds(20)).toBeCloseTo(0.06, 9);
  });
  it('Morse codes are distinct, and not prefix-free: the gaps carry the structure', () => {
    const codes = Object.values(MORSE);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.some((a) => codes.some((b) => a !== b && b.startsWith(a)))).toBe(true);
  });
  it('gaps are 1, 3 and 7 units', () => {
    const r = morseEncode('E E EE');
    expect(r.runs).toEqual([[true, 1], [false, 7], [true, 1], [false, 7], [true, 1], [false, 3], [true, 1]]);
    expect(morseEncode('SOS').runs.length).toBe(17);
  });
  it('ITA2: the invariants that need no table from memory', () => {
    expect(LTRS).toBe(31);
    expect(FIGS).toBe(27);
    expect([SPACE, CR, LF]).toEqual([4, 8, 2]);
    expect(ITA2_LETTERS.get('E')).toBe(1);
    // the top row of a QWERTY keyboard in figures case reads 1234567890
    const figOf = (c: string) => [...ITA2_FIGURES.entries()].find(([, v]) => v === ITA2_LETTERS.get(c))?.[0];
    expect([...'QWERTYUIOP'].map(figOf).join('')).toBe('1234567890');
    expect(ITA2_LETTERS.size).toBe(26);
    expect(new Set(ITA2_LETTERS.values()).size).toBe(26);
    for (const v of [...ITA2_LETTERS.values(), ...ITA2_FIGURES.values()]) expect([LTRS, FIGS, SPACE, CR, LF, 0]).not.toContain(v);
  });
  it('ITA2: shifts are sent when the case changes, 7.5 units a character', () => {
    const r = ita2Encode('A1 B');
    expect(r.codes.map((c) => c[1])).toEqual(['A', 'FIGS', '1', 'SP', 'LTRS', 'B']);
    expect(r.shifts).toBe(2);
    expect(r.units).toBe(6 * ITA2_UNITS);
    expect(ITA2_UNITS).toBe(7.5);
    expect(codeBits(0b10011)).toEqual([1, 1, 0, 0, 1]);
    expect(ita2Encode('A~').skipped).toEqual(['~']);
  });
});

describe('Nyquist and Shannon', () => {
  it('closed forms', () => {
    expect(nyquistBitRate(3100, 2)).toBe(6200);
    expect(nyquistBitRate(1000, 16)).toBe(8000);
    expect(minBandwidth(50)).toBe(25);
    expect(shannon(1000, 1)).toBeCloseTo(1000, 9);
    expect(shannon(1000, 1023)).toBeCloseTo(10000, 6);
    expect(shannonDb(3100, 30)).toBeCloseTo(3100 * Math.log2(1001), 6);
    expect(ratioToDb(dbToRatio(23))).toBeCloseTo(23, 9);
  });
  it('the two limits meet at M = sqrt(1 + SNR)', () => {
    for (const snr of [3, 15, 99, 1000]) expect(nyquistBitRate(1, levelsSupported(snr))).toBeCloseTo(shannon(1, snr), 9);
  });
  it('the Eb/N0 floor is ln 2, -1.59 dB', () => {
    expect(ratioToDb(EBN0_MIN)).toBeCloseTo(-1.59, 2);
    expect(ratioToDb(ebn0AtCapacity(1e-6))).toBeCloseTo(-1.59, 2);
    expect(ebn0AtCapacity(1)).toBe(1);
    expect(snrNeeded(2)).toBe(3);
  });
});

describe('the telegraph line', () => {
  it('wire resistance per km follows rho L / A for a 4 mm wire', () => {
    expect(ohmsPerKm('iron')).toBeCloseTo((1e-7 * 1000) / (Math.PI * 4e-6), 6);
    expect(ohmsPerKm('iron') / ohmsPerKm('copper')).toBeCloseTo(1e-7 / 1.68e-8, 9);
  });
  it('pull-in current is the relay model\'s pull-in voltage over its coil', () => {
    expect(PULL_I).toBeCloseTo(relayStatic().pull! / RELAY.Rc, 12);
    expect(PULL_V).toBeCloseTo(PULL_I * SOUNDER_R, 12);
    // rewound to the sounder's resistance the force balance gives the same current (it is in ampere-turns); 10 mV search steps
    expect(relayStatic(SOUNDER).pull! / SOUNDER_R).toBeCloseTo(PULL_I, 3);
  });
  it('reach is where the current falls to the pull-in current, and repeaters add sections', () => {
    for (const V of [24, 48, 120]) for (const m of ['iron', 'copper'] as const) {
      const L = reachKm(V, m);
      expect(loopCurrent(V, L, m)).toBeCloseTo(PULL_I, 9);
      expect(margin(V, L * 0.9, m)).toBeGreaterThan(1);
      expect(margin(V, L * 1.1, m)).toBeLessThan(1);
      expect(reachWithRepeaters(V, m, 3)).toBeCloseTo(4 * L, 9);
    }
    expect(reachKm(1, 'iron')).toBe(0);
    expect(repeaterDelayMs(3)).toBeCloseTo(3 * 8.2, 9);
  });
});

describe('what a switching network costs', () => {
  it('mesh and crossbar', () => {
    expect(meshWires(2)).toBe(1);
    expect(meshWires(10)).toBe(45);
    expect(crossbarCrosspoints(3)).toBe(9);
    expect(foldedCrosspoints(10)).toBe(45);
  });
  it('Clos: crosspoints 2 N m + m r^2, strictly non-blocking from m = 2n - 1, rearrangeable from m = n', () => {
    const c = clos(36, 3, 5)!;
    expect(c).toMatchObject({ r: 12, crosspoints: 2 * 36 * 5 + 5 * 144, strict: true, rearrangeable: true });
    expect(clos(36, 3, 4)).toMatchObject({ strict: false, rearrangeable: true });
    expect(clos(36, 3, 2)).toMatchObject({ rearrangeable: false });
    expect(clos(10, 3, 5)).toBeNull();
  });
  it('Clos beats the crossbar from some size on, with n near sqrt(N / 2)', () => {
    expect(bestClos(1024).crosspoints).toBeLessThan(crossbarCrosspoints(1024));
    expect(bestClos(16).crosspoints).toBeGreaterThanOrEqual(crossbarCrosspoints(16));
    expect(bestClos(1024).n).toBe(16);
    expect(bestClos(4096).n).toBe(32);
  });
});

describe('Erlang B', () => {
  it('small cases by hand', () => {
    expect(erlangB(1, 1)).toBeCloseTo(0.5, 12);
    expect(erlangB(2, 2)).toBeCloseTo(0.4, 12);
    expect(erlangB(3, 0)).toBe(1);
    expect(erlangB(1, 2)).toBeCloseTo(0.2, 12);
  });
  it('matches the published table of traffic carried at 1 % blocking', () => {
    // m trunks: Erlangs at B = 0.01, as printed in the standard Erlang B tables
    const table: [number, number][] = [[1, 0.0101], [2, 0.153], [5, 1.36], [10, 4.46], [20, 12.0], [50, 37.9], [100, 84.1]];
    for (const [m, e] of table) expect(capacityAt(m, 0.01), `${m} trunks`).toBeCloseTo(e, e < 1 ? 3 : e < 10 ? 2 : 1);
  });
  it('10 Erlangs on 10 trunks block about one call in five, and 1 % needs 18', () => {
    expect(erlangB(10, 10)).toBeCloseTo(0.2146, 3);
    expect(trunksFor(10, 0.01)).toBe(18);
    expect(offered(120, 1.5, 3)).toBeCloseTo(9, 9);
  });
});

describe('start-stop framing', () => {
  it('frame lengths', () => {
    expect(frameUnits(ITA2_START_STOP)).toBe(7.5);
    expect(frameUnits(UART_8N1)).toBe(10);
    expect(frameUnits({ data: 8, stop: 1, parity: 'even' })).toBe(11);
    expect(stopIndex({ data: 8, stop: 1, parity: 'even' })).toBe(10);
    expect(segments(ITA2_START_STOP, 0b00001).map((s) => s.level)).toEqual([0, 1, 0, 0, 0, 0, 1]);
    expect(levelAt(UART_8N1, 0, 12).label).toBe('idle');
    expect(parityBit({ data: 8, stop: 1, parity: 'even' }, 0b111)).toBe(1);
    expect(parityBit({ data: 8, stop: 1, parity: 'odd' }, 0b111)).toBe(0);
  });
  it('a receiver on the right clock reads every code of both frames, parity included', () => {
    for (const f of [ITA2_START_STOP, UART_8N1, { data: 7, stop: 2, parity: 'odd' as const }])
      for (let c = 0; c < 2 ** f.data; c++) expect(receive(f, c, { err: 0 }).ok, `${f.data} ${c}`).toBe(true);
  });
  it('a swept limit equals the closed form (continuous clock), both frames', () => {
    for (const f of [ITA2_START_STOP, UART_8N1]) {
      const t = tolerance(f), cf = toleranceClosedForm(f);
      expect(t.fast).toBeCloseTo(cf.fast, 3);
      expect(t.slow).toBeCloseTo(cf.slow, 3);
    }
    expect(toleranceClosedForm(ITA2_START_STOP).fast).toBeCloseTo(0.5 / 6, 9);
    expect(toleranceClosedForm(UART_8N1).fast).toBeCloseTo(0.5 / 9, 9);
  });
  it('the code that fails first has a 0 against its stop and a differing neighbour', () => {
    const t = tolerance(UART_8N1);
    // fast receiver: the stop sample lands in the last data unit, wrong when that unit is 0
    expect(((t.failFast ?? 0) >> 7) & 1).toBe(0);
    // slow receiver: the last data sample lands in the stop, wrong when the last data unit is 0
    expect(((t.failSlow ?? 0) >> 7) & 1).toBe(0);
  });
  it('a fast receiver 7 % off reads the 8N1 frame wrong, and a quantized clock loses part of the margin', () => {
    expect(receive(UART_8N1, 0x00, { err: 0.07 }).stopOk).toBe(false);
    const cont = tolerance(UART_8N1), q = tolerance(UART_8N1, { ticks: 16 });
    expect(q.slow).toBeLessThan(cont.slow);
    expect(q.slow).toBeGreaterThan(cont.slow - 1 / 16 / 9 - 2e-4);
  });
});
