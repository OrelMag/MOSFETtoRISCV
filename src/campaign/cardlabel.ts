// What a level is called where words stand in for the map's drawing: the kind and status labels the
// level panel shows, and a map card's accessible name (DOM-free, tests/campaign-a11y.test.ts).

import type { CampaignNode, Status } from './types';

export const KIND_LABEL: Record<CampaignNode['kind'], string> = { lesson: 'Lesson', drill: 'Drill', build: 'Build', program: 'Program', core: 'CPU core' };
export const STATUS_LABEL: Record<Status, string> = { locked: 'Locked', available: 'Available', started: 'In progress', solved: 'Solved', skipped: 'Skipped' };

/**
 * A map card's accessible name: "Build: CMOS inverter, locked". A solved level that is graded adds its
 * stars ("2 of 3 stars"), an optional one says so, and one not written yet is "coming soon" whatever its status.
 */
export function levelCardLabel(n: Pick<CampaignNode, 'kind' | 'title' | 'optional' | 'soon' | 'bug'>, st: Status, stars = 0, helped = false): string {
  const parts = [n.soon ? 'coming soon' : STATUS_LABEL[st].toLowerCase()];
  if (!n.soon && st === 'solved' && n.kind !== 'lesson') parts.push(stars ? `${stars} of 3 stars` : helped ? 'solved with help, no stars' : '0 of 3 stars');
  if (n.optional) parts.push('optional');
  return `${n.bug ? `${n.bug.find ? 'Find it' : 'Fix it'}: ${n.title}` : `${KIND_LABEL[n.kind]}: ${n.title}`}, ${parts.join(', ')}`;
}

/** What a rule's `prefix*` stands for, in words (a family of library parts of any size). */
const FAMILY: Record<string, string> = {
  'andx*': 'bitwise AND (any width)', 'orx*': 'bitwise OR (any width)', 'xorx*': 'bitwise XOR (any width)',
  'zero*': 'zero detect (any width)', 'eq*': 'equality comparators (any width)', 'dec*': 'decoders (any size)',
  'mux*': 'multiplexers (any size)', 'rv16_mux*': 'RV16 bus multiplexers', 'lzc*': 'leading-zero counters (any width)',
  'ram*': 'RAMs (any size)', 'sb_rom*': 'ROMs (any size)',
};

/** Library ids (exact or `prefix*`) as the names a level lists: "CMOS inverter", "decoders (any size)"; duplicates once. */
export function partNames(ids: readonly string[], nameOf: (id: string) => string | undefined): string[] {
  // a reference answer's splitters and mergers (split_1_1_…: generated ids, no name of their own) are wiring, listed once
  const names = ids.map((u) => (u.endsWith('*') ? FAMILY[u] ?? `${u.slice(0, -1)}… (any size)` : /^(split|merge)_[\d_p]+$/.test(u) ? 'splitters and mergers (wiring)' : nameOf(u) ?? u));
  return [...new Set(names)];
}

const KIND_MARK: Record<CampaignNode['kind'], string> = { lesson: 'read', drill: 'drill', build: 'build', program: 'code', core: 'CPU' };

/** A map card's width and the space its two top-row labels share (layout.ts NODE_W; kept here so this stays DOM-free). */
export const CARD_W = 168, CARD_PAD = 10, HEAD_GAP = 8;
/** Estimated widths in px, on the high side: the kind label is 10 px monospace capitals plus tracking, the stars 12 px glyphs. */
export const kindWidth = (t: string) => t.length * 6.5;
export const statusWidth = (t: string) => (t.includes('★') || t.includes('☆') ? t.length * 13 : t.length * 6.2);

export interface CardHeads { kind: string; status: string; statusClass: 'stars' | 'skip' | 'lock' | '' }

/**
 * The two labels on a card's top row: the kind on the left ("bug hunt · optional · soon"), the status on the right
 * (stars, skipped, locked). The kind gets shorter ("opt", "bug") until both fit with a gap; a card that still cannot
 * fit both drops the status (the card's accessible name and the level panel carry it).
 */
export function cardHeads(n: Pick<CampaignNode, 'kind' | 'optional' | 'soon' | 'bug'>, st: Status, stars = 0, helped = false): CardHeads {
  let status = '', statusClass: CardHeads['statusClass'] = '';
  if (st === 'solved' && n.kind !== 'lesson' && !stars && helped) { status = 'helped'; statusClass = 'skip'; }
  else if (st === 'solved' && n.kind !== 'lesson') { status = '★'.repeat(stars) + '☆'.repeat(3 - stars); statusClass = 'stars'; }
  else if (st === 'skipped') { status = 'skipped'; statusClass = 'skip'; }
  else if (st === 'locked') { status = 'locked'; statusClass = 'lock'; }
  const kind = (base: string, opt: string) => [base, n.optional ? opt : '', n.soon ? 'soon' : ''].filter(Boolean).join(' · ');
  const base = n.bug ? bugTag(n.bug) : KIND_MARK[n.kind];
  const variants = [kind(base, 'optional'), kind(base, 'opt'), kind(n.bug ? (n.bug.find ? 'find' : 'fix') : base, 'opt')];
  const room = CARD_W - 2 * CARD_PAD - HEAD_GAP;
  const fit = variants.find((v) => kindWidth(v) + (status ? statusWidth(status) : 0) <= room);
  if (fit !== undefined) return { kind: fit, status, statusClass };
  return { kind: variants[2], status: '', statusClass: '' };
}

/** A debugging level's tag: a break-it level is found (FIND IT), a bug hunt fixed (FIX IT). */
export const bugTag = (b: { find?: boolean }): string => (b.find ? 'find it' : 'fix it');

/** "Needs A, B. Unlocks C." for a card's description (titles of the levels its lines join). */
export function relationText(needs: readonly string[], unlocks: readonly string[]): string {
  const list = (xs: readonly string[]) => xs.join(', ');
  return [needs.length ? `Needs ${list(needs)}.` : 'Needs nothing else.', unlocks.length ? `Unlocks ${list(unlocks)}.` : 'Unlocks nothing further.'].join(' ');
}

/** A level's brief as a phone's one-line goal: its plain text, and the first sentence of it. */
export function goalText(brief: string): { plain: string; first: string } {
  const plain = brief.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return { plain, first: plain.match(/^.*?[.:](\s|$)/)?.[0].trim() ?? plain };
}
