import { afterEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../src/ui/settings';

describe('vivid look setting', () => {
  it('is on by default, with cartoon parts, a dark board and colour per net', () => {
    expect([settings.vivid, settings.cartoon, settings.board, settings.netColors]).toEqual([true, true, true, true]);
    // The vivid look owns that colour per net: switching it off turns it off again.
    settings.setVivid(false);
    expect(settings.netColors).toBe(false);
    settings.setVivid(true);
    expect(settings.netColors).toBe(true);
  });

  it('turns colour per net on with it, and off again only if it turned it on', () => {
    settings.setVivid(false);
    settings.set('netColors', false);
    settings.setVivid(true);
    expect([settings.vivid, settings.netColors, settings.board]).toEqual([true, true, true]);
    settings.setVivid(false);
    expect([settings.vivid, settings.netColors]).toEqual([false, false]);
    // Colour per net set by hand stays as set.
    settings.setVivid(true);
    settings.set('netColors', false);
    settings.set('netColors', true);
    settings.setVivid(false);
    expect(settings.netColors).toBe(true);
    settings.setVivid(true);
  });

  it('cartoon parts can be turned off', () => {
    settings.set('cartoon', false);
    expect(settings.cartoon).toBe(false);
    settings.set('cartoon', true);
    expect(settings.cartoon).toBe(true);
  });
});

describe('settings saved before the vivid default', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  async function loadWith(saved: object) {
    const store: Record<string, string> = { 'mosfet2riscv:v1': JSON.stringify(saved) };
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } });
    vi.resetModules();
    return (await import('../src/ui/settings')).settings;
  }

  it('get the vivid look and cartoon parts once', async () => {
    const s = await loadWith({ vivid: false, cartoon: false, netColors: false, vividNets: false, palette: 'cb' });
    expect([s.vivid, s.cartoon, s.netColors, s.palette]).toEqual([true, true, true, 'cb']);
    s.setVivid(false);
    expect(s.netColors).toBe(false);
  });

  it('keep colour per net set by hand', async () => {
    const s = await loadWith({ vivid: false, netColors: true, vividNets: false });
    s.setVivid(false);
    expect(s.netColors).toBe(true);
  });

  it('turned off after the change, stay off', async () => {
    const s = await loadWith({ vivid: false, cartoon: false, looks: 1 });
    expect([s.vivid, s.cartoon]).toEqual([false, false]);
  });
});
