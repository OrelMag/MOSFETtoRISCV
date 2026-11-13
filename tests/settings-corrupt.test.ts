import { afterEach, describe, expect, it, vi } from 'vitest';
import { STEP_MOVES } from '../src/chapters/stepmoves';

// A stored settings blob with a field of the wrong type (a damaged or hand-edited backup) must not stop the site
// from loading: each bad field falls back to its default, the good ones stay (release review M2).
describe('settings with corrupt fields', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  async function loadRaw(raw: string) {
    const store: Record<string, string> = { 'mosfet2riscv:v1': raw };
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } });
    vi.resetModules();
    return (await import('../src/ui/settings')).settings;
  }
  const TYPES: Record<string, string> = { theme: 'string', radix: 'string', speed: 'number', traceRate: 'number', textSize: 'number', vivid: 'boolean', overlay: 'string', moveParts: 'boolean', zoomOpen: 'boolean' };
  const ONE_OF: Record<string, unknown[]> = { theme: ['auto', 'light', 'dark'], palette: ['default', 'cb', 'lsim', 'contrast', 'print'], radix: ['hex', 'bin', 'dec', 'sdec'], wireScale: ['thin', 'normal', 'thick'], grid: ['dots', 'lines', 'off'], zoomNames: ['off', 'normal', 'large'], traceLevel: ['gate', 'cycle', 'instr'], textSize: [90, 100, 110, 120, 130] };
  const good = { looks: 1, moved: STEP_MOVES.length, palette: 'cb', visited: { gates: [0, 2] }, solved: { 'gates:1': true } };

  for (const [field, bad] of [
    ['visited', null], ['visited', 'x'], ['visited', [1, 2]], ['visited', { gates: 'x' }], ['visited', { gates: [null, 'a'] }],
    ['solved', null], ['solved', 7], ['coachDone', null], ['openActs', 'x'], ['last', 5], ['last', { chapter: 3 }],
    ['theme', 42], ['palette', 'neon'], ['radix', null], ['speed', 'fast'], ['traceRate', -1], ['textSize', 'big'], ['textSize', 1e9],
    ['wireScale', {}], ['grid', 1], ['zoomNames', true], ['traceLevel', 'x'], ['moveParts', 'yes'], ['zoomOpen', 1],
    ['vivid', 'no'], ['overlay', 3], ['moved', 'x'], ['looks', null],
  ] as [string, unknown][]) {
    it(`${field} = ${JSON.stringify(bad)} loads, the rest kept`, async () => {
      const s = await loadRaw(JSON.stringify({ ...good, [field]: bad }));
      const view = s as unknown as Record<string, unknown>;
      for (const [k, t] of Object.entries(TYPES)) expect(typeof view[k], k).toBe(t);
      for (const [k, vs] of Object.entries(ONE_OF)) expect(vs, k).toContain(view[k]);
      expect(s.palette).toBe(field === 'palette' ? 'default' : 'cb');
      expect(typeof s.theme).toBe('string');
      expect(Number.isFinite(s.speed) && s.speed > 0).toBe(true);
      expect(Number.isFinite(s.textSize)).toBe(true);
      expect(s.visited('gates').includes(0)).toBe(field !== 'visited');
    });
  }

  it('a __proto__ chapter in visited loses only itself', async () => {
    const s = await loadRaw('{"looks":1,"moved":0,"palette":"cb","visited":{"__proto__":[1],"gates":[0]}}');
    expect(s.palette).toBe('cb');
    expect(s.visited('gates').includes(0)).toBe(true);
  });

  it('a blob that is not an object gives the defaults', async () => {
    for (const raw of ['null', '42', '"x"', '[1]']) expect((await loadRaw(raw)).theme).toBe('auto');
  });
});

describe('settings that are not JSON', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  it('are kept aside before the defaults are saved over them', async () => {
    const store: Record<string, string> = { 'mosfet2riscv:v1': '{"visited":{"gates":[0]' };
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } });
    vi.resetModules();
    const s = (await import('../src/ui/settings')).settings;
    expect(s.theme).toBe('auto');
    expect(store['mosfet2riscv:v1:unreadable']).toBe('{"visited":{"gates":[0]');
  });
});

describe('settings with every field set to a valid value other than its default', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  it('load unchanged: the coercion drops nothing a learner can have saved', async () => {
    const saved = {
      theme: 'dark', palette: 'lsim', radix: 'sdec', animate: true, modules: false, wide: true, wireFlow: false, netColors: false, vivid: false, board: false,
      cartoon: false, workingGates: false, vividNets: false, looks: 1, glossary: false, simpleWires: true, autoClock: false, loadDelay: true, singleKeys: false,
      minimap: false, moveParts: true, zoomOpen: false, lensPlain: false, lensV: 1, reduceMotion: true, wireScale: 'thick', grid: 'lines', portNames: false, partNames: false, modelNames: false,
      busValues: false, tapRanges: false, zoomNames: 'large', hideSmall: false, coachDone: { stage: true }, textSize: 120, narrowText: true, analyzer: true,
      speed: 3, traceLevel: 'cycle', traceRate: 7, overlay: 'power', visited: { gates: [0, 3] }, solved: { 'gates:1': true }, openActs: { '9': true },
      last: { chapter: 'gates', step: 3 }, moved: STEP_MOVES.length,
    };
    const store: Record<string, string> = { 'mosfet2riscv:v1': JSON.stringify(saved) };
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } });
    vi.resetModules();
    const { settings } = await import('../src/ui/settings');
    settings.set('speed', 3); // any write saves the whole state
    expect(JSON.parse(store['mosfet2riscv:v1'])).toEqual(saved);
  });
});
