// Campaign drills: every generated question accepts its own answer and rejects a wrong one; the
// Boolean parser and the exact K-map minimiser agree with brute force; Act P's relay numbers are the
// physical model's and its card answers round-trip through the Hollerith code.

import { describe, expect, it } from 'vitest';
import { CARD_WORDS, checkExpr, DRILLS, evalBool, minimumCover, parseBool, parseNum, parseQty, relayThresholds, rng, sopLiterals, sopText } from '../src/campaign/drills';
import { objectCard, seqText, wordOf } from '../src/cards/card';
import { charOf, punchOf, ROW9, rowsOfChar } from '../src/cards/hollerith';
import { RELAY, RELAY_COIL_POWER, RELAY_STEP_MS, RELAY_SUPPLY, relaySim, relayStatic, relaySummary } from '../src/phys/relay';
import { F16, parts, RM, roundToX } from '../src/sim/fpref';

describe('the Boolean parser', () => {
  const V = ['a', 'b', 'c', 'd'];
  const truth = (src: string) => {
    const p = parseBool(src, V);
    if ('error' in p) throw new Error(p.error);
    return Array.from({ length: 16 }, (_, x) => evalBool(p.ex, x, 4)).join('');
  };
  it('reads every notation the drills accept', () => {
    expect(truth("a'b + cd")).toBe(truth('¬a·b + c·d'));
    expect(truth('!a & b | c * d')).toBe(truth("a'b+cd"));
    expect(truth("(a + b)'")).toBe(truth("a'b'"));
    expect(truth('a ^ b')).toBe(truth("ab' + a'b"));
    expect(truth('~(a b)')).toBe(truth("a' + b'"));
    expect(truth("a''")).toBe(truth('a'));
    expect(truth('1')).toBe('1'.repeat(16));
  });
  it('counts literals and reports errors', () => {
    expect(parseBool("a'b + cd", V)).toMatchObject({ literals: 4 });
    expect(parseBool('a + ', V)).toHaveProperty('error');
    expect(parseBool('a + e', V)).toEqual({ error: 'unknown variable e (use a, b, c, d)' });
    expect(parseBool('(a + b', V)).toHaveProperty('error');
  });
});

describe('the exact minimiser', () => {
  it('finds a cover no larger than any other, for random 4-variable functions with don\'t-cares', () => {
    const r = rng(5);
    for (let t = 0; t < 60; t++) {
      const ones: number[] = [], dc: number[] = [];
      for (let x = 0; x < 16; x++) { const u = r(); if (u < 0.4) ones.push(x); else if (u < 0.5) dc.push(x); }
      const min = minimumCover(4, ones, dc);
      const k = { vars: ['a', 'b', 'c', 'd'], ones, dc };
      // It is a correct cover, and its own text passes the checker at its own literal count.
      expect(checkExpr(sopText(min, k.vars), k, sopLiterals(min, 4))).toEqual({ ok: true });
    }
  });
  it('knows the classics', () => {
    // Majority: ab + ac + bc (6 literals).
    expect(sopLiterals(minimumCover(3, [3, 5, 6, 7]), 3)).toBe(6);
    // XOR of 3: no grouping possible: 4 terms of 3.
    expect(minimumCover(3, [1, 2, 4, 7]).length).toBe(4);
    // With don't-cares, BCD "≥ 5": a + bd + bc.
    expect(sopLiterals(minimumCover(4, [5, 6, 7, 8, 9], [10, 11, 12, 13, 14, 15]), 4)).toBe(5);
  });
});

describe('drills', () => {
  it('parse numbers in every base', () => {
    expect(parseNum('0x1F')).toBe(31);
    expect(parseNum('0b1010_1010')).toBe(170);
    expect(parseNum('-12')).toBe(-12);
    expect(parseNum('12a')).toBeNull();
  });

  it.each(Object.values(DRILLS).map((d) => [d.id, d] as const))('%s: every question accepts its own answer and rejects nonsense', (_, d) => {
    const r = rng(42);
    for (let i = 0; i < 80; i++) {
      const q = d.make(r);
      expect(q.check(q.answer), `${q.prompt} → ${q.answer}`).toMatchObject({ ok: true });
      expect(q.check('zz').ok, q.prompt).toBe(false);
    }
  });

  it('binary16: rounding questions agree with the reference float model, kinds with the encoding', () => {
    const r = rng(7);
    let rounds = 0, kinds = 0;
    for (let i = 0; i < 400; i++) {
      const q = DRILLS.float.make(r);
      const m = q.prompt.match(/(−?)1\.([01]{10})<u>([01]{3})<\/u>₂ × 2\^(-?\d+)/);
      if (m) {
        rounds++;
        const want = roundToX(m[1] ? 1 : 0, BigInt(`0b1${m[2]}${m[3]}`), Number(m[4]) - 13, F16, RM.RNE).y;
        expect(q.answer, q.prompt).toBe(`0x${want.toString(16).toUpperCase().padStart(4, '0')}`);
      }
      const k = q.prompt.match(/pattern <code>0x([0-9A-F]{4})<\/code>: zero/);
      if (k) {
        kinds++;
        const p = parts(parseInt(k[1], 16), F16);
        expect(q.answer).toBe({ zero: 'zero', subnormal: 'subnormal', normal: 'normal', inf: 'infinity', nan: 'NaN' }[p.kind]);
      }
    }
    expect(rounds).toBeGreaterThan(50);
    expect(kinds).toBeGreaterThan(40);
  });

  it('a K-map answer must also be minimal', () => {
    const k = { vars: ['a', 'b', 'c'], ones: [3, 5, 6, 7], dc: [] };
    expect(checkExpr('ab + ac + bc', k, 6).ok).toBe(true);
    expect(checkExpr("abc + ab'c + abc' + a'bc", k, 6)).toMatchObject({ ok: false, why: expect.stringMatching(/minimum is 6/) });
    expect(checkExpr('ab + bc', k, 6)).toMatchObject({ ok: false, why: expect.stringMatching(/wrong for a=1 b=0 c=1/) });
  });
});

describe('Act P drills', () => {
  const ms = (t: number | null) => (t === null ? NaN : t * 1e3);
  const svgs = (p: string) => p.match(/<svg[\s\S]*?<\/svg>/g) ?? [];

  it('read quantities with or without units', () => {
    expect(parseQty('15.2', 'V')).toBe(15.2);
    expect(parseQty('15,2 V', 'V')).toBe(15.2);
    expect(parseQty('1440 mW', 'W')).toBeCloseTo(1.44, 9);
    expect(parseQty('0.0082 s', 'ms')).toBeCloseTo(8.2, 9);
    expect(parseQty('8.2ms', 'ms')).toBe(8.2);
    expect(parseQty('−117 V', 'V')).toBe(-117);
    expect(parseQty('5 A', 'V')).toBeNull();
    expect(parseQty('zz', 'V')).toBeNull();
  });

  it('relay: every number is the model\'s, within the stated tolerance, and the charts stay small', () => {
    const { pull, drop } = relayStatic();
    const nominal = relaySummary(relaySim(RELAY_SUPPLY));
    const r = rng(11), seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const q = DRILLS.relay.make(r);
      expect(q.check(q.answer).ok, q.prompt).toBe(true);
      for (const s of svgs(q.prompt)) expect(s.length, q.prompt.slice(0, 80)).toBeLessThan(3500);
      const chap = q.prompt.startsWith("The chapter's relay");
      const v = parseQty(q.answer, 'V');
      if (/pull-in<\/b> voltage/.test(q.prompt)) {
        seen.add('pull');
        expect(q.check(String(v! + 0.2)).ok).toBe(true);
        expect(q.check(String(v! + 0.5)).ok).toBe(false);
        if (chap) expect(v).toBeCloseTo(pull!, 2);
      } else if (/drop-out<\/b> voltage/.test(q.prompt)) {
        seen.add('drop');
        if (chap) expect(v).toBeCloseTo(drop!, 2);
      } else if (/hysteresis/.test(q.prompt)) {
        seen.add('hyst');
        if (chap) expect(v).toBeCloseTo(pull! - drop!, 2);
      } else if (/Is the make contact closed/.test(q.prompt)) {
        seen.add('yesno');
        const V = Number(q.prompt.match(/set to <b>([\d.]+) V/)![1]);
        if (chap) expect(q.answer).toBe((/operated/.test(q.prompt) ? V > drop! : V >= pull!) ? 'yes' : 'no');
        expect(q.check(q.answer === 'yes' ? 'no' : 'yes').ok).toBe(false);
      } else if (/does the make contact first touch/.test(q.prompt)) {
        seen.add('touch');
        const V = Number(q.prompt.match(/switched on at <b>(\d+) V/)![1]);
        expect(parseQty(q.answer, 'ms')).toBeCloseTo(ms(relaySummary(relaySim(V)).firstTouch), 1);
        expect(q.check(`${parseQty(q.answer, 'ms')! + 1} ms`).ok).toBe(false);
      } else if (/bounces\)/.test(q.prompt)) {
        seen.add('bounces');
        if (!/restitution/.test(q.prompt) && /at <b>24 V/.test(q.prompt)) expect(q.answer).toBe(String(nominal.bounces));
        expect(q.check(String(Number(q.answer) + 1)).ok).toBe(false);
      } else if (/close for good/.test(q.prompt)) {
        seen.add('settled');
        if (!/restitution/.test(q.prompt) && /at <b>24 V/.test(q.prompt)) expect(parseQty(q.answer, 'ms')).toBeCloseTo(RELAY_STEP_MS, 1);
      } else if (/after switch-off does/.test(q.prompt)) {
        seen.add('release');
        if (!/quench/.test(q.prompt) && /at <b>24 V/.test(q.prompt)) expect(parseQty(q.answer, 'ms')).toBeCloseTo(ms(nominal.release), 1);
      } else if (/What power/.test(q.prompt)) {
        seen.add('power');
        if (/A 400 Ω relay coil on <b>24 V/.test(q.prompt)) expect(parseQty(q.answer, 'W')).toBeCloseTo(RELAY_COIL_POWER, 2);
        expect(q.check(`${parseQty(q.answer, 'W')! * 1.05}`).ok).toBe(false);
      } else if (/quench resistor across the coil/.test(q.prompt)) {
        seen.add('spike');
        if (/on <b>24 V.*<b>4000 Ω/.test(q.prompt)) expect(parseQty(q.answer, 'V')).toBeCloseTo(nominal.spike, -1);
        expect(q.check(q.answer.replace('-', '')).ok).toBe(false);
      } else throw new Error(`unclassified: ${q.prompt}`);
    }
    expect([...seen].sort()).toEqual(['bounces', 'drop', 'hyst', 'power', 'pull', 'release', 'settled', 'spike', 'touch', 'yesno']);
  });

  it('relay: the thresholds follow the coil', () => {
    expect(relayThresholds(RELAY).pull).toBeCloseTo(relayStatic().pull!, 2);
    // Pull-in is a current: a coil of 1.5 × the resistance (same turns) needs 1.5 × the voltage.
    expect(relayThresholds({ ...RELAY, Rc: 600 }).pull / relayThresholds(RELAY).pull).toBeCloseTo(1.5, 1);
  });

  it('hollerith: answers round-trip through the card code', () => {
    const r = rng(3), seen = new Set<string>();
    const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    for (let i = 0; i < 300; i++) {
      const q = DRILLS.hollerith.make(r);
      expect(q.check(q.answer).ok, q.prompt).toBe(true);
      for (const s of svgs(q.prompt)) expect(s.length).toBeLessThan(3500);
      const holes = (svgs(q.prompt)[0] ?? '').match(/<rect /g)?.length ?? 0;
      if (/What character/.test(q.prompt)) {
        seen.add('char');
        expect(charOf(punchOf(q.answer)!)).toBe(q.answer);
        expect(holes).toBe(rowsOfChar(q.answer)!.split('-').length);
        expect(q.check(q.answer === 'A' ? 'B' : 'A').ok).toBe(false);
      } else if (/Which rows/.test(q.prompt)) {
        seen.add('rows');
        const ch = unesc(q.prompt.match(/<code>(.+)<\/code>/)![1]);
        expect(q.answer).toBe(rowsOfChar(ch));
        expect(q.check(q.answer.split('-').reverse().join(', ')).ok).toBe(true);
        expect(q.check(q.answer === '9' ? '8' : '9').ok).toBe(false);
      } else if (/source card/.test(q.prompt)) {
        seen.add('word');
        expect(CARD_WORDS).toContain(q.answer);
        expect(holes).toBe([...q.answer].reduce((n, c) => n + (rowsOfChar(c) ? rowsOfChar(c)!.split('-').length : 0), 0));
        expect(q.check(q.answer.slice(1)).ok).toBe(false);
      } else if (/Its value in hex/.test(q.prompt)) {
        seen.add('value');
        const bits = Number(q.prompt.match(/\((\d+) bits/)![1]);
        // Hole x = 24 + 14·(column − 1) + 7 − 3 (cardFig's geometry).
        const cols = [...svgs(q.prompt)[0]!.matchAll(/<rect x="(\d+)"/g)].map((m) => (Number(m[1]) - 28) / 14 + 1);
        expect(parseNum(q.answer)).toBe(cols.reduce((w, c) => w + 2 ** (bits - c), 0));
        expect(q.check(`0x${(parseNum(q.answer)! ^ 1).toString(16)}`).ok).toBe(false);
      } else if (/get a hole in row 9/.test(q.prompt)) {
        seen.add('cols');
        const bits = Number(q.prompt.match(/the (\d+)-bit word/)![1]), w = parseInt(q.prompt.match(/<b>0x([0-9A-F]+)<\/b>/)![1], 16);
        const card = objectCard(w, '', seqText(0), bits);
        expect(wordOf(card, bits)).toBe(w);
        expect(q.answer.split(' ').map(Number)).toEqual(card.cols.slice(0, bits).flatMap((m, c) => (m & ROW9 ? [c + 1] : [])));
        expect(q.check(q.answer.split(' ').reverse().join(',')).ok).toBe(true);
        expect(q.check(q.answer.split(' ').length > 1 ? q.answer.split(' ').slice(1).join(' ') : String((Number(q.answer) % bits) + 1)).ok).toBe(false);
      } else throw new Error(`unclassified: ${q.prompt}`);
    }
    expect([...seen].sort()).toEqual(['char', 'cols', 'rows', 'value', 'word']);
    for (const w of CARD_WORDS) expect([...w].every((c) => punchOf(c) !== null), w).toBe(true);
  });
});
