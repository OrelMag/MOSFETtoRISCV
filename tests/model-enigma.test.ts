// The Enigma's drawing held to its cipher: a wheel's notch stands under its pawl exactly when the model carries the next
// wheel, the windows read the model's letters, the lit lamp and the plugs are the model's, the current runs contact to contact.
import { describe, expect, it } from 'vitest';
import { chr, DEFAULT_SETTINGS, Enigma, idx, NOTCH_OFFSET, ROTORS, socketOf, type EnigmaSettings, type RotorName } from '../src/crypto/enigma';
import type { RGB } from '../src/gl/instances';
import {
  AX_Y, AX_Z, CASE_D, CASE_H, CASE_W, CONTACT_R, contactPoint, enigmaAnchors, enigmaParts, keyAt, lampAt, notchPhi, PAWL_PHI, pathPoints, PITCH, RIM_R, RIM_X, samePhi, socketAt, THUMB_DX, THUMB_R, WINDOW_PHI, WALL_H,
  type EnigmaPalette, type EnigmaPose,
} from '../src/widgets/enigma3dparts';
import { quatRotate } from '../src/gl/math';
import type { Part } from '../src/gl/parts';

const c = (i: number): RGB => [i / 24, 0.4, 0.6];
const P: EnigmaPalette = {
  wood: c(1), woodDark: c(2), black: c(3), panel: c(4), zinc: c(5), steel: c(6), brass: c(7), bakelite: c(8), ivory: c(9), red: c(10), paper: c(11),
  glass: c(12), lampOn: c(13), lampLetter: c(14), forward: c(15), back: c(16), cable: c(17), cotton: c(18),
};
const NAMES = Object.keys(ROTORS) as RotorName[];
const pose = (s: EnigmaSettings, o: Partial<EnigmaPose> = {}): EnigmaPose => {
  const e = new Enigma(s);
  return { settings: s, pos: e.pos, lid: 1, cover: 1, flap: 1, lamps: 0, out: 0, ghost: false, key: null, lit: null, stroke: 0, moves: e.nextMoves(), trace: null, ...o };
};
/** The world extent of a part. */
function extent(p: Part): { lo: [number, number, number]; hi: [number, number, number] } {
  const s = p.scale ?? [1, 1, 1], lo: [number, number, number] = [Infinity, Infinity, Infinity], hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const a of [-0.5, 0.5]) for (const b of [-0.5, 0.5]) for (const d of [-0.5, 0.5]) {
    const v = p.rot ? quatRotate(p.rot, [a * s[0], b * s[1], d * s[2]]) : [a * s[0], b * s[1], d * s[2]];
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.pos[k] + v[k]); hi[k] = Math.max(hi[k], p.pos[k] + v[k]); }
  }
  return { lo, hi };
}

describe('the notch and the pawl', () => {
  it('a notch stands at the pawl exactly when the window shows that wheel’s turnover letter', () => {
    for (const n of NAMES) for (let w = 0; w < 26; w++) {
      const atPawl = [...ROTORS[n].notch].some((l) => samePhi(notchPhi(l, w), PAWL_PHI));
      expect(atPawl).toBe(ROTORS[n].turnover.includes(chr(w)));
    }
  });
  it('the working point is behind the wheels at about the axle’s height, where the real pawls are', () => {
    expect(Math.sin(PAWL_PHI)).toBeLessThan(-0.95);
    expect(PAWL_PHI).toBeCloseTo(WINDOW_PHI - NOTCH_OFFSET * PITCH);
  });
  it('the moves the drawing is given are the cipher’s: the notch under the middle pawl moves all three', () => {
    const s: EnigmaSettings = { ...DEFAULT_SETTINGS, start: 'AAEB' }; // II at its turnover E
    expect(pose(s).moves).toEqual([true, true, true]);
    const notch = ROTORS.II.notch[0];
    expect(samePhi(notchPhi(notch, idx('E')), PAWL_PHI)).toBe(true);
  });
});

describe('the machine’s measures', () => {
  it('stays inside its case when shut: 280 × 340 × 150, handle, hinges and hardware aside', () => {
    const parts = enigmaParts(pose({ ...DEFAULT_SETTINGS, plugs: 'AQ BJ' }, { lid: 0, cover: 0, flap: 0 }), P);
    const margin = 12; // the back's handle and hinges stand off the wood
    for (const p of parts) {
      const { lo, hi } = extent(p);
      expect(lo[0]).toBeGreaterThanOrEqual(-CASE_W / 2 - 1);
      expect(hi[0]).toBeLessThanOrEqual(CASE_W / 2 + 1);
      expect(lo[1]).toBeGreaterThanOrEqual(-0.5);
      expect(hi[1]).toBeLessThanOrEqual(CASE_H + 1);
      expect(lo[2]).toBeGreaterThanOrEqual(-CASE_D / 2 - margin);
      expect(hi[2]).toBeLessThanOrEqual(CASE_D / 2 + 1);
    }
  });
  it('the flap lies flat on the table when down', () => {
    const open = enigmaParts(pose(DEFAULT_SETTINGS, { flap: 1 }), P);
    for (const p of open) expect(extent(p).lo[1]).toBeGreaterThanOrEqual(-0.5);
  });
  it('every wheel’s thumbwheel stands proud of the cover through its slot, and the rims stay under it', () => {
    expect(AX_Y + THUMB_R + 3).toBeGreaterThan(100);
    expect(AX_Y + RIM_R + 0.25).toBeLessThan(100 - 1.5);
    expect(100 - 1.5 - (AX_Y + RIM_R)).toBeLessThan(1.5); // right under the plate: an oblique view still reads the window's letter
    expect(RIM_X.map((x) => x + THUMB_DX)).toEqual([-69, -43, -16, 11]);
  });
  it('keys and lamps stand in the same rows; every letter has one', () => {
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { expect(keyAt(ch).x).toBe(lampAt(ch).x); expect(keyAt(ch).z).toBeGreaterThan(lampAt(ch).z); }
    expect(keyAt('Q').row).toBe(0); expect(keyAt('K').row).toBe(1); expect(keyAt('P').row).toBe(2);
  });
  it('sockets number left to right over three rows, and a plug goes in by number', () => {
    expect(socketAt(1).row).toBe(0); expect(socketAt(9).row).toBe(0); expect(socketAt(10).row).toBe(1); expect(socketAt(17).row).toBe(1); expect(socketAt(18).row).toBe(2); expect(socketAt(26).row).toBe(2);
    expect(socketOf('A')).toBe(1);
    expect(socketAt(2).x).toBeGreaterThan(socketAt(1).x);
  });
  it('the shut lid clears the panel', () => { expect(WALL_H).toBeGreaterThan(100); });
  it('plugs fit behind the shut flap, as they must on the real machine', () => {
    for (const p of enigmaParts(pose({ ...DEFAULT_SETTINGS, plugs: 'AQ BJ CK DL EM FN GO HP IR ST' }, { flap: 1, lid: 1 }), P)) if (p.color === P.black && p.pos[2] > 127 && p.pos[1] > 8) expect(extent(p).hi[2]).toBeLessThanOrEqual(156);
  });
});

describe('what is lit', () => {
  it('only the lamp the cipher lights glows', () => {
    const s = { ...DEFAULT_SETTINGS, plugs: 'AQ BJ' }, e = new Enigma(s), t = e.press('Q');
    const parts = enigmaParts(pose(s, { lit: t.output, key: 'Q', stroke: 1 }), P);
    const glow = parts.filter((p) => p.emissive && p.color === P.lampOn && p.kind === 'cyl' && (p.scale?.[1] ?? 0) > 1);
    const { x, z } = lampAt(t.output);
    expect(glow.length).toBeGreaterThan(0);
    for (const g of glow) { expect(g.pos[0]).toBeCloseTo(x); expect(g.pos[2]).toBeCloseTo(z); }
  });
  it('draws a pair of plugs for each pair, and none without', () => {
    const count = (plugs: string) => enigmaParts(pose({ ...DEFAULT_SETTINGS, plugs }), P).filter((p) => p.color === P.cable).length;
    expect(count('')).toBeGreaterThan(0); // the spare cables in the lid
    expect(count('AQ') - count('')).toBeGreaterThan(5);
    expect(count('AQ BJ') - count('AQ')).toBeGreaterThan(5);
  });
});

describe('the current', () => {
  it('runs on the wheels’ contacts, and returns to the contact the model says', () => {
    const s = { ...DEFAULT_SETTINGS, rotors: ['II', 'IV', 'I'] as [RotorName, RotorName, RotorName], rings: 'AAAV', start: 'VJNA', plugs: 'AT BL' }, e = new Enigma(s);
    for (const ch of 'NCZWVUSXPNYM') {
      const t = e.press(ch), { forward, back } = pathPoints(t);
      expect(forward[0]).toEqual(contactPoint(19, t.entry));
      expect(back[back.length - 1]).toEqual(contactPoint(19, t.exit));
      for (const q of [...forward, ...back.slice(4)]) expect(Math.hypot(q[1] - AX_Y, q[2] - AX_Z)).toBeCloseTo(CONTACT_R);
      expect(enigmaParts(pose(s, { ghost: true, trace: t, lit: t.output, key: ch }), P).filter((p) => p.color === P.forward).length).toBeGreaterThan(9);
    }
  });
  it('a wheel’s turning keeps the wiring on the frame’s numbering: the contact the model names is where the wheel’s contact stands', () => {
    // Wheel contact j of a core at offset o stands at φ = (o − j) · PITCH; in the frame's numbering k = j − o, at φ = −k · PITCH.
    for (let o = 0; o < 26; o++) for (let j = 0; j < 26; j++) {
      const k = (j - o + 26) % 26, q = contactPoint(0, k), phi = Math.atan2(q[2] - AX_Z, q[1] - AX_Y);
      expect(samePhi(phi, (o - j) * PITCH)).toBe(true);
    }
  });
});

describe('labels', () => {
  it('name the wheels in every opened view, and nothing when shut', () => {
    expect(enigmaAnchors(pose(DEFAULT_SETTINGS, { lid: 0, cover: 0, flap: 0 }))).toHaveLength(0);
    const names = enigmaAnchors(pose(DEFAULT_SETTINGS)).map((a) => a.text);
    for (const w of ['Reflector', 'Greek', 'Left', 'Middle', 'Right']) expect(names).toContain(w);
  });
});
