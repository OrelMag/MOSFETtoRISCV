// The Enigma on the studio renderer: every part drawn in a finish (instance sets by material), the see-through ones merged
// into glass, and the light of the current following the trace's own contacts in order (key, wheels in, reflector, wheels
// back, lamp), so the readout's letters light as the light reaches each.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, Enigma, type EnigmaSettings } from '../src/crypto/enigma';
import type { RGB } from '../src/gl/instances';
import { INSTANCE_FLOATS } from '../src/gl/instances';
import { pathPoints, type EnigmaPalette, type EnigmaPose } from '../src/widgets/enigma3dparts';
import { enigmaParts } from '../src/widgets/enigma3dmachine';
import { currentRuns } from '../src/widgets/enigma3dextras';
import { beamItems, beamPath, FINISH, finishOf, flatItems, glassItems, partSets, SET_KEYS, stageLengths, upTo } from '../src/widgets/enigma3dstudio';

const c = (i: number): RGB => [i / 24, 0.4, 0.6];
const P: EnigmaPalette = {
  wood: c(1), woodDark: c(2), black: c(3), panel: c(4), zinc: c(5), steel: c(6), brass: c(7), bakelite: c(8), ivory: c(9), red: c(10), paper: c(11),
  glass: c(12), lampOn: c(13), lampLetter: c(14), forward: c(15), back: c(16), cable: c(17), cotton: c(18), loom: c(19), wireKey: c(20), wireLamp: c(21),
};
const pose = (s: EnigmaSettings, o: Partial<EnigmaPose> = {}): EnigmaPose => {
  const e = new Enigma(s);
  return { settings: s, pos: e.pos, lid: 1, cover: 0, flap: 0, lamps: 0, out: 0, bare: false, inside: false, box: false, printer: false, tape: '', ghost: false, key: null, lit: null, stroke: 0, pawls: e.pawls(), trace: null, ...o };
};
const alpha = (col: readonly number[]) => col[3] ?? 1;

describe('the finishes', () => {
  it('every palette colour has a finish, and a part of that colour finds it', () => {
    for (const k of Object.keys(P) as (keyof EnigmaPalette)[]) {
      expect(FINISH[k], k).toBeDefined();
      expect(finishOf(P[k], P)).toBe(k);
    }
    expect(finishOf([0.123, 0.456, 0.789], P)).toBeNull();
  });
  it('a finish carries the material, the part its colour: the finishes are white, so instance colour × base = the part', () => {
    for (const m of Object.values(FINISH)) expect(m!.base).toEqual([1, 1, 1]);
  });
});

describe('the parts as instance sets', () => {
  const views: Partial<EnigmaPose>[] = [{}, { cover: 1, flap: 1 }, { cover: 1, lamps: 1 }, { ghost: true, inside: true, bare: true, cover: 1, flap: 1 }];
  it('every opaque part is drawn exactly once, in the set of its finish; the see-through ones go to the glass', () => {
    for (const o of views) {
      const parts = enigmaParts(pose(DEFAULT_SETTINGS, o), P), { sets } = partSets(parts, P);
      const opaque = parts.filter((p) => alpha(p.color) >= 1);
      expect(sets.map((s) => s.key)).toEqual(SET_KEYS);
      expect(sets.reduce((n, s) => n + s.data.length / INSTANCE_FLOATS, 0)).toBe(opaque.length);
      // each record is the part: its position, scale and colour
      for (const s of sets) for (let i = 0; i < s.data.length / INSTANCE_FLOATS; i++) {
        const o0 = i * INSTANCE_FLOATS, col = [s.data[o0 + 10], s.data[o0 + 11], s.data[o0 + 12]];
        const f = s.key.split(':')[2];
        if (!f.startsWith('plain')) expect(finishOf(col, P)).toBe(f);
        expect(s.data[o0 + 13]).toBe(1);
      }
    }
  });
  it('the glass: one item per opacity, a colour per vertex, and the same object while nothing moved', () => {
    const parts = enigmaParts(pose(DEFAULT_SETTINGS, { ghost: true, inside: true, bare: true, cover: 1, flap: 1 }), P);
    const see = parts.filter((p) => alpha(p.color) < 1), opacities = new Set(see.map((p) => Math.round(alpha(p.color) * 100) / 100));
    expect(see.length).toBeGreaterThan(0);
    const g = glassItems(parts);
    expect(g).toHaveLength(opacities.size);
    for (const it of g) expect(it.geo.colors!.length).toBe(it.geo.positions.length);
    expect(glassItems(parts)).toBe(g);
  });
  it('the flat drawing gets every part as an item of its own colour', () => {
    const parts = enigmaParts(pose(DEFAULT_SETTINGS), P), items = flatItems(parts);
    expect(items).toHaveLength(parts.length);
    items.forEach((it, i) => expect(it.mat.base).toEqual(parts[i].color.slice(0, 3)));
  });
});

describe('the light of the current', () => {
  const cases = (): { s: EnigmaSettings; ch: string }[] => {
    const out: { s: EnigmaSettings; ch: string }[] = [];
    for (const start of ['AAAA', 'ZQEV', 'BDLX']) for (const ch of 'AQZMP') out.push({ s: { ...DEFAULT_SETTINGS, start }, ch });
    return out;
  };
  it('runs the trace’s own contacts in order: each stage further along than the last, the lamp at the end', () => {
    for (const { s, ch } of cases()) {
      const m = new Enigma(s), t = m.trace(ch), b = beamPath(currentRuns(t, s.plugs)), marks = stageLengths(t, b);
      expect(marks).toHaveLength(3 + t.out.length + t.ret.length); // entry, wheels in, reflector, wheels back, exit
      for (let i = 1; i < marks.length; i++) expect(marks[i], `${s.start} ${ch} stage ${i}`).toBeGreaterThan(marks[i - 1]);
      expect(marks[marks.length - 1]).toBeLessThanOrEqual(b.at[b.at.length - 1] + 1e-6);
      // the contacts lie on the path: each stage's contact is within a wire's width of it
      const pp = pathPoints(t), contacts = [pp.forward[0], ...t.out.map((_, i) => pp.forward[2 + 2 * i]), pp.back[3], ...t.ret.map((_, i) => pp.back[5 + 2 * i])];
      for (const q of contacts) expect(Math.min(...b.pts.map((p) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])))).toBeLessThan(1e-6);
    }
  });
  it('the way in and the way back meet at the reflector, and lengths only grow', () => {
    const t = new Enigma(DEFAULT_SETTINGS).trace('A'), b = beamPath(currentRuns(t, DEFAULT_SETTINGS.plugs));
    expect(b.split).toBeGreaterThan(1);
    expect(b.split).toBeLessThan(b.pts.length);
    for (let i = 1; i < b.at.length; i++) expect(b.at[i]).toBeGreaterThan(b.at[i - 1]);
  });
  it('drawn so far: nothing at the start, the way in then the way back, a head while it travels', () => {
    const t = new Enigma(DEFAULT_SETTINGS).trace('A'), b = beamPath(currentRuns(t, DEFAULT_SETTINGS.plugs)), end = b.at[b.at.length - 1];
    expect(upTo(b, 0)).toHaveLength(1);
    expect(upTo(b, end)).toHaveLength(b.pts.length);
    const mid = upTo(b, end / 2), last = mid[mid.length - 1];
    expect(last.every(Number.isFinite)).toBe(true);
    expect(beamItems(b, 0, '--f', '--b')).toHaveLength(1); // the head alone
    expect(beamItems(b, b.at[b.split - 1] * 0.5, '--f', '--b')).toHaveLength(2); // going in, and the head
    expect(beamItems(b, end, '--f', '--b')).toHaveLength(2); // both ways, no head once arrived
  });
});
