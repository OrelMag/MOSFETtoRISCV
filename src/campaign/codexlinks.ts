// How codex entries connect (DOM-free): what an entry builds on and leads to, read from the level graph (the entries
// of the levels its teaching levels require, and of the levels that require them), related entries in both
// directions, and its neighbours in the codex's reading order. Nothing here is authored twice.

import { CODEX, CODEX_KINDS, codexById, type CodexEntry } from './codex';
import { ruleFor } from './graph';
import { NODES, nodeById } from './nodes';

/** The codex in reading order: by kind as the list shows them, then as written. */
export const CODEX_ORDER: CodexEntry[] = CODEX_KINDS.flatMap((k) => CODEX.filter((e) => e.kind === k.id));

/** sessionStorage: the level the reader left for the codex page (the page's "Back to" chip). */
export const CODEX_FROM = 'mosfet2riscv:codex-from';

/** The levels that teach an entry. */
export const teachingLevels = (id: string) => NODES.filter((n) => n.codex.includes(id));

const MAX = 6;

/** Entries in codex order, without `id`, at most MAX. */
function pick(ids: Set<string>, id: string): CodexEntry[] {
  ids.delete(id);
  return CODEX_ORDER.filter((e) => ids.has(e.id)).slice(0, MAX);
}

/** Entries taught by the levels that the entry's own levels require directly. */
export function buildsOn(id: string): CodexEntry[] {
  const own = teachingLevels(id);
  const ownIds = new Set(own.map((n) => n.id));
  const req = new Set(own.flatMap((n) => n.requires).filter((r) => !ownIds.has(r)));
  const taughtHere = new Set(own.flatMap((n) => n.codex));
  return pick(new Set(NODES.filter((n) => req.has(n.id)).flatMap((n) => n.codex).filter((c) => !taughtHere.has(c))), id);
}

/** Entries taught by the levels that directly require one of the entry's levels. */
export function leadsTo(id: string): CodexEntry[] {
  const own = new Set(teachingLevels(id).map((n) => n.id));
  const taughtHere = new Set(teachingLevels(id).flatMap((n) => n.codex));
  return pick(new Set(NODES.filter((n) => !own.has(n.id) && n.requires.some((r) => own.has(r))).flatMap((n) => n.codex).filter((c) => !taughtHere.has(c))), id);
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
