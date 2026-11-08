// The campaign progress read straight from storage, for pages that only look (My path): no imports at run time, so it does not bring
// the campaign's nodes or the editor's store. progress.ts writes the same key on every change (synchronously), so both agree.

import type { NodeState, ProgressView } from './status';

export const CAMPAIGN_KEY = 'mosfet2riscv:campaign:v1';

const STATUSES = new Set(['started', 'solved', 'skipped']);

export interface CampaignRead { view: ProgressView; unlockAll: boolean }

/** Each level's status and Unlock all, as progress.ts would hold them (anything else in a record is left out). */
export function readCampaign(kv: { getItem(k: string): string | null } | null = storage()): CampaignRead {
  let raw: unknown = null;
  try { raw = JSON.parse(kv?.getItem(CAMPAIGN_KEY) ?? 'null'); } catch { /* unreadable: nothing played */ }
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const nodes = obj(raw) && obj(raw.nodes) ? raw.nodes : {};
  const states = new Map<string, NodeState>();
  for (const [id, v] of Object.entries(nodes)) if (obj(v) && typeof v.status === 'string' && STATUSES.has(v.status)) states.set(id, { status: v.status as NodeState['status'] });
  return { view: (id) => states.get(id), unlockAll: obj(raw) && raw.unlockAll === true };
}

function storage(): { getItem(k: string): string | null } | null {
  try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; }
}
