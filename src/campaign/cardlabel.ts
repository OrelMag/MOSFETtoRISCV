// What a level is called where words stand in for the map's drawing: the kind and status labels the
// level panel shows, and a map card's accessible name (DOM-free, tests/campaign-a11y.test.ts).

import type { CampaignNode, Status } from './types';

export const KIND_LABEL: Record<CampaignNode['kind'], string> = { lesson: 'Lesson', drill: 'Drill', build: 'Build', program: 'Program', core: 'CPU core' };
export const STATUS_LABEL: Record<Status, string> = { locked: 'Locked', available: 'Available', started: 'In progress', solved: 'Solved', skipped: 'Skipped' };

/**
 * A map card's accessible name: "Build: CMOS inverter, locked". A solved level that is graded adds its
 * stars ("2 of 3 stars"), an optional one says so, and one not written yet is "coming soon" whatever its status.
 */
export function levelCardLabel(n: Pick<CampaignNode, 'kind' | 'title' | 'optional' | 'soon'>, st: Status, stars = 0): string {
  const parts = [n.soon ? 'coming soon' : STATUS_LABEL[st].toLowerCase()];
  if (!n.soon && st === 'solved' && n.kind !== 'lesson') parts.push(`${stars} of 3 stars`);
  if (n.optional) parts.push('optional');
  return `${KIND_LABEL[n.kind]}: ${n.title}, ${parts.join(', ')}`;
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
  const names = ids.map((u) => (u.endsWith('*') ? FAMILY[u] ?? `${u.slice(0, -1)}… (any size)` : nameOf(u) ?? u));
  return [...new Set(names)];
}
