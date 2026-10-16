// Doom on the fast interpreter, measured: cycles to each FLIP (mtime is current inside run(), the
// retired count only between runs), MIPS, and the time a frame takes at the nominal clock.
// Run: node node_modules/vite-node/vite-node.mjs scripts/doom/bench.ts [frames] (the demo starts near frame 360)
//   Needs public/doom/doom.img and .cache/doom/freedoom1.wad (scripts/doom/fetch-wad.mjs).

import { readFileSync } from 'node:fs';
import { parseImage } from '../../src/doom/image';
import { CLOCK_KHZ, DoomDevices, FastDoom } from '../../src/doom/machine';

const frames = Number(process.argv[2] ?? 40);
const image = parseImage(readFileSync('public/doom/doom.img'));
const dev = new DoomDevices(new Uint8Array(readFileSync('.cache/doom/freedoom1.wad')));
const cpu = new FastDoom(image, dev);
const marks: number[] = [];
let cycles = 0, lastMt = 0;
const now = () => { cycles += (cpu.mtime - lastMt) >>> 0; lastMt = cpu.mtime; return cycles; };
dev.onFlip = () => { marks.push(now()); };
const t0 = performance.now();
while (dev.flips < frames && !cpu.halted) {
  cpu.run(200_000);
  now();
}
const s = (performance.now() - t0) / 1000;
console.log(cpu.console.trim().split('\n').slice(-6).join('\n'));
console.log(`\n${cpu.retired.toLocaleString()} instructions in ${s.toFixed(1)} s: ${(cpu.retired / s / 1e6).toFixed(1)} MIPS`);
if (marks.length) console.log(`first frame after ${marks[0].toLocaleString()} cycles`);
const per = marks.slice(1).map((m, i) => m - marks[i]);
const show = (name: string, xs: number[]) => {
  if (!xs.length) return;
  const v = xs.slice().sort((a, b) => a - b), med = v[v.length >> 1];
  console.log(`${name}: ${xs.length} frames, cycles min ${v[0].toLocaleString()}, median ${med.toLocaleString()}, max ${v[v.length - 1].toLocaleString()}; median ${(med / CLOCK_KHZ).toFixed(1)} ms at ${CLOCK_KHZ / 1000} MHz`);
};
show('all', per);
show('from frame 400 (the demo)', per.slice(400));
