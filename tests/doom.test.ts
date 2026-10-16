// Doom (public/doom/doom.img, ports/doom/) on the Doom computer: it boots to the title screen on the
// fast interpreter, and its first instructions run identically on the golden model. The WAD is
// Freedoom, fetched once into .cache/doom/ (scripts/doom/fetch-wad.mjs: pinned URL and sha256).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseImage } from '../src/doom/image';
import { DoomDevices, FastDoom, GoldenDoom, SCREEN_H, SCREEN_W } from '../src/doom/machine';

const root = new URL('../', import.meta.url);
/** Long loops give the event loop a turn now and then, so the test worker can report to vitest. */
const breathe = () => new Promise<void>((r) => setImmediate(r));
const wadPath = new URL('.cache/doom/freedoom1.wad', root);

function load() {
  if (!existsSync(wadPath)) execFileSync(process.execPath, [new URL('scripts/doom/fetch-wad.mjs', root).pathname.replace(/^\/([A-Za-z]:)/, '$1')], { stdio: 'inherit' });
  return { image: parseImage(readFileSync(new URL('public/doom/doom.img', root))), wad: new Uint8Array(readFileSync(wadPath)) };
}

describe('Doom on the Doom computer', () => {
  it('boots to the title screen on the fast interpreter', async () => {
    const { image, wad } = load();
    const dev = new DoomDevices(wad), cpu = new FastDoom(image, dev);
    const at: number[] = [];
    dev.onFlip = () => at.push(cpu.retired);
    while (dev.flips < 4 && cpu.retired < 2e9 && !cpu.halted) { cpu.run(1_000_000); await breathe(); }
    expect(cpu.console).not.toMatch(/trap|Error/i);
    expect(cpu.halted).toBe(false);
    expect(dev.flips).toBe(4);
    expect(cpu.console).toMatch(/W_Init/);
    // a picture, not a blank screen: many colours in use
    const colours = new Set(dev.shown);
    expect(colours.size).toBeGreaterThan(16);
    expect(dev.shown.length).toBe(SCREEN_W * SCREEN_H);
  }, 600_000);

  it('runs its first instructions identically on the golden model', async () => {
    const { image, wad } = load();
    const g = new GoldenDoom(image, new DoomDevices(wad)), f = new FastDoom(image, new DoomDevices(wad));
    const N = 1_500_000;
    for (let s = 0; s < N; s++) {
      if (s % 50_000 === 0) await breathe();
      const info = g.step();
      f.step();
      if (f.pc !== g.pc || f.mtime !== g.mtime) throw new Error(`step ${s} at 0x${info.pc.toString(16)} ${info.text}: pc / mtime differ`);
      for (let r = 1; r < 32; r++) if (f.x[r] !== g.x[r]) throw new Error(`step ${s} at 0x${info.pc.toString(16)} ${info.text}: x${r} 0x${f.x[r].toString(16)} ≠ 0x${g.x[r].toString(16)}`);
      if (info.store) {
        const i = (info.store.addr >>> 2) & (g.dmem.length - 1);
        if (f.dmem[i] !== g.dmem[i]) throw new Error(`step ${s}: store to 0x${info.store.addr.toString(16)} differs`);
      }
      if (g.halted) break;
    }
    expect(f.console).toBe(g.console);
    expect(f.dmem).toEqual(g.dmem);
    expect(f.dev.fb).toEqual(g.dev.fb);
  }, 600_000);
});
