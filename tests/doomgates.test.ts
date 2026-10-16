// The gate window: Doom's state on the fast interpreter, handed to the gate-level Doom computer
// (lib/doompc.ts) mid-game, runs on: every retired instruction equal (PC, registers), and after the
// window the RAM and the frame buffer equal word for word.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseImage } from '../src/doom/image';
import { DoomDevices, FastDoom } from '../src/doom/machine';
import { doomDesign, loadGates, memoryDiff, runWindow } from '../src/doom/gates';
import { GateSim } from '../src/sim/gatesim';

const root = new URL('../', import.meta.url);
const wadPath = new URL('.cache/doom/freedoom1.wad', root);
const breathe = () => new Promise<void>((r) => setImmediate(r));

function machine(): FastDoom {
  if (!existsSync(wadPath)) execFileSync(process.execPath, [new URL('scripts/doom/fetch-wad.mjs', root).pathname.replace(/^\/([A-Za-z]:)/, '$1')], { stdio: 'inherit' });
  const image = parseImage(readFileSync(new URL('public/doom/doom.img', root)));
  return new FastDoom(image, new DoomDevices(new Uint8Array(readFileSync(wadPath))));
}

describe('the gate window', () => {
  it('takes over Doom at the title screen and runs 2 000 cycles exactly as the interpreter', async () => {
    const cpu = machine();
    while (cpu.dev.flips < 3) { cpu.run(1_000_000); await breathe(); }
    // a few more instructions, so the hand-over is in the middle of the frame, not at the FLIP
    cpu.run(12_345);
    const sim = new GateSim(doomDesign(cpu));
    loadGates(sim, cpu);
    const r = runWindow(sim, cpu, 2000);
    expect(r.mismatch).toBeUndefined();
    expect(r.retired).toBeGreaterThan(1000);
    expect(memoryDiff(sim, cpu)).toBeNull();
  }, 600_000);
});
