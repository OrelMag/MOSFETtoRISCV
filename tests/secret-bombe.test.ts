// How Enigma broke, computed: the key's size, what the reflector leaves of a crib, and the Bombe finding the setting a message was
// really enciphered with, with its plugs unknown.
import { describe, expect, it } from 'vitest';
import { BOMBE_KEY, BOMBE_PLAIN, bombeCipher, bombeStops, centreOf, cribOffsets, involutions26, log2, m4KeySpace, menuOf, periodOf, plugCount, type BombeSetup } from '../src/crypto/bombe';
import { chr, DEFAULT_SETTINGS, Enigma, idx, U264, plugMap } from '../src/crypto/enigma';

const setup = (over: Partial<BombeSetup> = {}): BombeSetup => ({
  rotors: BOMBE_KEY.rotors, rings: BOMBE_KEY.rings, reflector: 'b', greek: 'beta', greekAt: BOMBE_KEY.start[0], crib: BOMBE_PLAIN, cipher: bombeCipher(), diagonal: true, ...over,
});

describe('the size of the key', () => {
  it('counts plug settings as the published figure: 10 cables, 150 738 274 937 250', () => {
    expect(plugCount(10)).toBe(150738274937250n);
    expect(plugCount(0)).toBe(1n);
    expect(plugCount(13)).toBe(7905853580625n);
  });
  it('adds up to about 2^85.7, and nearly all of that is the plugboard', () => {
    const k = m4KeySpace();
    expect(k.total).toBe(k.withoutPlugs * k.plugs);
    expect(k.withoutPlugs).toBe(415182802944n); // Crypto Museum's figure
    expect(k.bits).toBeCloseTo(85.7, 1);
    expect(log2(k.withoutPlugs)).toBeLessThan(39);
    expect(log2(k.plugs)).toBeGreaterThan(47);
  });
  it('log2 is exact on big numbers', () => {
    expect(log2(1n << 128n)).toBeCloseTo(128, 9);
    expect(log2(1024n)).toBeCloseTo(10, 9);
  });
  it('the left and Greek rings add nothing: a ring there is the same as turning that window', () => {
    const base = { ...DEFAULT_SETTINGS, rotors: ['I', 'II', 'III'] as ['I', 'II', 'III'], plugs: 'AB' };
    const text = 'THEQUICKBROWNFOXJUMPSOVERTHELAZYDOG'.repeat(30);
    expect(new Enigma({ ...base, rings: 'ACAA', start: 'ACAA' }).run(text)).toBe(new Enigma({ ...base, rings: 'AAAA', start: 'AAAA' }).run(text));
    expect(new Enigma({ ...base, rings: 'GAAA', start: 'GAAA' }).run(text)).toBe(new Enigma({ ...base, rings: 'AAAA', start: 'AAAA' }).run(text));
  });
  it('but the middle and right rings do add: they move the notch relative to the wiring', () => {
    const base = { ...DEFAULT_SETTINGS, plugs: '' }, text = 'A'.repeat(800);
    expect(new Enigma({ ...base, rings: 'AABA', start: 'AABA' }).run(text)).not.toBe(new Enigma({ ...base, rings: 'AAAA', start: 'AAAA' }).run(text));
    expect(new Enigma({ ...base, rings: 'AAAB', start: 'AAAB' }).run(text)).not.toBe(new Enigma({ ...base, rings: 'AAAA', start: 'AAAA' }).run(text));
  });
  it('any one position is one of 25 · 23 · … · 1 swaps of 26 letters', () => {
    expect(involutions26()).toBe(7905853580625n);
    const e = new Enigma(U264.settings);
    for (let n = 0; n < 300; n++) {
      e.step();
      for (let i = 0; i < 26; i++) {
        const o = e.trace(chr(i)).output;
        expect(o).not.toBe(chr(i));
        expect(e.trace(o).output).toBe(chr(i));
      }
    }
  });
  it('the double notches of VI, VII and VIII shorten the stepping period', () => {
    expect(periodOf(['I', 'II', 'III'])).toBe(26 * 25 * 26);
    const six = periodOf(['I', 'II', 'VI']), all = periodOf(['VI', 'VII', 'VIII']);
    expect(six).toBeLessThan(26 * 25 * 26);
    expect(all).toBeLessThan(six);
  });
});

describe('the crib', () => {
  it('the true place always survives; many others do not', () => {
    const at = U264.plain.indexOf('BEIANGRIFF');
    const o = cribOffsets(U264.cipher, 'BEIANGRIFF');
    expect(o).toContain(at);
    expect(o.length).toBeLessThan(U264.cipher.length - 10 + 1);
    expect(o.length).toBeGreaterThan(1);
  });
  it('the longer the crib the fewer places survive', () => {
    expect(cribOffsets(U264.cipher, 'BEIANGRIFFUNTERWASSER').length).toBeLessThan(cribOffsets(U264.cipher, 'BEIANGRIFF').length);
  });
});

describe('the Bombe', () => {
  const windows = BOMBE_KEY.start;
  it('the demonstration message is what the cipher makes, and its crib stands where no letter crashes', () => {
    expect(new Enigma(BOMBE_KEY).run(bombeCipher())).toBe(BOMBE_PLAIN);
    expect(cribOffsets(bombeCipher(), BOMBE_PLAIN)).toEqual([0]);
    expect(menuOf(BOMBE_PLAIN, bombeCipher())).toHaveLength(BOMBE_PLAIN.length);
  });
  it('finds the true setting among its stops, with the plugboard unknown', () => {
    const stops = bombeStops(setup());
    expect(stops.map((s) => s.windows)).toContain(windows);
    expect(stops.length).toBeLessThan(200);
  });
  it('names the true plug for the centre letter at the true stop', () => {
    const c = centreOf(BOMBE_PLAIN, bombeCipher()), pl = plugMap(BOMBE_KEY.plugs), stops = bombeStops(setup()).filter((s) => s.windows === windows);
    expect(stops.length).toBe(1);
    expect(stops[0].plug).toBe(c);
    expect(stops[0].value).toBe(chr(pl[idx(c)]));
  });
  it('the diagonal board rules out more: Welchman’s improvement, measured', () => {
    const w = bombeStops(setup({ diagonal: true })).length, wo = bombeStops(setup({ diagonal: false })).length;
    expect(w).toBeLessThan(wo);
  });
  it('a wrong wheel order gives no true stop', () => {
    expect(bombeStops(setup({ rotors: ['I', 'V', 'III'] })).map((s) => s.windows)).not.toContain(windows);
  });
  it('works on other keys too', () => {
    for (const [start, plugs] of [['AXJP', 'AB CD EF GH IJ KL MN OP QR ST'], ['ACAA', 'AZ BY CX DW EV FU GT HS IR JQ']] as const) {
      const key = { ...BOMBE_KEY, start, plugs }, cipher = new Enigma(key).run(BOMBE_PLAIN);
      expect(bombeStops(setup({ cipher, greekAt: start[0] })).map((s) => s.windows)).toContain(start);
    }
  });
});
