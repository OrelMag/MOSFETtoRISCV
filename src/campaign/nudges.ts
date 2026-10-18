// The first rung of a level's hint ladder: a nudge that points the way without naming a part, shown before the
// level's own tips (CampaignNode.tips, which get concrete quickly). No DOM.

import type { CampaignNode } from './types';

export const NUDGES: Record<string, string> = {
};

/** A level's tips in the order they are revealed: its nudge first, then its own tips. */
export const tipsOf = (n: CampaignNode): string[] => (NUDGES[n.id] ? [NUDGES[n.id], ...n.tips] : n.tips);
