// Open blocks as you zoom and Opened blocks without colour are on by default (the author, 2026-11-13), desktop and touch.
// A stored false is a choice and is kept, except lensPlain's: its old default false was saved for every visitor, so a false
// without the lensV marker is read as unset once (settings.ts load); a backup restored from before behaves like old storage,
// and the backup merge (local preferences kept) moves the marker only with the lensPlain it vouches for.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapKV, mergeBackup, mergeSettings } from '../src/ui/backup';

const KEY = 'mosfet2riscv:v1';

async function boot(raw?: Record<string, unknown>) {
  const store: Record<string, string> = raw ? { [KEY]: JSON.stringify(raw) } : {};
  vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } });
  vi.resetModules();
  const { settings } = await import('../src/ui/settings');
  return { settings, store };
}

describe('the lens on by default', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('a reader who never chose (no storage) gets both on', async () => {
    const { settings } = await boot();
    expect(settings.zoomOpen).toBe(true);
    expect(settings.lensPlain).toBe(true);
  });
  it('a touch screen too', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('coarse'), media: q, addEventListener() {}, removeEventListener() {} }));
    const { settings } = await boot({ looks: 1 });
    expect(settings.zoomOpen).toBe(true);
    expect(settings.lensPlain).toBe(true);
  });
  it('storage from before the release (zoomOpen null, lensPlain false saved by default): both on, once', async () => {
    const { settings, store } = await boot({ looks: 1, zoomOpen: null, lensPlain: false });
    expect(settings.zoomOpen).toBe(true);
    expect(settings.lensPlain).toBe(true);
    // the next save carries the marker, so the migration does not run again
    settings.set('lensPlain', false);
    expect(JSON.parse(store[KEY]).lensV).toBe(1);
    const again = await boot(JSON.parse(store[KEY]));
    expect(again.settings.lensPlain).toBe(false);
  });
  it('a zoomOpen false chosen before the release is kept (its default was never saved as false)', async () => {
    const { settings } = await boot({ looks: 1, zoomOpen: false, lensPlain: false });
    expect(settings.zoomOpen).toBe(false);
  });
  it('an old stored lensPlain true stays on', async () => {
    const { settings } = await boot({ looks: 1, lensPlain: true });
    expect(settings.lensPlain).toBe(true);
  });
  it('false chosen after the release is kept, for both', async () => {
    const { settings } = await boot({ looks: 1, lensV: 1, zoomOpen: false, lensPlain: false });
    expect(settings.zoomOpen).toBe(false);
    expect(settings.lensPlain).toBe(false);
  });
  it('Reset view options puts both back on', async () => {
    const { settings } = await boot({ looks: 1, lensV: 1, zoomOpen: false, lensPlain: false });
    settings.resetView();
    expect(settings.zoomOpen).toBe(true);
    expect(settings.lensPlain).toBe(true);
  });
});

describe('backups and the lens default', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  const file = (settings: Record<string, unknown>) => ({ format: 'mosfet2riscv-backup', schema: 1, keys: { [KEY]: JSON.stringify(settings) } }) as never;

  it('a backup from before the release restored into empty storage behaves like old storage: on', async () => {
    const kv = new MapKV();
    const r = mergeBackup(file({ looks: 1, lensPlain: false, zoomOpen: null, visited: {} }), kv);
    const { settings } = await boot(JSON.parse(r.writes[KEY]));
    expect(settings.lensPlain).toBe(true);
    expect(settings.zoomOpen).toBe(true);
  });
  it('local preferences kept: an old backup never turns a choice made since back into an unset one', async () => {
    const out = mergeSettings({ lensPlain: false, lensV: 1 }, { lensPlain: false });
    const { settings } = await boot(out);
    expect(settings.lensPlain).toBe(false);
  });
  it('old local storage merged with a newer backup keeps the migration: the marker never lands alone on an old false', async () => {
    const out = mergeSettings({ lensPlain: false }, { lensPlain: false, lensV: 1 });
    expect(out.lensV).toBeUndefined();
    const { settings } = await boot(out);
    expect(settings.lensPlain).toBe(true);
  });
  it('empty local settings take the file whole, marker and all', () => {
    expect(mergeSettings({}, { lensPlain: false, lensV: 1 })).toMatchObject({ lensPlain: false, lensV: 1 });
  });
});
