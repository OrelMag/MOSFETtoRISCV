// The route cache (src/view/routecache.ts): every registered library level, its levels two deep, and the levels the
// chapters' CPU tops reach, routed once at build time; the ones whose first route takes over THRESHOLD_MS go to
// public/routes/<file>.json with public/routes/index.json naming them. Run by `npm run build`.
//
// Routing all of them takes about a minute on one thread, so the work is split over child processes (each builds the
// same list of levels, in the same order, and routes every Nth): a ComponentDef carries functions and cannot be sent to
// a worker, so each shard makes its own. Ceilings (the build fails past them, naming the levels): CEIL_GZIP_BYTES
// gzipped in all, CEIL_FILE_BYTES a file, and on CI CEIL_CI_MS of wall time.
//   node node_modules/vite-node/vite-node.mjs scripts/lens-routes.ts [--jobs n] [--threshold ms]
import '../src/lib';
import { registry } from '../src/lib/define';
import { reachableDefs } from '../src/lib/resolve';
import { singleCycleCpu } from '../src/lib/cpu';
import { pipelinedCpu } from '../src/lib/pipeline';
import { oooCpu } from '../src/lib/ooocore';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { cacheEntry, routeFile, type RouteIndex } from '../src/view/routecache';
import { routeRules } from './routerules';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'public', 'routes');
export const THRESHOLD_MS = 4;
export const CEIL_GZIP_BYTES = 1.5 * 1024 * 1024, CEIL_FILE_BYTES = 200 * 1024, CEIL_CI_MS = 60_000;

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const threshold = Number(arg('--threshold') ?? THRESHOLD_MS);

/** The levels, in a fixed order (every shard must see the same list). */
function levels(): ComponentDef[] {
  const defs = new Map<string, ComponentDef>();
  const add = (d: ComponentDef, depth: number) => {
    if (d.prim || !netlistOf(d)) return;
    if (!defs.has(d.id)) defs.set(d.id, d);
    if (depth > 0) for (const i of netlistOf(d)!.instances) add(i.def, depth - 1);
  };
  // every level a stage can show (as tests/wirefirst.test.ts counts them): the families' levels and every registered part
  for (const d of new Set([...reachableDefs(), ...registry.values()])) add(d, 2);
  const words = assemble(PROGRAMS.find((p) => p.id === 'fib')!.source).words;
  // the CPU tops are per program (their ROM's id), so only what they reach is shared between chapters
  for (const top of [singleCycleCpu(words), pipelinedCpu(words), oooCpu(words, { imemK: 6, dmemK: 6 })])
    for (const i of netlistOf(top)!.instances) add(i.def, 2);
  return [...defs.values()];
}

interface ShardOut { routed: number; ms: number; slow: [string, number][]; failed: string[] }

function shard(k: number, n: number): void {
  const rules = routeRules(ROOT);
  const all = levels();
  const out: ShardOut = { routed: 0, ms: 0, slow: [], failed: [] };
  for (let i = k; i < all.length; i += n) {
    const d = all[i];
    const t = performance.now();
    let e;
    try { e = cacheEntry(d, netlistOf(d)!, rules); } catch { out.failed.push(d.id); continue; }
    const ms = performance.now() - t;
    out.routed++;
    out.ms += ms;
    if (ms <= threshold) continue;
    writeFileSync(join(OUT, routeFile(d.id)), JSON.stringify(e));
    out.slow.push([d.id, e.key]);
  }
  process.stdout.write(`\n@@SHARD ${JSON.stringify(out)}\n`);
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const jobs = Math.max(1, Number(arg('--jobs') ?? process.env.LENS_ROUTE_JOBS ?? Math.min(4, Math.max(1, cpus().length - 1))));
  if (existsSync(OUT)) rmSync(OUT, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const vn = join(ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');
  const runs = Array.from({ length: jobs }, (_, k) => new Promise<ShardOut>((done, fail) => {
    const p = spawn(process.execPath, [vn, fileURLToPath(import.meta.url), '--shard', `${k}/${jobs}`, '--threshold', String(threshold)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    p.stdout.on('data', (b) => (text += b));
    p.on('exit', (code) => {
      const m = /@@SHARD (.*)/.exec(text);
      if (code === 0 && m) done(JSON.parse(m[1]) as ShardOut);
      else fail(new Error(`route shard ${k}/${jobs} failed (exit ${code})`));
    });
  }));
  const outs = await Promise.all(runs);
  const index: RouteIndex = { rules: routeRules(ROOT), levels: {} };
  for (const o of outs) for (const [id, key] of o.slow) index.levels[id] = key;
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));
  let raw = 0, gz = 0;
  const big: string[] = [];
  for (const f of readdirSync(OUT)) {
    const b = statSync(join(OUT, f)).size;
    raw += b;
    gz += gzipSync(readFileSync(join(OUT, f)), { level: 9 }).length;
    if (b > CEIL_FILE_BYTES) big.push(`${f} ${(b / 1024).toFixed(0)} KB`);
  }
  const wall = performance.now() - t0;
  const routed = outs.reduce((s, o) => s + o.routed, 0), cpu = outs.reduce((s, o) => s + o.ms, 0);
  const failed = outs.flatMap((o) => o.failed);
  const files = Object.keys(index.levels).length;
  console.log(`route cache: ${routed} levels routed (${(cpu / 1000).toFixed(1)} s of routing on ${jobs} jobs, ${(wall / 1000).toFixed(1)} s wall); ` +
    `${files} over ${threshold} ms cached: ${(raw / 1024).toFixed(0)} KB, ${(gz / 1024).toFixed(0)} KB gzipped${failed.length ? `; ${failed.length} did not route: ${failed.slice(0, 5).join(', ')}` : ''}`);
  const bad: string[] = [];
  if (gz > CEIL_GZIP_BYTES) bad.push(`${(gz / 1024).toFixed(0)} KB gzipped, over ${(CEIL_GZIP_BYTES / 1024).toFixed(0)} KB: raise --threshold`);
  if (big.length) bad.push(`files over ${CEIL_FILE_BYTES / 1024} KB: ${big.join(', ')}`);
  if (process.env.CI && wall > CEIL_CI_MS) bad.push(`${(wall / 1000).toFixed(0)} s, over ${CEIL_CI_MS / 1000} s on CI`);
  if (bad.length) {
    console.error(`route cache over its ceilings:\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
}

const sh = arg('--shard');
if (sh) { const [k, n] = sh.split('/').map(Number); shard(k, n); } else await main();
