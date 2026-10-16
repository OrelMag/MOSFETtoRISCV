// DoomPlayer: pacing to the nominal clock, the sampled profile, exact stops and Back.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseImage, type DoomSymbol } from '../src/doom/image';
import { doomKey, DOOM_KEY } from '../src/doom/keys';
import { CLOCK_KHZ, FB_BASE, SCREEN_W, SCREEN_H } from '../src/doom/machine';
import { DoomPlayer } from '../src/doom/player';

const root = new URL('../', import.meta.url);
const wadPath = new URL('.cache/doom/freedoom1.wad', root);

function player(): DoomPlayer {
  if (!existsSync(wadPath)) execFileSync(process.execPath, [new URL('scripts/doom/fetch-wad.mjs', root).pathname.replace(/^\/([A-Za-z]:)/, '$1')], { stdio: 'inherit' });
  const image = parseImage(readFileSync(new URL('public/doom/doom.img', root)));
  const syms = JSON.parse(readFileSync(new URL('public/doom/doom.syms.json', root), 'utf8')) as DoomSymbol[];
  return new DoomPlayer(image, new Uint8Array(readFileSync(wadPath)), syms);
}

/** Run until `flips` frames are shown (ignoring the wall clock). */
function boot(p: DoomPlayer, flips: number): void {
  while (p.dev.flips < flips) p.advance(100, 1e9, 0);
}

describe('DoomPlayer', () => {
  it('maps keys by physical code', () => {
    expect(doomKey('ArrowUp')).toBe(DOOM_KEY.UP);
    expect(doomKey('ControlLeft')).toBe(DOOM_KEY.FIRE);
    expect(doomKey('KeyY')).toBe('y'.charCodeAt(0));
    expect(doomKey('Digit3')).toBe('3'.charCodeAt(0));
    expect(doomKey('F12')).toBe(0x80 + 0x58);
    expect(doomKey('MetaLeft')).toBeNull();
  });

  it('runs to the wall clock at the nominal rate and samples a profile', () => {
    const p = player();
    boot(p, 2);
    const c0 = p.cycles;
    for (let k = 0; k < 20; k++) p.advance(50, 1e9, 1000 * (k + 1));
    // 20 × 50 ms at the nominal clock, plus the tail of single steps (≤ 64 cycles each call, or a divide)
    const ran = p.cycles - c0;
    expect(ran).toBeGreaterThanOrEqual(20 * 50 * CLOCK_KHZ);
    expect(ran).toBeLessThan(20 * 50 * CLOCK_KHZ + 20 * 64 * 34 + 20 * 4096 * 34);
    expect(p.profile.length).toBeGreaterThan(3);
    expect(p.profile[0].share).toBeGreaterThan(0);
    expect(p.mix.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(p.recent().length).toBe(64);
    expect(p.where()?.name).toBeTruthy();
  }, 120_000);

  it('steps to the next pixel and back, exactly', () => {
    const p = player();
    boot(p, 3);
    p.pause();
    const pc0 = p.cpu.pc, x0 = p.cpu.x.slice(), mem0 = p.cpu.dmem.slice(), fb0 = p.dev.fb.slice();
    p.toNextPixel();
    // the last instruction was a store into the picture: some pixel changed or was rewritten
    expect(p.cpu.pc).not.toBe(pc0);
    for (let k = 0; k < 10; k++) p.step();
    expect(p.back()).toBe(true);
    for (let k = 0; k < 9; k++) p.back();
    expect(p.back()).toBe(true); // the toNextPixel snapshot
    expect(p.cpu.pc).toBe(pc0);
    expect(p.cpu.x).toEqual(x0);
    expect(p.cpu.dmem).toEqual(mem0);
    expect(p.dev.fb).toEqual(fb0);
  }, 120_000);

  it('a single step that stores is undone word for word', () => {
    const p = player();
    boot(p, 2);
    p.pause();
    // step until a store into RAM or the frame buffer has happened, then undo every step
    const mem0 = p.cpu.dmem.slice(), fb0 = p.dev.fb.slice(), x0 = p.cpu.x.slice(), pc0 = p.cpu.pc, mt0 = p.cpu.mtime;
    for (let k = 0; k < 200; k++) p.step();
    expect(p.cpu.dmem).not.toEqual(mem0);
    while (p.back());
    expect([p.cpu.pc, p.cpu.mtime]).toEqual([pc0, mt0]);
    expect(p.cpu.x).toEqual(x0);
    expect(p.cpu.dmem).toEqual(mem0);
    expect(p.dev.fb).toEqual(fb0);
  }, 120_000);

  it('runs to the end of the frame: the next FLIP, exactly', () => {
    const p = player();
    boot(p, 3);
    p.pause();
    const f0 = p.dev.flips;
    p.toFrameEnd();
    expect(p.dev.flips).toBe(f0 + 1);
    // the instruction before the PC was the FLIP store (sw to 0x8000_001C)
    expect(p.dev.shown.length).toBe(SCREEN_W * SCREEN_H);
    expect(FB_BASE).toBe(0xc0000000);
  }, 120_000);
});
