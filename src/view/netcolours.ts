// The learner's net colours on a schematic, the writes (view/layout.ts holds them, reads and sanitizes them on load).
// Only the right-click menu changes a colour, so this module travels with its chunk (view/circuitmenu.ts), not the stage's.

import { editLayout, layoutOf, netColour, type NetColour } from './layout';

/** The colour the learner gave this net on this component's drawing, if any. */
export const colourOf = (id: string, key: string): NetColour | undefined => layoutOf(id)?.hues?.[key];

/** Give a net a colour, or take it away (undefined): one undo step. */
export function setColour(id: string, key: string, c: NetColour | undefined): void {
  editLayout(id, (e) => {
    const v = netColour(c);
    if (v === undefined) delete e.hues?.[key];
    else e.hues = { ...e.hues, [key]: v };
  });
}

/** Every colour the learner picked on this component back to none (one undo step); the arrangement stays. */
export function resetColours(id: string): void {
  editLayout(id, (e) => void delete e.hues);
}
