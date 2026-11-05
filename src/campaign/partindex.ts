// From a library part to what teaches it (DOM-free, loaded when the menu's Explain opens): the codex entry about it, a
// generated size through its family; then that entry's chapter. On a campaign level the answer goes through a gate: the
// level's own target must not be given away.

import { familyOf } from '../lib/resolve';
import { codexById, type CodexEntry } from './codex';
import { moreIds, moreOf } from './codexmore';
import { firstTeacher, teachingLevels } from './codexlinks';
import { nodeById } from './nodes';
import type { ChapterLink } from './types';

// A wrong link is worse than none: only an entry that is about the part counts, never one that merely draws it or that the
// level unlocking it happens to teach. Families of parts the ids do not name are written out.
const PART_ENTRY: [RegExp, string][] = [
  [/^[np]mos(_switch)?$/, 'mosfet'],
  [/^inv_/, 'inverter'],
  [/^(mux|busmux)/, 'mux'],
  [/^dec[1-6]e?(_p\d+)?$/, 'decoder'],
  [/^eq\d+$/, 'comparator'],
  [/^(rca|rv16_add)\d*$/, 'ripple'],
  [/^inc\d+$/, 'incrementer'],
  [/^shift\d+$/, 'shifter'],
  [/^(rv16_)?alu\d*/, 'alu'],
  [/^sr_latch$/, 'latch'],
  [/^d_latch/, 'dlatch'],
  [/^dff/, 'dff'],
  [/^reg(ister)?\d+/, 'register'],
  [/^counter\d+/, 'counter'],
  [/^ram\d/, 'ram'],
  [/^rom_/, 'rom'],
  [/^regfile/, 'regfile'],
  [/^relay/, 'relay'],
  [/^(tube_|triode$)/, 'triode'],
  [/^nor_cmos$/, 'nor'],
];

/** The codex entry that teaches a library part (undefined: none is about it, or a user chip). */
export function entryOfPart(id: string): CodexEntry | undefined {
  if (id.startsWith('u_')) return undefined;
  const flat = id.replace(/_/g, '');
  const own = codexById(id) ?? codexById(flat);
  if (own) return own;
  const hit = PART_ENTRY.find(([re]) => re.test(id));
  if (hit) return codexById(hit[1]);
  const f = familyOf(id)?.fam.id;
  return (f ? codexById(f) : undefined) ?? moreIds().map((c) => (moreOf(c)?.lib === id && codexById(c)?.kind === 'component' ? codexById(c) : undefined)).find(Boolean);
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
  // the level that teaches it first: a list would name levels further on
  const where = locked ? firstTeacher(e.id)?.title ?? '' : '';
  const ch = locked ? undefined : chapterOfEntry(e.id);
  return {
    codex: { id: e.id, title: e.title, locked, ...(where ? { unlock: where } : {}) },
    ...(ch ? { chapter: { href: chapterHref(ch), label: ch.label } } : {}),
    used,
  };
}

/** The node a level's or walkthrough's chip belongs to. */
export const nodeOfChipId = (chipId: string) => nodeById(chipId.replace(/^u_(ch_cp_|walk_)/, ''));

/** The gate for a chip (null: not a level's). Progress is read now: it changes as the learner passes levels. */
export async function gateOf(chipId: string, level: boolean): Promise<LevelGate | null> {
  if (!level && !/^u_(ch_cp|walk)_/.test(chipId)) return null;
  const [{ progress }, { isDone }] = await Promise.all([import('./progress'), import('./graph')]);
  const p = progress();
  const n = nodeOfChipId(chipId);
  // a walkthrough is the reference answer, read on purpose: still gated like its level
  return { unlocked: p.codexUnlocked(), done: !!n && isDone(p.view(n.id)) };
}
