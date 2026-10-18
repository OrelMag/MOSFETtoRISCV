// Our golden model against Spike on random programs, commit by commit (tests/verify/spike.ts, docs/VERIFICATION.md).
//   npx vite-node scripts/spike-oracle.ts [config ids…] [--seeds <from>..<to>] [--n <units>] [--spike <path>]
//     [--jobs <n>] [--out <dir>] [--self]
// Configs: i im if user sys sys-m (default all). --out keeps each failure's program, ELF and Spike log, and a
// summary.json, for a CI artifact. --self compares the ISS with a Spike-format log of itself (no Spike needed:
// the plumbing alone). Exits 1 on a difference.
import { execFile } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareWithSpike, issAsSpikeLog, ORACLE_CONFIGS, oracleCase, parseSpikeLog, spikeArgs, type OracleCase, type OracleResult } from '../tests/verify/spike';

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const [from, to] = (opt('--seeds') ?? '1..100').split('..').map(Number);
const n = Number(opt('--n') ?? 120);
const spike = opt('--spike') ?? 'spike';
const jobs = Number(opt('--jobs') ?? cpus().length);
const out = opt('--out');
const self = args.includes('--self');
const ids = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const configs = ORACLE_CONFIGS.filter((c) => !ids.length || ids.includes(c.id));
if (ids.some((id) => !ORACLE_CONFIGS.some((c) => c.id === id))) throw new Error(`configs: ${ORACLE_CONFIGS.map((c) => c.id).join(' ')}`);

const tmp = mkdtempSync(join(tmpdir(), 'spike-'));

/** Spike's log of a case ('' and the error when Spike failed to start or crashed). */
function runSpike(c: OracleCase): Promise<{ log: string; error?: string }> {
  const base = join(tmp, `${c.cfg.id}-${c.seed}`), elf = `${base}.elf`, log = `${base}.log`;
  writeFileSync(elf, c.elf);
  return new Promise((ok) => {
    // a program gone astray never writes tohost: the timeout ends it, and its log so far shows where
    execFile(spike, spikeArgs(c.cfg, elf, log), { timeout: 20_000, maxBuffer: 1 << 26 }, (err, _so, se) => {
      let text = '';
      try { text = readFileSync(log, 'utf8'); } catch { /* none written */ }
      rmSync(elf, { force: true }); rmSync(log, { force: true });
      ok({ log: text, error: err && !err.killed ? `${err.message}\n${se}` : undefined });
    });
  });
}

interface Failure { cfg: string; seed: number; diff: string; source: string }
const failures: Failure[] = [];
const summary: Record<string, { programs: number; matched: number; steps: number; allowances: number }> = {};
const t0 = performance.now();
for (const cfg of configs) {
  const t1 = performance.now();
  const s = (summary[cfg.id] = { programs: 0, matched: 0, steps: 0, allowances: 0 });
  const seeds = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  let next = 0;
  const one = async (seed: number): Promise<void> => {
    const c = oracleCase(cfg, seed, n);
    let r: OracleResult;
    let log = '';
    if (self) r = compareWithSpike(c, parseSpikeLog((log = issAsSpikeLog(c))));
    else {
      const sp = await runSpike(c);
      log = sp.log;
      r = sp.error ? { seed, cfg: cfg.id, ok: false, steps: 0, diff: `Spike failed: ${sp.error.trim().split('\n').slice(0, 4).join(' | ')}`, allowances: 0 } : compareWithSpike(c, parseSpikeLog(log));
    }
    s.programs++; s.steps += r.steps; s.allowances += r.allowances;
    if (r.ok) { s.matched++; return; }
    failures.push({ cfg: cfg.id, seed, diff: r.diff, source: c.source });
    console.log(`  ${cfg.id} seed ${seed}: ${r.diff}`);
    if (out) {
      const dir = join(out, `${cfg.id}-${seed}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'program.s'), c.source);
      writeFileSync(join(dir, 'program.elf'), c.elf);
      // the log up to a little past the difference is what matters; a runaway one is cut
      writeFileSync(join(dir, 'spike.log'), log.length > 4e6 ? `${log.slice(0, 4e6)}\n… cut` : log);
      writeFileSync(join(dir, 'diff.txt'), `${r.diff}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => { while (next < seeds.length) await one(seeds[next++]); }));
  console.log(`${cfg.id.padEnd(6)} ${s.matched}/${s.programs} programs match, ${s.steps} instructions compared, ${s.allowances} mtval allowances (${((performance.now() - t1) / 1000).toFixed(1)} s)`);
}
rmSync(tmp, { recursive: true, force: true });
console.log(`total ${((performance.now() - t0) / 1000).toFixed(0)} s, ${failures.length} failures`);
if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ seeds: `${from}..${to}`, n, self, summary, failures }, null, 1));
}
if (failures.length) process.exit(1);
