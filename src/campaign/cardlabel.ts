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
