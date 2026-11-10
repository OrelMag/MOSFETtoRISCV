// The AGC golden model (src/agc/iss.ts) against yaAGC in lock step: every program is assembled, run on the model to its
// halt, written as a rope image, run on yaAGC through scripts/agc/harness.c for the same number of instructions, and
// compared after every instruction: Z, A, L, Q, EB, FB, BB, the extracode flag, the index, every erasable word, and the
// memory cycles the instruction took. CI only (.github/workflows/agc-oracle.yml builds the harness from a pinned
// Virtual AGC revision); the model's own tests run everywhere (tests/agc-iss.test.ts).
//
//   vite-node scripts/agc/oracle.ts -- --harness <path> [--seeds a..b] [--length n] [--out dir]
//   vite-node scripts/agc/oracle.ts -- --self        the comparison against the model itself (no harness): plumbing check

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleAgc, ropeBin, type AgcProgram } from '../../src/agc/asm';
import { AgcISS, REG } from '../../src/agc/iss';
import { randomAgcProgram } from '../../src/agc/randprog';
import { DIRECTED } from './directed';

interface Snap { cycles: number; z: number; a: number; l: number; q: number; eb: number; fb: number; bb: number; ext: number; idx: number; mem: Map<number, number> }

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const harness = arg('--harness');
const self = args.includes('--self');
const [from, to] = (arg('--seeds') ?? '1..200').split('..').map(Number);
const length = Number(arg('--length') ?? 120);
const outDir = arg('--out') ?? 'agc-oracle-out';
if (!harness && !self) { console.error('give --harness <path> or --self'); process.exit(2); }

const oct = (n: number) => n.toString(8);

/** The model's state after each instruction, as the harness prints it (erasable diffs, the registers apart). */
function runModel(p: AgcProgram, max = 200_000): { snaps: Snap[]; steps: { name: string; z: number; word: number; branched?: boolean }[] } {
  const m = new AgcISS(p.fixed);
  const prev = m.e.slice();
  const snaps: Snap[] = [], steps: { name: string; z: number; word: number; branched?: boolean }[] = [];
  for (let n = 0; n < max; n++) {
    const z0 = m.z;
    const s = m.step();
    steps.push(s);
    const mem = new Map<number, number>();
    for (let i = 0o10; i < m.e.length; i++) if (m.e[i] !== prev[i]) { mem.set(i, m.e[i]); prev[i] = m.e[i]; }
    snaps.push({ cycles: s.mct, z: m.z, a: m.a, l: m.l, q: m.q, eb: m.e[REG.EB], fb: m.e[REG.FB], bb: m.e[REG.BB], ext: m.extra ? 1 : 0, idx: m.index, mem });
    if ((s.name === 'TCF' || s.name === 'TC') && m.z === z0) return { snaps, steps };
  }
  throw new Error(`no halt within ${max} instructions`);
}

function parse(out: string): Snap[] {
  return out.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const t = line.split(' ');
    if (t[0] !== 'S') throw new Error(`harness: ${line}`);
    const n = t.slice(1, 11).map(x => parseInt(x, 8));
    const mem = new Map<number, number>();
    for (const kv of t.slice(11)) { const [a, v] = kv.split('='); mem.set(parseInt(a, 8), parseInt(v, 8)); }
    return { cycles: n[0], z: n[1], a: n[2], l: n[3], q: n[4], eb: n[5], fb: n[6], bb: n[7], ext: n[8], idx: n[9], mem };
  });
}

const FIELDS = ['z', 'a', 'l', 'q', 'eb', 'fb', 'bb', 'ext', 'idx'] as const;

/** The first difference, or null. A BZF / BZMF that does not branch is 2 MCT in the model and 1 in yaAGC. */
function compare(model: Snap[], steps: { name: string; branched?: boolean }[], oracle: Snap[], memModel: Map<number, number>, memOracle: Map<number, number>): string | null {
  if (oracle.length < model.length) return `yaAGC printed ${oracle.length} instructions, the model ran ${model.length}`;
  for (let i = 0; i < model.length; i++) {
    const m = model[i], o = oracle[i], s = steps[i];
    const diffs: string[] = [];
    for (const f of FIELDS) if (m[f] !== o[f]) diffs.push(`${f} model ${oct(m[f])} yaAGC ${oct(o[f])}`);
    const expectCycles = !self && (s.name === 'BZF' || s.name === 'BZMF') && s.branched === false ? 1 : m.cycles;
    if (expectCycles !== o.cycles) diffs.push(`MCT model ${m.cycles} yaAGC ${o.cycles}`);
    for (const [a, v] of m.mem) memModel.set(a, v);
    for (const [a, v] of o.mem) memOracle.set(a, v);
    const addrs = new Set([...m.mem.keys(), ...o.mem.keys()]);
    for (const a of addrs) if ((memModel.get(a) ?? 0) !== (memOracle.get(a) ?? 0)) diffs.push(`[${oct(a)}] model ${oct(memModel.get(a) ?? 0)} yaAGC ${oct(memOracle.get(a) ?? 0)}`);
    if (diffs.length) return `instruction ${i + 1}: ${diffs.join('; ')}`;
  }
  return null;
}

function check(name: string, src: string): boolean {
  let p: AgcProgram;
  try { p = assembleAgc(src); } catch (e) { console.log(`FAIL ${name}: assembler: ${(e as Error).message}`); return false; }
  const { snaps, steps } = runModel(p);
  let oracle: Snap[];
  if (self) oracle = snaps;
  else {
    mkdirSync(outDir, { recursive: true });
    const bin = join(outDir, `${name}.bin`);
    writeFileSync(bin, ropeBin(p.fixed));
    oracle = parse(execFileSync(harness!, [bin, String(snaps.length)], { encoding: 'utf8', maxBuffer: 1 << 28 }));
  }
  const why = compare(snaps, steps, oracle, new Map(), new Map());
  if (!why) return true;
  mkdirSync(outDir, { recursive: true });
  const n = Number(/instruction (\d+)/.exec(why)?.[1] ?? 0);
  const trail = steps.slice(Math.max(0, n - 8), n).map((s, j) => {
    const at = p.listing.find(l => l.addr === s.z && l.bank === (s.z >= 0o6000 ? 3 : 2));
    return `  ${String(Math.max(0, n - 8) + j + 1).padStart(5)}  ${oct(s.z).padStart(4, '0')}  ${oct(s.word).padStart(5, '0')}  ${s.name.padEnd(7)} ${at?.text ?? ''}`;
  }).join('\n');
  console.log(`FAIL ${name}: ${why}\n${trail}`);
  writeFileSync(join(outDir, `${name}.agc`), src);
  return false;
}

let fails = 0, count = 0;
for (const [name, src] of Object.entries(DIRECTED)) { count++; if (!check(name, src)) fails++; }
for (let seed = from; seed <= to; seed++) { count++; if (!check(`seed${seed}`, randomAgcProgram(seed, { length }))) fails++; }
console.log(`${count - fails} of ${count} programs in lock step${self ? ' (self check)' : ' with yaAGC'}`);
process.exit(fails ? 1 : 0);
