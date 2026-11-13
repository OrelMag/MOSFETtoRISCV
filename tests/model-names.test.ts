// The 3D models' names switch: what the studio stage shows with names on or off (gl/kit/names.ts), and the setting
// behind it (settings.modelNames: on by default, saved, a damaged value falls back, Reset view brings it back).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { badgeForm, framing, namesShown } from '../src/gl/kit/names';

describe('names on or off', () => {
  it('the canvas box is sized the same with names on or off (the page never moves); off, the model takes the gutters', () => {
    for (const w of [390, 520, 1200]) {
      const on = framing(true, w, 140, 6, 260), off = framing(false, w, 140, 6, 260);
      expect(off.size).toBe(on.size);
      expect(off.form).toBe(on.form);
      expect(off.fit).toBe(0);
      expect(on.fit).toBe(on.size);
    }
    expect(framing(true, 1200, 140, 6, 260).fit).toBe(140);
  });
  it('badges only with names on and below the measured minimum', () => {
    for (const w of [300, 560, 1200]) expect(framing(false, w, 140, 6, 260).badges).toBe(false);
    expect(badgeForm(520, 140, 6, 260)).toBe(true); // 520 - 280 < 260
    expect(framing(true, 520, 140, 6, 260).badges).toBe(true);
    expect(badgeForm(1200, 140, 6, 260)).toBe(false);
    expect(badgeForm(1200, 140, 0, 260)).toBe(true); // nothing to flank with
  });
  it('a beat that sets labels does not bring names back while the switch is off', () => {
    expect(namesShown(true, undefined)).toBe(true);
    expect(namesShown(true, true)).toBe(true);
    expect(namesShown(true, false)).toBe(false);
    expect(namesShown(false, true)).toBe(false);
    expect(namesShown(false, undefined)).toBe(false);
  });
});

describe('settings.modelNames', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  async function load(raw?: unknown) {
    const store: Record<string, string> = raw === undefined ? {} : { 'mosfet2riscv:v1': JSON.stringify(raw) };
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } });
    vi.resetModules();
    return { settings: (await import('../src/ui/settings')).settings, store };
  }
  it('on by default, saved when turned off, read back off', async () => {
    const a = await load();
    expect(a.settings.modelNames).toBe(true);
    a.settings.set('modelNames', false);
    const saved = JSON.parse(a.store['mosfet2riscv:v1']);
    expect(saved.modelNames).toBe(false);
    const b = await load(saved);
    expect(b.settings.modelNames).toBe(false);
  });
  it('a damaged value falls back to on', async () => {
    expect((await load({ modelNames: 'no' })).settings.modelNames).toBe(true);
  });
  it('Reset view brings names back', async () => {
    const { settings } = await load({ modelNames: false });
    settings.resetView();
    expect(settings.modelNames).toBe(true);
  });
});
