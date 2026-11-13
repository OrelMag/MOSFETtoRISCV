// The 3D models' names switch: what the studio stage shows with names on or off (gl/kit/names.ts), and the setting
// behind it (settings.modelNames: on by default, saved, a damaged value falls back, Reset view brings it back).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { badgeForm, gutterOf, namesShown } from '../src/gl/kit/names';

describe('names on or off', () => {
  it('off: no gutters, the canvas takes their width back', () => {
    expect(gutterOf(true, 132)).toBe(132);
    expect(gutterOf(false, 132)).toBe(0);
  });
  it('off: never the badge form, whatever the width; on: badges only below the measured minimum', () => {
    for (const w of [300, 560, 1200]) expect(badgeForm(false, w, 140, 6, 260)).toBe(false);
    expect(badgeForm(true, 520, 140, 6, 260)).toBe(true); // 520 - 280 < 260
    expect(badgeForm(true, 1200, 140, 6, 260)).toBe(false);
    expect(badgeForm(true, 1200, 140, 0, 260)).toBe(true); // nothing to flank with
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
