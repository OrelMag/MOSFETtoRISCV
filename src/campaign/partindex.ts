// From a library part to what teaches it (DOM-free, loaded when the menu's Explain opens): the codex entry whose figure it
// is (CodexMore.lib), else one of the level that unlocks it, a generated size through its family; then that entry's
// chapter. On a campaign level the answer goes through a gate: the level's own target must not be given away.

import { familyOf } from '../lib/resolve';
import { codexById, type CodexEntry } from './codex';
import { moreIds, moreOf } from './codexmore';
import { teachingLevels } from './codexlinks';
import { NODES, nodeById } from './nodes';
import type { ChapterLink } from './types';

interface Index { exact: Map<string, string>; family: Map<string, string>; prefix: [string, string][] }
let index: Index | null = null;

function build(): Index {
  const exact = new Map<string, string>(), family = new Map<string, string>(), prefix: [string, string][] = [];
  const fam = (id: string) => familyOf(id)?.fam.id;
  // an entry's own figure first: it is about that part
  for (const c of moreIds()) {
    const lib = moreOf(c)?.lib;
    if (!lib || !codexById(c)) continue;
    if (!exact.has(lib)) exact.set(lib, c);
    const f = fam(lib);
    if (f && !family.has(f)) family.set(f, c);
  }
  // then the level that unlocks it, by the entry that level teaches first
  for (const n of NODES) {
    const c = n.codex.find((x) => codexById(x));
    if (!c) continue;
    for (const u of n.unlocks ?? []) {
      if (u.endsWith('*')) prefix.push([u.slice(0, -1), c]);
      else {
        if (!exact.has(u)) exact.set(u, c);
        const f = fam(u);
        if (f && !family.has(f)) family.set(f, c);
      }
    }
  }
  // the bare transistors are what their switch entry is about
  for (const [a, b] of [['nmos', 'nmos_switch'], ['pmos', 'nmos_switch']]) if (!exact.has(a) && exact.has(b)) exact.set(a, exact.get(b)!);
  return { exact, family, prefix };
}

/** The codex entry that teaches a library part (undefined: none does, or a user chip). */
export function entryOfPart(id: string): CodexEntry | undefined {
  const ix = (index ??= build());
  const f = familyOf(id)?.fam.id;
  // an entry named after the part (or its family) is about it; another that only draws it comes after
  const own = codexById(id) ?? (f ? codexById(f) : undefined);
  if (own) return own;
  const c = ix.exact.get(id) ?? (f ? ix.family.get(f) : undefined) ?? ix.prefix.find(([p]) => id.startsWith(p))?.[1];
  return c ? codexById(c) : undefined;
}

/** The chapter that teaches an entry: the first its fuller text links, else the one its first level links. */
export function chapterOfEntry(id: string): ChapterLink | undefined {
  return moreOf(id)?.chapters?.[0] ?? teachingLevels(id).find((n) => n.chapters?.length)?.chapters?.[0];
}

export const chapterHref = (c: ChapterLink): string => `#/c/${c.chapter}${c.step === undefined ? '' : `/${c.step}`}`;

/** What a level's menu must respect: the entries unlocked so far, and whether this level is passed or skipped. */
export interface LevelGate { unlocked: ReadonlySet<string>; done: boolean }

export interface PartExplain {
  codex?: { id: string; title: string; locked: boolean; unlock?: string };
  chapter?: { href: string; label: string };
  /** "Where it is used" may show: on an open level it would say what the target is made of. */
  used: boolean;
}

/** What Explain may say about a part (`gate` null: no level, nothing held back). */
export function explainPart(id: string, gate: LevelGate | null): PartExplain {
  const e = entryOfPart(id);
  const used = !gate || gate.done;
  if (!e) return { used };
  const locked = !!gate && !gate.unlocked.has(e.id);
  const where = locked ? teachingLevels(e.id).map((n) => n.title).join(' or ') : '';
  const ch = locked ? undefined : chapterOfEntry(e.id);
  return {
    codex: { id: e.id, title: e.title, locked, ...(where ? { unlock: where } : {}) },
    ...(ch ? { chapter: { href: chapterHref(ch), label: ch.label } } : {}),
    used,
  };
}

/** The node a level's or walkthrough's chip belongs to. */
const nodeOf = (chipId: string) => nodeById(chipId.replace(/^u_(ch_cp_|walk_)/, ''));

/** The gate for a chip (null: not a level's). Progress is read now: it changes as the learner passes levels. */
export async function gateOf(chipId: string, level: boolean): Promise<LevelGate | null> {
  if (!level && !/^u_(ch_cp|walk)_/.test(chipId)) return null;
  const [{ progress }, { isDone }] = await Promise.all([import('./progress'), import('./graph')]);
  const p = progress();
  const n = nodeOf(chipId);
  // a walkthrough is the reference answer, read on purpose: still gated like its level
  return { unlocked: p.codexUnlocked(), done: !!n && isDone(p.view(n.id)) };
}
