// phys/line.ts against closed forms: the lattice (launch, reflections, DC value, terminations), the on-chip wire (Elmore,
// the 0.38 RC distributed delay checked on a numeric ladder, quadratic growth, the repeater optimum), crosstalk, the
// differential pair, and the channel (erfc, Q, BER, PRBS, the eye).

import { describe, expect, it } from 'vitest';
import {
  berOf, bestRepeaters, boardDelay, coupling, criticalLength, crosstalk, differential, elmoreDelay, erfc, eye, farStats, gamma, groundBounce, iSat,
  isLumped, lattice, lcOf, link, minBandwidth, minRsStaysHigh, parallelPower, prbs, qFunc, qOf, rcDelay50, rcStep, repeatedDelay, repeaterOptimum,
  rEff, rng, rOn, sampleLine, seriesResistor, unitR, VIH, VIL, VIO, wireDelay, wireDelayTerms, wireDominates, wireLadder, z0Of, C_UNIT_IN, WIRE_C_PER_MM, WIRE_R_PER_MM,
} from '../src/phys/line';

const near = (a: number, b: number, rel = 1e-3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(Math.abs(a), Math.abs(b), 1e-12));

describe('driver', () => {
  it('rEff is inversely proportional to width, rOn is below it, and ln 2 · R · C is the discharge t50', () => {
    near(rEff(1) / rEff(16), 16, 1e-3);
    expect(rOn(1)).toBeLessThan(rEff(1));
    // pinned: 1 / (K (VDD - VT)) for the unit device = 3 367 Ω; the saturating discharge averages 6 190 Ω
    expect(Math.round(rOn(1))).toBe(3367);
    expect(Math.round(rEff(1))).toBe(6191);
    // the 128-wide pad stage is about the board's 50 Ω
    expect(Math.round(rEff(128))).toBe(48);
    near(rcDelay50(1000, 100), 69.31, 1e-3);
    expect(Math.round(iSat(1))).toBe(219);
  });
  it('rcStep reaches 50 % at ln 2 · RC', () => {
    const s = rcStep(1000, 100, 1.8, 400, 0.5), i = s.v.findIndex((v) => v >= 0.9);
    near(s.t[i], 0.1 * Math.LN2 * 1000, 0.01);
  });
});

describe('lattice', () => {
  const base = { v: 3.3, z0: 50, delay: 1, rise: 0 };
  it('launches V·Z0/(Z0+Rs) and doubles it at an open end', () => {
    const l = lattice({ ...base, rs: 10, rl: Infinity });
    near(l.launch, (3.3 * 50) / 60);
    near(l.firstFar, 2 * l.launch);
    near(l.far(1.5), 2 * l.launch);
    near(l.near(0.5), l.launch);
  });
  it('reflection coefficients: open +1, short −1, matched 0, Z0/3 → −½', () => {
    expect(gamma(Infinity, 50)).toBe(1);
    expect(gamma(0, 50)).toBe(-1);
    expect(gamma(50, 50)).toBe(0);
    near(gamma(150, 50), 0.5);
    near(gamma(25, 50), -1 / 3);
  });
  it('settles to the DC value V·RL/(RL+Rs), open or loaded', () => {
    for (const [rs, rl] of [[10, Infinity], [30, 150], [70, 50], [5, 200]] as const) {
      const l = lattice({ ...base, rs, rl });
      near(l.final, rl === Infinity ? 3.3 : (3.3 * rl) / (rl + rs));
      near(l.far(400), l.final, 1e-4);
      near(l.near(400), l.final, 1e-4);
    }
  });
  it('the sum of the waves is the DC value: Σ A_k + B_k', () => {
    const l = lattice({ ...base, rs: 20, rl: 120 });
    near(l.forward.reduce((a, b) => a + b, 0) + l.backward.reduce((a, b) => a + b, 0), l.final, 1e-4);
  });
  it('series termination (Rs = Z0, open end): the far end steps to V after one flight, the near end sits at V/2 until the round trip', () => {
    const l = lattice({ ...base, rs: 50, rl: Infinity });
    near(l.far(0.99), 0, 1e-9);
    near(l.far(1.01), 3.3);
    near(l.near(1.9), 1.65);
    near(l.near(2.1), 3.3);
    const st = farStats(l, 12, VIH, VIL);
    expect(st.fallBacks).toBe(0);
    expect(st.overshoot).toBeLessThan(1e-6);
  });
  it('parallel termination (RL = Z0): no reflection, the far end settles at once to V·Z0/(Z0+Rs)', () => {
    const l = lattice({ ...base, rs: 5, rl: 50 });
    near(l.gammaL, 0, 1e-12);
    near(l.far(1.01), (3.3 * 50) / 55);
    near(l.near(3), (3.3 * 50) / 55);
  });
  it('a ramp edge is the step smoothed over `rise`: the far end of a matched line is the ramp, delayed', () => {
    const l = lattice({ v: 1.8, rs: 50, z0: 50, delay: 0.5, rl: 50, rise: 0.4 });
    near(l.far(0.5 + 0.2), 0.9 * 0.5, 1e-9);
    near(l.far(0.5 + 0.4), 0.9, 1e-9);
  });
  it('position-dependent voltage agrees with near (x = 0) and far (x = 1), and a front sits at x = t / delay', () => {
    const l = lattice({ ...base, rs: 10, rl: Infinity });
    expect(l.at(0, 0.7)).toBe(l.near(0.7));
    expect(l.at(1, 1.3)).toBe(l.far(1.3));
    near(l.at(0.25, 0.5), l.launch);
    near(l.at(0.75, 0.5), 0, 1e-9);
  });
  it('an undriven-low strong driver rings: overshoot above V, falls back below VIH (Rs = 10, open, 1.8 V)', () => {
    const l = lattice({ v: VIO, rs: 10, z0: 50, delay: 1, rl: Infinity, rise: 0.2 });
    const st = farStats(l, 40);
    expect(st.peak).toBeGreaterThan(VIO * 1.5);
    expect(st.overshoot).toBeGreaterThan(0.5);
    near(st.firstHigh!, 1, 0.2);
    expect(sampleLine(l, 10, 50).far.length).toBe(51);
  });
  it('the smallest Rs that keeps the far end high: monotone, and below Z0 for an open end', () => {
    const rs = minRsStaysHigh(VIO, 50, 1, 0.2)!;
    expect(rs).toBeGreaterThan(1);
    expect(rs).toBeLessThan(50);
    const ok = farStats(lattice({ v: VIO, rs, z0: 50, delay: 1, rl: Infinity, rise: 0.2 }), 60);
    const bad = farStats(lattice({ v: VIO, rs: rs - 1, z0: 50, delay: 1, rl: Infinity, rise: 0.2 }), 60);
    expect(ok.fallBacks).toBe(0);
    expect(bad.fallBacks).toBeGreaterThan(0);
  });
});

describe('lumped or a line', () => {
  it('delay of 6.67 ps/mm; the critical length of a 1 ns edge is 25 mm, of a 100 ps edge 2.5 mm', () => {
    near(boardDelay(150), 1.0005, 1e-3);
    near(criticalLength(1), 25, 1e-2);
    near(criticalLength(0.1), 2.5, 1e-2);
    expect(isLumped(0.01, 0.2)).toBe(true);
    expect(isLumped(0.1, 0.2)).toBe(false);
  });
  it('telegrapher: Z0 = √(L/C), delay = √(LC); 50 Ω and 6.67 ps/mm give 333 nH/m and 133 pF/m', () => {
    const { l, c } = lcOf(50, 6.67);
    near(l, 333.5, 1e-3);
    near(c, 133.4, 1e-3);
    const b = z0Of(l, c);
    near(b.z0, 50);
    near(b.psPerMm, 6.67);
  });
  it('series resistor and parallel power', () => {
    expect(seriesResistor(20, 50)).toBe(30);
    expect(seriesResistor(80, 50)).toBe(0);
    near(parallelPower(1.8, 5, 50), (1.8 * 1.8 * 50) / (55 * 55));
  });
});

describe('on-chip wire', () => {
  const rd = 1000;
  it('50 % delay terms: ln 2 Rd (Cw+Cl) + 0.38 Rw Cw + ln 2 Rw Cl', () => {
    const w = { rd, len: 2, cl: 20 };
    const t = wireDelayTerms(w), R = 2 * WIRE_R_PER_MM, C = 2 * WIRE_C_PER_MM;
    near(t.driver, (Math.LN2 * rd * (C + 20)) / 1000);
    near(t.wire, (0.38 * R * C) / 1000);
    near(t.load, (Math.LN2 * R * 20) / 1000);
    near(t.total, wireDelay(w));
  });
  it('the wire term is quadratic in length: doubling a pure wire quadruples it', () => {
    const a = wireDelayTerms({ rd: 0.001, len: 1, cl: 0 }).wire, b = wireDelayTerms({ rd: 0.001, len: 2, cl: 0 }).wire;
    near(b / a, 4);
    // with a driver in front the growth is between linear and quadratic: (2·driver + 4·wire) / (driver + wire)
    const t4 = wireDelayTerms({ rd, len: 4, cl: 0 });
    near(wireDelay({ rd, len: 8, cl: 0 }) / wireDelay({ rd, len: 4, cl: 0 }), (2 * t4.driver + 4 * t4.wire) / (t4.driver + t4.wire), 1e-9);
  });
  it('Elmore: Rd (Cw + Cl) + Rw (Cw/2 + Cl)', () => {
    const w = { rd: 500, len: 1, cl: 10 };
    near(elmoreDelay(w), (500 * (200 + 10) + 1000 * (100 + 10)) / 1000);
  });
  it('a numeric RC ladder reproduces 0.38 RC for a bare wire and the full formula with a driver and a load (within 3 %)', () => {
    const bare = { rd: 1, len: 4, cl: 0 }, RC = (4 * WIRE_R_PER_MM * 4 * WIRE_C_PER_MM) / 1000;
    near(wireLadder(bare, 2 * RC, RC / 400).t50, 0.38 * RC, 0.03);
    const mixed = { rd: 2000, len: 2, cl: 30 };
    const exact = wireLadder(mixed, 3 * wireDelay(mixed), 1).t50;
    near(exact, wireDelay(mixed), 0.06);
    // a lumped RC alone (no wire): ln 2 R C
    near(wireLadder({ rd: 1000, len: 0.0001, cl: 100 }, 400, 0.5).t50, rcDelay50(1000, 100), 0.03);
  });
  it('the length where the wire matches the driver is 1.82 Rd / r', () => {
    const rdOhm = 1820, L = wireDominates(rdOhm);
    near(L, 1.82 * 1.82 * 1, 0.02); // Rd = 1820 Ω, r = 1 kΩ/mm: 1.82 × 1.82 mm… (ln2/0.38 = 1.824)
    const t = wireDelayTerms({ rd: rdOhm, len: L, cl: 0 });
    near(t.driver, t.wire, 1e-3);
  });
  it('the repeater optimum: closed form agrees with an integer search within a few percent, and delay grows linearly with length', () => {
    const o = repeaterOptimum();
    const h = o.h;
    for (const len of [10, 20, 40]) {
      let best = Infinity;
      for (let k = 1; k <= 200; k++) best = Math.min(best, repeatedDelay(len, k, h));
      near(best, o.psPerMm * len, 0.03);
      const p = bestRepeaters(len);
      near(p.delay, best, 1e-9);
      near(p.k, o.kPerMm * len, 0.2);
    }
    // linear: 4× the length costs 4× (within the rounding of k)
    near(bestRepeaters(40).delay / bestRepeaters(10).delay, 4, 0.03);
    // h² = R0 c / (r C0)
    near(o.h * o.h, (unitR() * WIRE_C_PER_MM) / (WIRE_R_PER_MM * C_UNIT_IN), 1e-9);
  });
  it('repeaters win on long wires and lose on short ones; area and switched capacitance grow with them', () => {
    expect(bestRepeaters(10).delay).toBeLessThan(wireDelay({ rd: unitR() / bestRepeaters(10).h, len: 10, cl: 0 }) / 5);
    expect(bestRepeaters(0.05).k).toBe(1);
    const p = bestRepeaters(10);
    expect(p.area).toBeCloseTo(p.k * p.h, 9);
    expect(p.switched).toBeGreaterThan(10 * WIRE_C_PER_MM);
    expect(p.stageEffort).toBeGreaterThan(1);
  });
});

describe('crosstalk and ground bounce', () => {
  it('Kb = ¼(kc + kl); near-end amplitude Kb·V on a long run, scaled down on a short one; a stripline (kc = kl) has no far-end crosstalk', () => {
    const x = crosstalk({ v: 1.8, rise: 0.2, delay: 1, kc: 0.1, kl: 0.2 });
    near(x.kb, 0.075);
    near(x.next, 0.075 * 1.8);
    near(x.nearAt(0.9), 0.075 * 1.8, 1e-9);
    near(x.nearAt(2.3), 0, 1e-9);
    near(x.fext, 0.5 * (0.1 - 0.2) * (1 / 0.2) * 1.8);
    expect(x.fext).toBeLessThan(0);
    expect(crosstalk({ v: 1.8, rise: 0.2, delay: 1, kc: 0.2, kl: 0.2 }).fext).toBe(0);
    const short = crosstalk({ v: 1.8, rise: 1, delay: 0.1, kc: 0.1, kl: 0.2 });
    near(short.next, 0.075 * 1.8 * 0.2);
    expect(x.farAt(1.1)).toBe(x.fext);
    expect(x.farAt(3)).toBe(0);
  });
  it('coupling falls with spacing: the 3W rule leaves a few percent', () => {
    expect(coupling(0.5).kl).toBeGreaterThan(coupling(3).kl);
    const k3 = coupling(3), kb = 0.25 * (k3.kl + k3.kc);
    expect(kb).toBeLessThan(0.02);
  });
  it('ground bounce: L · n · di/dt (8 outputs of 20 mA in 1 ns through 5 nH = 0.8 V)', () => {
    near(groundBounce(8, 0.02, 1, 5), 0.8);
    near(groundBounce(1, 0.02, 1, 5), 0.1);
  });
});

describe('differential pair', () => {
  const d = { amp: 0.2, common: 0.3, mismatch: 0.02, cmrrDb: 40, offset: 0.005, vcm: 0.9, range: [0.2, 1.6] as [number, number] };
  it('noise left = common · (mismatch + 10^(−CMRR/20)) + offset, and the margins follow', () => {
    const r = differential(d);
    near(r.diffNoise, 0.3 * (0.02 + 0.01) + 0.005);
    near(r.singleMargin, 0.2 - 0.3);
    near(r.diffMargin, 0.4 - r.diffNoise);
    expect(r.singleMargin).toBeLessThan(0);
    expect(r.diffMargin).toBeGreaterThan(0);
    near(r.rejectionDb, 20 * Math.log10(0.3 / r.diffNoise));
    expect(r.inRange).toBe(true);
  });
  it('too much common-mode leaves the receiver\'s range', () => {
    expect(differential({ ...d, common: 0.8 }).inRange).toBe(false);
  });
});

describe('channel', () => {
  it('erfc / Q against known values', () => {
    near(erfc(0), 1, 1e-6);
    near(erfc(1), 0.157299207, 1e-5);
    near(erfc(2), 0.004677735, 1e-5);
    near(erfc(-1), 2 - 0.157299207, 1e-5);
    near(qFunc(0), 0.5, 1e-6);
    near(qFunc(1), 0.158655254, 1e-5);
    near(qFunc(3), 0.001349898, 1e-4);
    near(qFunc(7), 1.279e-12, 1e-2);
    near(berOf(0.3, 0.05), qFunc(6));
    expect(berOf(0, 0)).toBe(0.5);
    expect(berOf(0.1, 0)).toBe(0);
    near(qOf(0.6, 0.05), 6);
  });
  it('PRBS-n is maximal: period 2^n − 1, with 2^(n−1) ones', () => {
    for (const n of [7, 9, 11, 15] as const) {
      const p = (1 << n) - 1, b = prbs(n, 2 * p);
      expect(b.slice(0, p).reduce((a, x) => a + x, 0)).toBe(1 << (n - 1));
      expect(Array.from(b.slice(0, p))).toEqual(Array.from(b.slice(p)));
      // not periodic sooner: the state does not repeat before p bits
      const first = Array.from(b.slice(0, 40));
      for (let k = 1; k < Math.min(p, 200); k++) expect(Array.from(b.slice(k, k + 40))).not.toEqual(first);
    }
  });
  it('seeded: the same seed, the same numbers', () => {
    const a = rng(7), b = rng(7);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
  });
  it('a fast channel has an open eye; opening falls as the bandwidth falls; ISI closes it', () => {
    const bits = prbs(9, 1022);
    const wide = eye(bits, { rate: 1, bandwidth: 5 }), mid = eye(bits, { rate: 1, bandwidth: 0.2 }), narrow = eye(bits, { rate: 1, bandwidth: 0.08 });
    expect(wide.opening).toBeGreaterThan(1.9);
    expect(wide.opening).toBeGreaterThan(mid.opening);
    expect(mid.opening).toBeGreaterThan(narrow.opening);
    expect(narrow.opening).toBeLessThan(0);
    near(wide.ui, 1000);
    expect(wide.isi).toBeLessThan(0.05);
  });
  it('the isolated-bit closed form: a single pole after a run of n equal bits reaches 1 − 2 e^(−n UI / τ) of the swing', () => {
    // a lone 1 after zeros: at the end of its UI the output is 1 − e^(−UI/τ) from −1: -1 + 2 (1 − e^(−UI/τ))
    const bits = new Uint8Array(200).fill(0); bits[100] = 1;
    const ch = { rate: 1, bandwidth: 0.5, spu: 40 }, e = eye(bits, ch, 0);
    const tau = 1000 / (2 * Math.PI * 0.5), expect1 = -1 + 2 * (1 - Math.exp(-1000 / tau));
    near(e.wave[100 * 40 + 39], expect1, 5e-3);
  });
  it('de-emphasis recovers some opening at the same bandwidth', () => {
    const bits = prbs(9, 1022);
    const plain = eye(bits, { rate: 1, bandwidth: 0.1 }), emph = eye(bits, { rate: 1, bandwidth: 0.1, de: 0.3 });
    expect(plain.opening).toBeLessThan(0);
    expect(emph.opening).toBeGreaterThan(0.1);
  });
  it('link: Q = opening / (2 sigma); BER = Q(Q); a closed eye is a coin toss', () => {
    const bits = prbs(9, 1022), ch = { rate: 1, bandwidth: 3 };
    const l = link(bits, ch, 0.15);
    near(l.q, l.eye.opening / 2 / 0.15);
    near(l.ber, qFunc(l.q));
    expect(link(bits, { rate: 1, bandwidth: 0.05 }, 0.1).ber).toBe(0.5);
  });
  it('minBandwidth: the bandwidth for an open eye at 1 Gb/s on PRBS-9 is about 0.22 GHz, and doubles with the rate', () => {
    const b1 = minBandwidth(1), b2 = minBandwidth(2);
    near(b2 / b1, 2, 0.02);
    expect(b1).toBeGreaterThan(0.18);
    expect(b1).toBeLessThan(0.28);
  });
});
