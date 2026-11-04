// The M4's cipher against things it cannot be tuned to: a message Hartwig Looks's U-264 sent in 1942 (broken by the M4
// Project in 2006, and in the boat's war diary), and the three-rotor machine the M4 had to stay compatible with.
import { describe, expect, it } from 'vitest';
import {
  chr, DEFAULT_SETTINGS, Enigma, GREEK, idx, KEY_ROWS, letterOf, NOTCH_OFFSET, plugMap, REFLECTORS, ROTORS, SOCKET_ROWS, socketOf, stepPeriod, U264, WIDE_REFLECTORS,
  type EnigmaSettings, type RotorName,
} from '../src/crypto/enigma';

const NAMES = Object.keys(ROTORS) as RotorName[];

/** A plain three-rotor machine with a wide reflector, written separately from the class under test. */
function wide(refl: string, rotors: RotorName[], rings: string, start: string, plugs: string, text: string): string {
  const w = rotors.map((r) => [...ROTORS[r].wiring].map(idx)), inv = w.map((f) => { const g: number[] = []; f.forEach((v, i) => { g[v] = i; }); return g; });
  const turn = rotors.map((r) => ROTORS[r].turnover), R = [...rings].map(idx), p = [...start].map(idx), pl = plugMap(plugs), m = (x: number) => ((x % 26) + 26) % 26;
  let out = '';
  for (const ch of text) {
    const mid = turn[1].includes(chr(p[1])), right = turn[2].includes(chr(p[2]));
    if (mid) p[0] = m(p[0] + 1);
    if (mid || right) p[1] = m(p[1] + 1);
    p[2] = m(p[2] + 1);
    let c = pl[idx(ch)];
    for (let k = 2; k >= 0; k--) c = m(w[k][m(c + p[k] - R[k])] - p[k] + R[k]);
    c = idx(refl[c]);
    for (let k = 0; k < 3; k++) c = m(inv[k][m(c + p[k] - R[k])] - p[k] + R[k]);
    out += chr(pl[c]);
  }
  return out;
}

/** A small seeded generator (the same cases every run). */
function rng(seed: number) { let x = seed >>> 0; return (n: number) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x >>> 8) % n; }; }

function randomCase(r: (n: number) => number) {
  const pool = [...NAMES], rotors = [0, 1, 2].map(() => pool.splice(r(pool.length), 1)[0]) as [RotorName, RotorName, RotorName];
  const letters = (n: number) => Array.from({ length: n }, () => chr(r(26))).join('');
  const shuffled = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  for (let i = 25; i > 0; i--) { const j = r(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const plugs = Array.from({ length: r(14) }, (_, i) => shuffled[2 * i] + shuffled[2 * i + 1]).join(' ');
  return { rotors, rings: letters(3), start: letters(3), plugs, text: letters(300) };
}

describe('the M4 against history', () => {
  it('deciphers U-264’s 1942 message letter for letter', () => {
    expect(new Enigma(U264.settings).run(U264.cipher)).toBe(U264.plain);
  });
  it('enciphers it back: the machine is its own inverse', () => {
    expect(new Enigma(U264.settings).run(U264.plain)).toBe(U264.cipher);
  });
  it('the fourth wheel stood still through the whole message', () => {
    const e = new Enigma(U264.settings);
    e.run(U264.cipher);
    expect(e.windows()[0]).toBe('V');
  });
});

describe('compatibility with the three-rotor machine', () => {
  it('reproduces the well-known Enigma I test vector with Beta at A and thin b', () => {
    expect(new Enigma(DEFAULT_SETTINGS).run('AAAAA')).toBe('BDZGO');
  });
  it('Beta at A with thin b is reflector B; Gamma at A with thin c is reflector C', () => {
    const r = rng(1);
    for (let n = 0; n < 200; n++) {
      const c = randomCase(r);
      const m4 = (greek: 'beta' | 'gamma', reflector: 'b' | 'c') => new Enigma({ reflector, greek, rotors: c.rotors, rings: `A${c.rings}`, start: `A${c.start}`, plugs: c.plugs }).run(c.text);
      expect(m4('beta', 'b')).toBe(wide(WIDE_REFLECTORS.B, c.rotors, c.rings, c.start, c.plugs, c.text));
      expect(m4('gamma', 'c')).toBe(wide(WIDE_REFLECTORS.C, c.rotors, c.rings, c.start, c.plugs, c.text));
    }
  });
  it('the mixed pairings are something else', () => {
    const m = (greek: 'beta' | 'gamma', reflector: 'b' | 'c') => new Enigma({ ...DEFAULT_SETTINGS, greek, reflector }).run('AAAAAAAAAA');
    expect(m('beta', 'c')).not.toBe(m('beta', 'b'));
    expect(m('gamma', 'b')).not.toBe(m('gamma', 'c'));
  });
});

describe('the tables', () => {
  it('every wheel is a permutation; every reflector an involution without a fixed point', () => {
    for (const w of [...NAMES.map((n) => ROTORS[n].wiring), ...Object.values(GREEK)]) expect([...w].sort().join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    for (const w of [...Object.values(REFLECTORS), ...Object.values(WIDE_REFLECTORS)]) [...w].forEach((c, i) => { expect(idx(c)).not.toBe(i); expect(idx(w[idx(c)])).toBe(i); });
  });
  it('each notch is NOTCH_OFFSET past its turnover letter', () => {
    for (const n of NAMES) [...ROTORS[n].turnover].forEach((t, i) => expect(ROTORS[n].notch[i]).toBe(chr(idx(t) + NOTCH_OFFSET)));
  });
  it('VI, VII and VIII alone have two notches, half a turn apart', () => {
    for (const n of NAMES) {
      const t = ROTORS[n].turnover;
      expect(t.length).toBe(['VI', 'VII', 'VIII'].includes(n) ? 2 : 1);
      if (t.length === 2) expect(Math.abs(idx(t[0]) - idx(t[1]))).toBe(13);
    }
  });
  it('sockets are numbered A = 1, Y = 25, over rows of 9, 8 and 9; keys are all 26 once', () => {
    expect(socketOf('A')).toBe(1); expect(socketOf('Y')).toBe(25); expect(letterOf(26)).toBe('Z');
    expect(SOCKET_ROWS[0] + SOCKET_ROWS[1] + SOCKET_ROWS[2]).toBe(26);
    expect([...KEY_ROWS.join('')].sort().join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });
});

describe('stepping', () => {
  const at = (rotors: [RotorName, RotorName, RotorName], start: string) => new Enigma({ ...DEFAULT_SETTINGS, rotors, start });
  it('the right wheel moves on every press and carries the middle one at its turnover', () => {
    const e = at(['I', 'II', 'III'], 'AAAU'); // III turns over at V
    e.step(); expect(e.windows()).toBe('AAAV');
    e.step(); expect(e.windows()).toBe('AABW');
  });
  it('the middle wheel double-steps: the anomaly the pawls make', () => {
    const e = at(['I', 'II', 'III'], 'AADU'); // II turns over at E
    const seen = Array.from({ length: 5 }, () => { e.step(); return e.windows(); });
    expect(seen).toEqual(['AADV', 'AAEW', 'ABFX', 'ABFY', 'ABFZ']);
  });
  it('at a double step the middle wheel is moved by the left pawl: its own pawl stays up on the right wheel’s lip', () => {
    const e = at(['I', 'II', 'III'], 'AAEG'); // II at its turnover, III nowhere near
    expect(e.nextMoves()).toEqual([true, true, true]);
    expect(e.pawls()).toEqual([true, false, true]);
  });
  it('VI turns the next wheel over at both Z and M', () => {
    for (const s of ['AAAZ', 'AAAM']) expect(at(['I', 'II', 'VI'], s).nextMoves()[1]).toBe(true);
    expect(at(['I', 'II', 'VI'], 'AAAL').nextMoves()[1]).toBe(false);
  });
  it('the Greek wheel has no pawl, whatever stands beside it', () => {
    const e = at(['VI', 'VII', 'VIII'], 'GAAA');
    for (let n = 0; n < 20000; n++) e.step();
    expect(e.windows()[0]).toBe('G');
  });
  it('the period of three single-notch wheels is 26 × 25 × 26: the double step costs a turn of the middle wheel', () => {
    expect(stepPeriod({ ...DEFAULT_SETTINGS, rotors: ['I', 'II', 'III'] })).toBe(26 * 25 * 26);
  });
  it('rings move the notch with the letters, not with the wiring', () => {
    const a = new Enigma({ ...DEFAULT_SETTINGS, rings: 'AAAB' }), b = new Enigma({ ...DEFAULT_SETTINGS, rings: 'AAAA' });
    expect(a.nextMoves()).toEqual(b.nextMoves());
    expect(a.press('A').output).not.toBe(b.press('A').output);
  });
});

describe('the lamp', () => {
  it('no letter ever lights itself, and a press reverses', () => {
    const r = rng(7);
    for (let n = 0; n < 40; n++) {
      const c = randomCase(r), s: EnigmaSettings = { ...DEFAULT_SETTINGS, rotors: c.rotors, rings: `A${c.rings}`, start: `${chr(r(26))}${c.start}`, plugs: c.plugs };
      const e = new Enigma(s), f = new Enigma(s);
      for (const ch of c.text.slice(0, 80)) {
        const t = e.press(ch);
        expect(t.output).not.toBe(ch);
        expect(f.press(t.output).output).toBe(ch);
      }
    }
  });
  it('the trace is the output: the current’s path ends where the lamp is', () => {
    const e = new Enigma(U264.settings), pl = plugMap(U264.settings.plugs);
    for (const ch of U264.cipher.slice(0, 120)) {
      const t = e.press(ch);
      expect(t.out).toHaveLength(4); expect(t.ret).toHaveLength(4);
      expect(t.entry).toBe(pl[idx(ch)]);
      expect(t.ret[3]).toBe(t.exit);
      expect(chr(pl[t.exit])).toBe(t.output);
    }
  });
  it('refuses nonsense plugs', () => {
    expect(() => plugMap('AA')).toThrow(); expect(() => plugMap('AB AC')).toThrow(); expect(() => plugMap('A')).toThrow();
  });
});
