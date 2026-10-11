// Every playable campaign level's reference answer measured against its par: the numbers a par
// review starts from. A par above its reference leaves slack a learner can beat for free; below
// it, tests/campaign.test.ts fails. --write sets every par to its reference's measurement in
// src/campaign/nodes.ts (only for passing references; changes learners' stars, so review it).
//   npx vite-node scripts/campaign-pars.ts [--write] [node …]   (all levels without node ids)

import { readFileSync, writeFileSync } from 'node:fs';
import { measured } from '../src/campaign/grade';
import { levelChallenge } from '../src/campaign/levels';
import { NODES } from '../src/campaign/nodes';
import type { Metric } from '../src/campaign/types';
import { checkChallenge } from '../src/editor/challenges';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';

const args = process.argv.slice(2);
const write = args.includes('--write');
const only = new Set(args.filter((a) => a !== '--write'));
const NODES_TS = 'src/campaign/nodes.ts';
let src = readFileSync(NODES_TS, 'utf8');
let changed = 0;

for (const n of NODES) {
  if (only.size && !only.has(n.id)) continue;
  const c = levelChallenge(n);
  if (!c?.answer) continue;
  const chips = c.answer();
  const ws = emptyWorkspace();
  for (const d of chips) ws.chips[d.id] = d;
  const lib = new UserLibrary(ws);
  const r = checkChallenge(c, lib.compiled(chips[chips.length - 1].id));
  const m = measured(r.score);
  const keys = Object.keys(n.par ?? {}) as Metric[];
  const cols = keys.map((k) => {
    const p = n.par![k]!, v = m[k];
    const flag = v === undefined ? ' ?' : v > p ? ' OVER' : v < p ? ' slack' : '';
    return `${k} ${v ?? '-'}/${p}${flag}`;
  });
  console.log(`${r.ok ? '  ' : '✗ '}${n.id.padEnd(12)} ${cols.join('  ')}${r.ok ? '' : `  ${[...r.failures, ...r.restrictionViolations].slice(0, 3).join('; ')}`}`);
  if (!write || !r.ok || keys.every((k) => m[k] === undefined || m[k] === n.par![k])) continue;
  // The node's own `par: { … }`, the first one after its id.
  const at = src.indexOf(`id: '${n.id}'`);
  const p0 = src.indexOf('par: {', at), p1 = src.indexOf('}', p0);
  if (at < 0 || p0 < 0) throw new Error(`${n.id}: par not found in ${NODES_TS}`);
  const par = `par: { ${keys.map((k) => `${k}: ${m[k] ?? n.par![k]}`).join(', ')} }`;
  src = src.slice(0, p0) + par + src.slice(p1 + 1);
  changed++;
}
if (write) {
  writeFileSync(NODES_TS, src);
  console.log(`${changed} par${changed === 1 ? '' : 's'} rewritten in ${NODES_TS}`);
}
