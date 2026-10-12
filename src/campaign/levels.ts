// A campaign level as a sandbox build challenge: the node's base challenge with the campaign's
// rule (the parts unlocked by what it builds on), its par, and its own id, so its chip
// (u_ch_cp_<node>) is separate from the sandbox's challenge of the same circuit. No DOM.

import { type BuildChallenge, startChallenge } from '../editor/challenges';
import { type ChipDoc, uniqueName, type Workspace } from '../editor/model';
import { ancestors, ruleFor, topo } from './graph';
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

/**
 * Earlier core levels a core level can start from: core levels it builds on whose chip the learner
 * has, nearest first (Core III before Core II; the pipelines before the single-cycle cores).
 */
export function startCandidates(n: CampaignNode, ws: Workspace): CampaignNode[] {
  if (n.kind !== 'core') return [];
  const order = new Map(topo().map((m, i) => [m.id, i]));
  return [...ancestors(n.id)].map(nodeById).filter((m): m is CampaignNode => !!m && m.kind === 'core' && !!ws.chips[levelChipId(m)])
    .sort((a, b) => order.get(b.id)! - order.get(a.id)!);
}

/**
 * Start a level as a copy of an earlier level's chip (its circuit, pins and notes on it), plus any
 * pin the new level adds (irq). An existing chip of the level is opened, never overwritten.
 */
export function startFrom(ws: Workspace, ch: BuildChallenge, fromChip: string): { ws: Workspace; chipId: string; created: boolean } {
  const r = startChallenge(ws, ch);
  const src = ws.chips[fromChip];
  if (!r.created || !src) return r;
  const fresh = r.ws.chips[r.chipId];
  const have = new Set(src.pins.map((p) => p.name)), ids = src.pins.map((p) => p.id);
  const extra = fresh.pins.filter((p) => !have.has(p.name)).map((p) => {
    const id = uniqueName(p.id, ids);
    ids.push(id);
    return { ...p, id };
  });
  const doc: ChipDoc = { ...src, id: fresh.id, name: fresh.name, notes: `${fresh.notes ?? ''}\n\nStarted from a copy of “${src.name}”.`.trim(), pins: [...src.pins, ...extra] };
  return { ...r, ws: { ...r.ws, chips: { ...r.ws.chips, [r.chipId]: doc } } };
}
