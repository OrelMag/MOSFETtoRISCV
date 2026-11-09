// A behavioural fingerprint of the out-of-order model: every cycle's CycleInfo (what committed, issued on which port,
// dispatched, was fetched where it went next, was flushed, where the empty slots went) and the final stats, hashed,
// for a grid of configurations over the chapter's programs and the benchmarks. tests/ooo-fingerprint.test.ts pins
// them (tests/ooo-fingerprints.json, taken before the spec mode existed), so nothing outside spec mode can move.
// `npx vite-node tests/ooofingerprint.ts --write` rewrites the file.

import { writeFileSync } from 'node:fs';
import { assemble } from '../src/riscv/asm';
import { BENCHMARKS } from '../src/riscv/benchprograms';
import { OooModel, type CycleInfo, type OooConfig } from '../src/riscv/ooomodel';
import { OOO_PROGRAMS } from '../src/riscv/oooprograms';

export const FP_CONFIGS: Record<string, Partial<OooConfig>> = {
  core: {},
  w1: { width: 1 },
  w4: { width: 4, rob: 32, iq: 16 },
  inorder: { inorder: true },
  resolve: { recover: 'resolve' },
  btb: { predict: 'btb' },
  perfect: { predict: 'perfect' },
  small: { rob: 8, iq: 4, sq: 2 },
  lab: { fetch: 4, commit: 2, ports: [['alu', 'branch', 'mem'], ['alu', 'mul', 'div'], ['alu', 'mem']], divider: 'pipelined' },
};

export const FP_PROGRAMS: { id: string; source: string }[] = [
  ...OOO_PROGRAMS.map((p) => ({ id: p.id, source: p.source })),
  ...BENCHMARKS.filter((b) => !b.needs?.f).map((b) => ({ id: 'bench:' + b.id, source: b.source })),
];

const OPTS = { dmemWords: 1 << 12, imemWords: 1 << 12 };

function fnv(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h;
}

const ids = (us: { seq: number }[]) => us.map((u) => u.seq).join(',');

function cycleText(c: CycleInfo): string {
  return [c.cycle, ids(c.committed), c.issued.map((u) => `${u.seq}@${u.port}:${u.x}`).join(','), ids(c.dispatched),
    c.fetched.map((u) => `${u.seq}:${u.pc}>${u.pnext}${u.wrong ? 'w' : ''}`).join(','), ids(c.flushed), c.lost ?? '-'].join('|');
}

/** One program on one configuration: the hash of every cycle and the stats. */
export function fingerprintRun(source: string, cfg: Partial<OooConfig>, max = 400_000): string {
  const m = new OooModel(assemble(source).words, cfg, OPTS);
  let h = 0x811c9dc5;
  while (!m.halted && m.cycle < max) h = fnv(h, cycleText(m.step()));
  h = fnv(h, JSON.stringify(m.stats));
  return `${(h >>> 0).toString(16).padStart(8, '0')} ${m.stats.cycles}`;
}

export function oooFingerprints(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, cfg] of Object.entries(FP_CONFIGS)) for (const p of FP_PROGRAMS) out[`${name}/${p.id}`] = fingerprintRun(p.source, cfg);
  return out;
}

if (process.argv.includes('--write')) {
  writeFileSync(new URL('./ooo-fingerprints.json', import.meta.url), JSON.stringify(oooFingerprints(), null, 1) + '\n');
  console.log('wrote tests/ooo-fingerprints.json');
}
