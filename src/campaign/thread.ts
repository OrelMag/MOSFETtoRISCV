// The thread: "why do we need this?" answered forward, at the moment of choosing. Per level, where
// its part ends up (anatomy blocks), how each later level uses it (one clause per consumer) and the
// mistakes people make building it; per act, what the machine can and still cannot do once the act
// is behind it. The texts live per act in thread0.ts (acts 0, P, 1, 2), thread1.ts (3–5), thread2.ts
// (6–8), thread3.ts (9–10) and actends.ts; everything else here is derived from the level graph, so
// the map panel and the level screen show the same stack. No DOM.

import { BLOCKS } from './anatomy';
import { type CaseAlt, caseOf } from './cases';
import { dependents, isDone, type ProgressView } from './graph';
import { ACTS, nodeById, NODES } from './nodes';
import type { CampaignNode } from './types';
import { THREAD0 } from './thread0';
import { THREAD1 } from './thread1';
import { THREAD2 } from './thread2';
import { THREAD3 } from './thread3';
import { ACT_ENDS } from './actends';

/** A level's part of the thread. */
export interface NodeThread {
  /** Anatomy block ids (anatomy.ts BLOCKS) its part becomes part of, the main one first; 'all' for a brick found in every block. */
  uses?: string[];
  /** Dependent level id → one clause: how that level uses this one ("wraps one in XORs"). */
  usedFor?: Record<string, string>;
  /** HTML items: mistakes made on this level (the codex entries' `mistakes` are added on the level screen). */
  pitfalls?: string[];
  /** An optional level to offer as the side quest after a pass (default: the first optional dependent). */
  side?: string;
}

/** What the machine can do once an act's required levels are done, and what it still cannot. */
export interface ActEnd {
  /** HTML. */
  can: string;
  /** HTML. */
  cannot: string;
  /** The level to go on with (the next act's first). */
  next?: string;
  /** An optional level to offer beside it. */
  side?: string;
  /** Button texts (default: "<act>: <title>" of the next level's act, "Side quest: <title>"). */
  nextLabel?: string;
  sideLabel?: string;
}

const ALL: Record<string, NodeThread> = { ...THREAD0, ...THREAD1, ...THREAD2, ...THREAD3 };

export const threadOf = (id: string): NodeThread | undefined => ALL[id];
/** Every node id with thread data (tests). */
export const threadIds = (): string[] => Object.keys(ALL);
export const actEnd = (act: number): ActEnd | undefined => ACT_ENDS[act];
export const actEndIds = (): number[] => Object.keys(ACT_ENDS).map(Number);

export const UNIVERSAL = 'all';

// ---- anatomy ------------------------------------------------------------------------------------

/** The blocks a level lights: `ids` (or every block for 'all'); `own` when the level builds the block itself. */
export interface BlockUse {
  ids: string[];
  all: boolean;
  own: boolean;
}

/** Anatomy blocks a level becomes part of: its own `anatomy`, else the thread's `uses`, else the old rule (the nearest later required level that names one). */
export function blockUse(n: CampaignNode): BlockUse | undefined {
  if (n.anatomy?.length) return { ids: n.anatomy, all: false, own: true };
  const u = threadOf(n.id)?.uses;
  if (u?.length) {
    const all = u.includes(UNIVERSAL);
    return { ids: all ? BLOCKS.map((b) => b.id) : u, all, own: false };
  }
  const seen = new Set([n.id]);
  let ring = dependents(n.id).filter((d) => !d.optional);
  while (ring.length) {
    const hit = ring.find((d) => d.anatomy?.length);
    if (hit) return { ids: [hit.anatomy![0]], all: false, own: false };
    ring.forEach((d) => seen.add(d.id));
    ring = ring.flatMap((d) => dependents(d.id)).filter((d) => !d.optional && !seen.has(d.id));
  }
  return undefined;
}

/** A block's name in a tag or a chain (the diagram's '+1' alone says little). */
export const blockLabel = (id: string): string => (id === 'plus1' ? 'PC + 1' : BLOCKS.find((b) => b.id === id)?.label ?? id);

/** The block a map card is tagged with: named by the level itself (anatomy or uses), never guessed. */
export function cardBlock(n: CampaignNode): { label: string; all: boolean } | undefined {
  const id = n.anatomy?.[0] ?? threadOf(n.id)?.uses?.[0];
  if (!id) return undefined;
  if (id === UNIVERSAL) return { label: 'everywhere', all: true };
  const b = BLOCKS.find((x) => x.id === id);
  return b ? { label: blockLabel(b.id), all: false } : undefined;
}

// ---- "Goes into" --------------------------------------------------------------------------------

export interface Chain {
  /** From the level itself to the core level it ends up in (or the level that builds its block). */
  nodes: CampaignNode[];
  /** The anatomy block at the end ('all': every block). */
  block?: { id: string; label: string } | 'all';
}

/**
 * A shortest path over dependents (required ones only, unless `n` is optional) to a node `hit` accepts: of those, the
 * earliest act's, then the nearest (a NOT reaches Core I and a pipeline core alike: Core I is where it first runs).
 */
function pathTo(n: CampaignNode, hit: (m: CampaignNode) => boolean): CampaignNode[] | undefined {
  const req = !n.optional;
  const prev = new Map<string, CampaignNode | null>([[n.id, null]]);
  let ring = [n], best: CampaignNode | undefined;
  while (ring.length) {
    for (const m of ring) if (hit(m) && (!best || m.act < best.act)) best = m;
    const next: CampaignNode[] = [];
    for (const m of ring) {
      for (const d of dependents(m.id)) {
        if ((req && d.optional) || prev.has(d.id)) continue;
        prev.set(d.id, m);
        next.push(d);
      }
    }
    ring = next;
  }
  if (!best) return undefined;
  const out: CampaignNode[] = [];
  for (let c: CampaignNode | null = best; c; c = prev.get(c.id) ?? null) out.unshift(c);
  return out;
}

/**
 * Where a level's part goes: the levels on the shortest path to the one that builds its main block, then on to the
 * first CPU core that holds it, then the block. 16-bit adder → Adder / subtractor → ALU → Core I → ALU.
 */
export function goesInto(id: string): Chain | undefined {
  const n = nodeById(id);
  if (!n) return undefined;
  const use = blockUse(n);
  const main = use && !use.all ? use.ids[0] : undefined;
  const toBlock = main ? pathTo(n, (m) => !!m.anatomy?.includes(main)) ?? [n] : [n];
  const last = toBlock[toBlock.length - 1];
  const toCore = last.kind === 'core' ? [last] : pathTo(last, (m) => m.kind === 'core') ?? [last];
  const nodes = [...toBlock, ...toCore.slice(1)];
  const b = main ? BLOCKS.find((x) => x.id === main) : undefined;
  const block = use?.all ? 'all' as const : b ? { id: b.id, label: blockLabel(b.id) } : undefined;
  if (nodes.length < 2 && !block) return undefined;
  return { nodes, block };
}

// ---- "Used later in" ----------------------------------------------------------------------------

export interface LaterUse {
  node: CampaignNode;
  /** How it uses this level (absent: only its title and act are shown). */
  clause?: string;
}

/** The levels that build directly on this one, required first, each with its clause. */
export function usedLater(id: string): LaterUse[] {
  const f = threadOf(id)?.usedFor ?? {};
  const ds = dependents(id);
  return [...ds.filter((d) => !d.optional), ...ds.filter((d) => d.optional)].map((node) => ({ node, ...(f[node.id] ? { clause: f[node.id] } : {}) }));
}

// ---- the why stack ------------------------------------------------------------------------------

/** Everything both panels show under "why", in order. */
export interface WhyStack {
  /** HTML: the level's one-line why, the bold lead (never replaced by the case). */
  lead: string;
  chain?: Chain;
  /** HTML, from the level's case. */
  problem?: string;
  cost?: string;
  without?: string;
  alts: CaseAlt[];
  later: LaterUse[];
  pitfalls: string[];
}

export function whyStack(id: string): WhyStack | undefined {
  const n = nodeById(id);
  if (!n) return undefined;
  const c = caseOf(id);
  return {
    lead: n.why, chain: goesInto(id), problem: c?.problem, cost: c?.cost, without: c?.without,
    alts: c?.alts ?? [], later: usedLater(id), pitfalls: threadOf(id)?.pitfalls ?? [],
  };
}

/** A level's pitfalls, then the `mistakes` of the codex entries it teaches (`mistakesOf`), each once. */
export function pitfallsOf(n: CampaignNode, mistakesOf: (codexId: string) => string[] | undefined = () => undefined): string[] {
  const out: string[] = [], seen = new Set<string>();
  const key = (t: string) => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  for (const t of [...(threadOf(n.id)?.pitfalls ?? []), ...n.codex.flatMap((c) => mistakesOf(c) ?? [])]) {
    const k = key(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// ---- after a pass -------------------------------------------------------------------------------

export interface Reach {
  node: CampaignNode;
  /** Requirements done, of all. */
  done: number;
  total: number;
  missing: CampaignNode[];
  /** How it uses the level just passed. */
  clause?: string;
}

/** The required levels building directly on `id` that are not done yet, closest to ready first (ready ones first of all). */
export function withinReach(id: string, view: ProgressView): Reach[] {
  const f = threadOf(id)?.usedFor ?? {};
  return dependents(id).filter((d) => !d.optional && !d.soon && !isDone(view(d.id))).map((node) => {
    const reqs = node.requires.map((r) => nodeById(r)).filter((x): x is CampaignNode => !!x);
    const missing = reqs.filter((r) => !isDone(view(r.id)));
    return { node, done: reqs.length - missing.length, total: reqs.length, missing, ...(f[node.id] ? { clause: f[node.id] } : {}) };
  }).sort((a, b) => a.missing.length - b.missing.length);
}

/** The side quest to offer after `id`: the thread's choice, else the first optional dependent; never one done or not built. */
export function sideQuest(id: string, view: ProgressView): CampaignNode | undefined {
  const named = threadOf(id)?.side;
  const cands = [named ? nodeById(named) : undefined, ...dependents(id).filter((d) => d.optional)];
  return cands.find((c): c is CampaignNode => !!c && !c.soon && !isDone(view(c.id)));
}

// ---- act seams ----------------------------------------------------------------------------------

/** An act's required levels (built ones). */
export const requiredOf = (act: number): CampaignNode[] => NODES.filter((n) => n.act === act && !n.optional && !n.soon);

/** Every required level of the act done (an act with none never is). */
export function actDone(act: number, view: ProgressView): boolean {
  const ns = requiredOf(act);
  return ns.length > 0 && ns.every((n) => isDone(view(n.id)));
}

/** The act whose end `n` completes, when it does now: a required level of an act with an end card, all of whose required levels are done. */
export function closedAct(n: CampaignNode, view: ProgressView): number | undefined {
  return !n.optional && actEnd(n.act) && actDone(n.act, view) ? n.act : undefined;
}

/**
 * Where an act's end card sends the learner: its `next` level while that is open and not done, else the first open,
 * unfinished required level of the same act (the next act's start was played already, or waits on another level).
 */
export function actNext(end: ActEnd, view: ProgressView, open: (n: CampaignNode) => boolean): CampaignNode | undefined {
  const n = end.next ? nodeById(end.next) : undefined;
  if (!n) return undefined;
  if (!isDone(view(n.id)) && open(n)) return n;
  return requiredOf(n.act).find((m) => !isDone(view(m.id)) && open(m));
}

/** "Act 3: State and memory" style label for an act. */
export function actLabel(num: number): string {
  const a = ACTS.find((x) => x.num === num);
  return a ? `${a.label ?? `Act ${a.num}`}: ${a.title}` : '';
}
