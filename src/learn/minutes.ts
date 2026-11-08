// How long a step takes (DOM-free, no imports at run time): reading at READ_WPM, plus a few minutes for a stage or widget, a challenge
// and a tour. learn/pathgen.ts applies it to every step for the path index; My path reads the numbers from there.

import type { Step } from '../chapters/types';

export const READ_WPM = 200;

const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\$\{[^}]*\}/g, ' x ').split(/\s+/).filter(Boolean).length;

/** About how many minutes a step takes: reading, plus the stage or widget, plus its challenge. */
export function stepMinutes(s: Step): number {
  return Math.max(1, Math.round(words(s.body) / READ_WPM + (s.scene || s.widget ? 2 : 0) + (s.challenge ? 2 : 0) + (s.tour ? 1 : 0)));
}
