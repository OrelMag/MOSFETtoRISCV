// A campaign level as a sandbox build challenge: the node's base challenge with the campaign's
// rule (the parts unlocked by what it builds on), its par, and its own id, so its chip
// (u_ch_cp_<node>) is separate from the sandbox's challenge of the same circuit. No DOM.

import type { BuildChallenge } from '../editor/challenges';
import { ruleFor } from './graph';
import { NODES, nodeById } from './nodes';
import { type CampaignNode, parLimits } from './types';

export const CP = 'cp_';

const cache = new Map<string, BuildChallenge>();

/** The challenge a build / core node is played as (memoized), or undefined. */
export function levelChallenge(n: CampaignNode): BuildChallenge | undefined {
  if (!n.base || n.soon) return undefined;
  let c = cache.get(n.id);
  if (!c) {
    const b = n.base();
    // Act 0 builds from transistors; afterwards the campaign's rule replaces the challenge's.
    const allowed = b.allowed === 'transistors' ? b.allowed : ruleFor(n.id);
    c = { ...b, id: `${CP}${n.id}`, title: n.title, allowed, limits: parLimits(n.par) ?? b.limits };
    cache.set(n.id, c);
  }
  return c;
}

/** The node a challenge id or chip id belongs to. */
export function nodeOfChallenge(challengeId: string): CampaignNode | undefined {
  return challengeId.startsWith(CP) ? nodeById(challengeId.slice(CP.length)) : undefined;
}

export const levelChipId = (n: CampaignNode): string => `u_ch_${CP}${n.id}`;

export const nodeOfChip = (chipId: string): CampaignNode | undefined =>
  chipId.startsWith(`u_ch_${CP}`) ? nodeById(chipId.slice(`u_ch_${CP}`.length)) : undefined;

/** Every playable level's challenge (for the sandbox's lookup). */
export function levelChallenges(): BuildChallenge[] {
  return NODES.map(levelChallenge).filter((c): c is BuildChallenge => !!c);
}
