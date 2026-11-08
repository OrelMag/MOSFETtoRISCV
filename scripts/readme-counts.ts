// The numbers README.md quotes about the book, computed from the code and written between marker comments:
//   <!--n:chapters-->81<!--/n-->        (invisible on GitHub; the key says what is counted, see `readmeCounts`)
//   npx vite-node scripts/readme-counts.ts            rewrite the numbers in README.md
//   npx vite-node scripts/readme-counts.ts --check    fail when README.md disagrees (tests/readme-counts.test.ts runs the same comparison)
// `ch.<id>` is a chapter's number (chapters/order.ts), so a caption saying "Ch. 26" cannot drift when a chapter is inserted.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chapters } from '../src/chapters';
import { BOOK_ORDER, numOf, type ChapterId } from '../src/chapters/order';
import { NODES, ACTS } from '../src/campaign/nodes';
import { CODEX } from '../src/campaign/codex';
import { BUG_HUNT_IDS } from '../src/campaign/bughunts';
import { TWIN_LEVELS } from '../src/campaign/twinids';
import { CAPSTONES, COMM_CAPSTONES, DSP_CAPSTONES } from '../src/learn/capstones';
import { EXAMPLES } from '../src/editor/examples';
import { CHALLENGES } from '../src/editor/challengeset';
import { PUZZLES } from '../src/puzzles/puzzles';
import { ANALOGIES } from '../src/chapters/analogies';
import { CPUS } from '../tests/verify/cpus';

const README = fileURLToPath(new URL('../README.md', import.meta.url));

/** Every number the README quotes about the book, by marker key. */
export function readmeCounts(): Record<string, number> {
  const appendix = chapters.filter((c) => (c as { appendix?: string }).appendix);
  const prologue = chapters.filter((c) => (c as { prologue?: string }).prologue);
  const isAppendix = (id: string) => appendix.some((c) => c.id === id);
  const numbered = BOOK_ORDER.filter((id) => numOf(id) > 0 && !isAppendix(id));
  // chapters with no number that are neither the map nor a prologue chapter: the on-ramps (Basics, Sending a message)
  const onramps = chapters.filter((c) => numOf(c.id as ChapterId) === 0 && c.id !== 'map' && !prologue.some((p) => p.id === c.id));
  const span = (a: ChapterId, b: ChapterId) => numOf(b) - numOf(a) + 1;
  const out: Record<string, number> = {
    journey: numbered.length,
    onramps: onramps.length,
    prologue: prologue.length,
    appendices: appendix.length,
    'comm.first': numOf('telegraph'), 'comm.last': numOf('bench'), 'comm.count': span('telegraph', 'bench'),
    'dsp.first': numOf('fixed'), 'dsp.last': numOf('sdr'), 'dsp.count': span('fixed', 'sdr'),
    levels: NODES.length,
    acts: ACTS.length,
    'dsp.levels': NODES.filter((n) => n.act === 13).length,
    codex: CODEX.length,
    capstones: CAPSTONES.length, 'capstones.comm': COMM_CAPSTONES.length, 'capstones.dsp': DSP_CAPSTONES.length,
    bughunts: BUG_HUNT_IDS.length,
    twins: TWIN_LEVELS.length,
    examples: EXAMPLES.length,
    challenges: CHALLENGES.length,
    puzzles: PUZZLES.length,
    analogies: ANALOGIES.length,
    cpus: CPUS.length,
    readings: chapters.reduce((n, c) => n + c.steps.filter((s) => s.reading).length, 0),
  };
  for (const id of BOOK_ORDER) out[`ch.${id}`] = numOf(id);
  return out;
}

const MARK = /<!--n:([\w.-]+)-->([\s\S]*?)<!--\/n-->/g;

/** The README with every marker's number as computed; `problems` names keys that do not exist. */
export function applyCounts(text: string, counts = readmeCounts()): { text: string; problems: string[]; stale: string[] } {
  const problems: string[] = [], stale: string[] = [];
  const next = text.replace(MARK, (all, key: string, old: string) => {
    const v = counts[key];
    if (v === undefined) { problems.push(key); return all; }
    if (old !== String(v)) stale.push(`${key}: README says ${old}, the code says ${v}`);
    return `<!--n:${key}-->${v}<!--/n-->`;
  });
  return { text: next, problems, stale };
}

if (!process.env.VITEST) {
  const src = readFileSync(README, 'utf8');
  const r = applyCounts(src);
  if (r.problems.length) { console.error(`unknown keys: ${r.problems.join(', ')}`); process.exit(1); }
  if (process.argv.includes('--check')) {
    if (r.stale.length) { console.error(`README.md is stale:\n  ${r.stale.join('\n  ')}\nrun: npx vite-node scripts/readme-counts.ts`); process.exit(1); }
    console.log('README counts are current');
  } else {
    if (r.text !== src) writeFileSync(README, r.text);
    console.log(r.stale.length ? `updated ${r.stale.length} number(s):\n  ${r.stale.join('\n  ')}` : 'README counts already current');
  }
}
