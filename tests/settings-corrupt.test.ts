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
