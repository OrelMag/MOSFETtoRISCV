// How codex entries connect (DOM-free): what an entry builds on and leads to, read from the level graph (the entries
// of the levels its teaching levels require, and of the levels that require them), related entries in both
// directions, and its neighbours in the codex's reading order. Nothing here is authored twice.

import { CODEX, CODEX_KINDS, codexById, type CodexEntry } from './codex';
import { ruleFor } from './graph';
import { ACTS, NODES, nodeById } from './nodes';
import type { CampaignNode } from './types';

/**
 * Entries a level unlocks although nothing on it (title, why, lesson, task, tips, case) names them: listed after
 * their act's own entries, under "Further" (tests/codex-guide.test.ts checks that the level still does not name them).
 */
export const FURTHER = new Set(['vm', 'atomics', 'ordering', 'coherence', 'stdcell', 'metastability', 'rowhammer', 'ecc', 'amdahl', 'rv32i', 'tristate']);

/** The codex by kind, then as written: the list's second view. */
export const CODEX_BY_KIND: CodexEntry[] = CODEX_KINDS.flatMap((k) => CODEX.filter((e) => e.kind === k.id));

export interface ActGroup {
  /** The act's number (undefined: entries no level teaches). */
  act?: number;
  main: CodexEntry[];
  further: CodexEntry[];
}

/** sessionStorage: the level the reader left for the codex page (the page's "Back to" chip). */
export const CODEX_FROM = 'mosfet2riscv:codex-from';

/** The levels that teach an entry. */
export const teachingLevels = (id: string) => NODES.filter((n) => n.codex.includes(id));

const MAX = 6;

/** A level's place on the map: acts in map order (ACTS: act P after act 0), then as listed. */
const levelRank = (() => {
  const act = new Map(ACTS.map((a, i) => [a.num, i]));
  const at = new Map(NODES.map((n, i) => [n.id, (act.get(n.act) ?? ACTS.length) * 10000 + i]));
  return (n: CampaignNode) => at.get(n.id) ?? Infinity;
})();

/** The first level on the map that teaches an entry (undefined: none does). */
export function firstTeacher(id: string): CampaignNode | undefined {
  let best: CampaignNode | undefined;
  for (const n of teachingLevels(id)) if (!best || levelRank(n) < levelRank(best)) best = n;
  return best;
}

/** Where an entry is first taught, as a number that orders the map (Infinity: no level teaches it). */
export const firstTaught = (id: string): number => {
  const n = firstTeacher(id);
  return n ? levelRank(n) : Infinity;
};

/**
 * The codex by act, the reading order: each entry where its first teaching level sits on the map (acts in map order,
 * act P after act 0; ties in the order the level lists them), an act's Further entries after its own.
 */
export const CODEX_ACTS: ActGroup[] = (() => {
  const groups = new Map<number | undefined, { main: { e: CodexEntry; k: number }[]; further: { e: CodexEntry; k: number }[] }>();
  for (const a of ACTS) groups.set(a.num, { main: [], further: [] });
  for (const [i, e] of CODEX.entries()) {
    const n = firstTeacher(e.id);
    const k = n ? levelRank(n) + n.codex.indexOf(e.id) / 100 : i;
    if (!groups.has(n?.act)) groups.set(n?.act, { main: [], further: [] });
    groups.get(n?.act)![n && FURTHER.has(e.id) ? 'further' : 'main'].push({ e, k });
  }
  const sorted = (xs: { e: CodexEntry; k: number }[]) => xs.sort((a, b) => a.k - b.k).map((x) => x.e);
  return [...groups].map(([act, g]) => ({ ...(act === undefined ? {} : { act }), main: sorted(g.main), further: sorted(g.further) }))
    .filter((g) => g.main.length + g.further.length > 0);
})();

/** The codex in reading order: by act (CODEX_ACTS), as the list shows it by default; Prev / Next follow it. */
export const CODEX_ORDER: CodexEntry[] = CODEX_ACTS.flatMap((g) => [...g.main, ...g.further]);

/** Entries in codex order, without `id`, at most MAX. */
function pick(ids: Set<string>, id: string): CodexEntry[] {
  ids.delete(id);
  return CODEX_ORDER.filter((e) => ids.has(e.id)).slice(0, MAX);
}

/**
 * Entries taught by the levels its first teaching level requires directly, those first taught before it only (an
 * entry taught again later is read where it is first met: Pipelining does not build on Stall).
 */
export function buildsOn(id: string): CodexEntry[] {
  const own = firstTeacher(id);
  if (!own) return [];
  const at = levelRank(own);
  const req = new Set(own.requires);
  return pick(new Set(NODES.filter((n) => req.has(n.id)).flatMap((n) => n.codex).filter((c) => !own.codex.includes(c) && firstTaught(c) < at)), id);
}

/** Entries taught by the levels that directly require its first teaching level, those first taught after it only. */
export function leadsTo(id: string): CodexEntry[] {
  const own = firstTeacher(id);
  if (!own) return [];
  const at = levelRank(own);
  return pick(new Set(NODES.filter((n) => n.id !== own.id && n.requires.includes(own.id)).flatMap((n) => n.codex).filter((c) => !own.codex.includes(c) && firstTaught(c) > at)), id);
}

/**
 * What a level uses that it does not teach: the entries its own entries build on, and the entries of the earlier
 * levels that unlocked the parts it may place, the nearest levels first (fewest requires between), at most `max`.
 */
export function levelUses(nodeId: string, max = 12): CodexEntry[] {
  const n = nodeById(nodeId);
  if (!n) return [];
  // distance back through requires
  const dist = new Map<string, number>([[n.id, 0]]);
  for (let ring = [n.id], d = 1; ring.length; d++) {
    ring = ring.flatMap((id) => nodeById(id)?.requires ?? []).filter((r) => !dist.has(r));
    ring = [...new Set(ring)];
    for (const r of ring) dist.set(r, d);
  }
  const own = new Set(n.codex);
  const rank = new Map<string, number>();
  const add = (id: string, d: number) => { if (!own.has(id) && codexById(id) && (rank.get(id) ?? Infinity) > d) rank.set(id, d); };
  for (const c of n.codex) for (const e of buildsOn(c)) add(e.id, 1);
  const parts = new Set(ruleFor(n.id).lib);
  for (const m of NODES) {
    const d = dist.get(m.id);
    if (d === undefined || d === 0 || !(m.unlocks ?? []).some((u) => parts.has(u))) continue;
    for (const c of m.codex) add(c, d);
  }
  const order = new Map(CODEX_ORDER.map((e, i) => [e.id, i]));
  return [...rank.keys()].sort((a, b) => rank.get(a)! - rank.get(b)! || order.get(a)! - order.get(b)!).slice(0, max).map((id) => codexById(id)!);
}

/** Related entries both ways: those it names and those that name it. */
export function seeAlso(id: string): CodexEntry[] {
  const e = codexById(id);
  const ids = new Set([...(e?.related ?? []), ...CODEX.filter((x) => x.related?.includes(id)).map((x) => x.id)]);
  return CODEX_ORDER.filter((x) => ids.has(x.id) && x.id !== id);
}

/** The entries before and after it in reading order. */
export function neighbours(id: string): { prev?: CodexEntry; next?: CodexEntry } {
  const i = CODEX_ORDER.findIndex((e) => e.id === id);
  return i < 0 ? {} : { prev: CODEX_ORDER[i - 1], next: CODEX_ORDER[i + 1] };
}

/** Plain text of an entry's summary, for search. */
export const plainSummary = (e: CodexEntry): string => e.body.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');
