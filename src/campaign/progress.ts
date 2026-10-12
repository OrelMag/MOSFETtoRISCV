// The learner's campaign progress: per level status, best result and stars, tips revealed, puzzle
// sources; Unlock all. Kept in its own storage key (the site's settings hold the chapters'), and
// exported together with the level chips as one file. Storage is injected (tests use a Map).

import type { Imported, KV } from '../editor/store';
import { closure, importChips, sanitizeChip } from '../editor/store';
import type { ChipDoc, Workspace } from '../editor/model';
import { better, type Measured, stars as starsOf } from './grade';
import { isDone, type ProgressView } from './graph';
import { levelChipId } from './levels';
import { NODES, nodeById } from './nodes';

export const CAMPAIGN_KEY = 'mosfet2riscv:campaign:v1';
export const CAMPAIGN_FORMAT = 'mosfet2riscv-campaign';
const SCHEMA = 1;

export interface NodeProgress {
  status?: 'started' | 'solved' | 'skipped';
  best?: Measured;
  stars?: 1 | 2 | 3;
  /** Tips revealed so far. */
  tips?: number;
  /** Opened at least once (a lesson's codex entries unlock on opening). */
  seen?: boolean;
  /** A program puzzle's source. */
  src?: string;
  /** When last solved (ms since epoch). */
  at?: number;
}

export interface CampaignState {
  schema: number;
  nodes: Record<string, NodeProgress>;
  unlockAll?: boolean;
}

export const emptyCampaign = (): CampaignState => ({ schema: SCHEMA, nodes: {} });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const STATUSES = new Set(['started', 'solved', 'skipped']);

/** Untrusted JSON → a state with only known nodes and well-formed fields. */
export function sanitizeCampaign(raw: unknown): CampaignState {
  const st = emptyCampaign();
  if (!isObj(raw)) return st;
  if (raw.unlockAll === true) st.unlockAll = true;
  const nodes = isObj(raw.nodes) ? raw.nodes : {};
  for (const [id, v] of Object.entries(nodes)) {
    if (!nodeById(id) || !isObj(v)) continue;
    const p: NodeProgress = {};
    if (typeof v.status === 'string' && STATUSES.has(v.status)) p.status = v.status as NodeProgress['status'];
    if (v.stars === 1 || v.stars === 2 || v.stars === 3) p.stars = v.stars;
    if (isObj(v.best)) {
      const b: Measured = {};
      for (const [k, x] of Object.entries(v.best)) if (typeof x === 'number' && Number.isFinite(x) && x >= 0 && ['nand', 'transistors', 'depth', 'period', 'cycles', 'size', 'mistakes'].includes(k)) b[k as keyof Measured] = x;
      p.best = b;
    }
    if (typeof v.tips === 'number' && v.tips >= 0) p.tips = Math.floor(Math.min(v.tips, 20));
    if (v.seen === true) p.seen = true;
    if (typeof v.src === 'string' && v.src.length < 100_000) p.src = v.src;
    if (typeof v.at === 'number' && Number.isFinite(v.at)) p.at = v.at;
    st.nodes[id] = p;
  }
  return st;
}

function defaultKV(): KV | null {
  try {
    return (globalThis as { localStorage?: KV }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Progress bound to a storage, with change listeners. */
export class Progress {
  state: CampaignState;
  private listeners = new Set<() => void>();

  constructor(private kv: KV | null = defaultKV()) {
    this.state = this.load();
  }

  private load(): CampaignState {
    try {
      const raw = this.kv?.getItem(CAMPAIGN_KEY);
      if (raw) return sanitizeCampaign(JSON.parse(raw));
    } catch { /* unreadable: start afresh */ }
    return emptyCampaign();
  }

  /** Re-read storage (another page may have written it). */
  reload(): void {
    this.state = this.load();
    this.emit();
  }

  private save(emit = true): void {
    try {
      this.kv?.setItem(CAMPAIGN_KEY, JSON.stringify(this.state));
    } catch { /* full or blocked: progress stays in memory */ }
    if (emit) this.emit();
  }

  private emit(): void {
    this.listeners.forEach((f) => f());
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  get(id: string): NodeProgress | undefined {
    return this.state.nodes[id];
  }

  readonly view: ProgressView = (id) => this.state.nodes[id];

  get unlockAll(): boolean {
    return !!this.state.unlockAll;
  }

  setUnlockAll(v: boolean): void {
    this.state.unlockAll = v || undefined;
    this.save();
  }

  private node(id: string): NodeProgress {
    return (this.state.nodes[id] ??= {});
  }

  /**
   * A level was opened (a lesson's codex unlocks; a build becomes "started"). Saved without
   * notifying: it is called while drawing the level.
   */
  open(id: string, started = false): void {
    const p = this.node(id);
    const before = JSON.stringify(p);
    p.seen = true;
    if (started && !p.status) p.status = 'started';
    if (JSON.stringify(p) !== before) this.save(false);
  }

  /** A pass: solved, best result kept. Returns the stars of this result and whether it is a new best. */
  solve(id: string, m: Measured = {}): { stars: 1 | 2 | 3; best: boolean; first: boolean } {
    const par = nodeById(id)?.par;
    const s = starsOf(m, par);
    const p = this.node(id);
    const first = p.status !== 'solved';
    const best = better({ stars: s, m }, p.stars ? { stars: p.stars, m: p.best ?? {} } : undefined, par);
    p.status = 'solved';
    p.at = Date.now();
    if (best) {
      p.stars = s;
      p.best = m;
    }
    this.save();
    return { stars: s, best, first };
  }

  /** Skip: the level counts as done (its parts unlock), with no stars. A solved level stays solved. */
  skip(id: string): void {
    const p = this.node(id);
    if (p.status === 'solved') return;
    p.status = 'skipped';
    this.save();
  }

  /** Undo a skip (back to available / started). */
  unskip(id: string): void {
    const p = this.node(id);
    if (p.status !== 'skipped') return;
    p.status = p.seen ? 'started' : undefined;
    this.save();
  }

  revealTip(id: string, total: number): number {
    const p = this.node(id);
    p.tips = Math.min(total, (p.tips ?? 0) + 1);
    this.save();
    return p.tips;
  }

  /** A puzzle's source (saved as typed, without redrawing anything). */
  setSource(id: string, src: string): void {
    this.node(id).src = src;
    this.save(false);
  }

  reset(): void {
    this.state = emptyCampaign();
    try {
      this.kv?.removeItem(CAMPAIGN_KEY);
    } catch { /* ignore */ }
    this.emit();
  }

  replace(st: CampaignState): void {
    this.state = st;
    this.save();
  }

  /** Codex entries revealed: those of solved / skipped levels and of opened lessons (a level with a text: on opening; all with Unlock all). */
  codexUnlocked(): Set<string> {
    const out = new Set<string>();
    for (const n of NODES) {
      const p = this.state.nodes[n.id];
      if (this.unlockAll || isDone(p) || (n.body && p?.seen)) n.codex.forEach((c) => out.add(c));
    }
    return out;
  }

  /** Solved / skipped / total required and optional, and stars earned of the possible. */
  summary(): { done: number; required: number; requiredDone: number; stars: number; maxStars: number; playable: number } {
    let done = 0, required = 0, requiredDone = 0, stars = 0, maxStars = 0, playable = 0;
    for (const n of NODES) {
      const p = this.state.nodes[n.id];
      if (!n.soon) playable++;
      if (!n.optional) required++;
      if (isDone(p)) {
        done++;
        if (!n.optional) requiredDone++;
      }
      if (!n.soon && n.kind !== 'lesson') maxStars += 3;
      stars += p?.stars ?? 0;
    }
    return { done, required, requiredDone, stars, maxStars, playable };
  }
}

// ---- export / import -------------------------------------------------------------------------

/** The campaign as a file: progress plus the level chips and every chip they use. */
export function exportCampaign(st: CampaignState, ws: Workspace): string {
  const ids = NODES.map(levelChipId).filter((id) => ws.chips[id]);
  return JSON.stringify({ format: CAMPAIGN_FORMAT, schema: SCHEMA, progress: st, chips: closure(ws, ids) }, null, 2);
}

/** Merge two states: the furthest status, the better result, the most tips; Unlock all if either. */
export function mergeCampaign(a: CampaignState, b: CampaignState): CampaignState {
  const out: CampaignState = { schema: SCHEMA, nodes: {}, ...(a.unlockAll || b.unlockAll ? { unlockAll: true } : {}) };
  const rank = (s?: string) => (s === 'solved' ? 3 : s === 'skipped' ? 2 : s === 'started' ? 1 : 0);
  for (const id of new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)])) {
    const x = a.nodes[id] ?? {}, y = b.nodes[id] ?? {};
    const par = nodeById(id)?.par;
    const p: NodeProgress = { ...x, ...y };
    p.status = rank(x.status) >= rank(y.status) ? x.status : y.status;
    if (!p.status) delete p.status;
    const yBetter = y.stars !== undefined && better({ stars: y.stars, m: y.best ?? {} }, x.stars !== undefined ? { stars: x.stars, m: x.best ?? {} } : undefined, par);
    const keep = yBetter ? y : x;
    if (keep.stars !== undefined) p.stars = keep.stars;
    else delete p.stars;
    if (keep.best) p.best = keep.best;
    else delete p.best;
    const tips = Math.max(x.tips ?? 0, y.tips ?? 0);
    if (tips) p.tips = tips;
    if (x.seen || y.seen) p.seen = true;
    p.src = y.src ?? x.src;
    if (p.src === undefined) delete p.src;
    out.nodes[id] = p;
  }
  return out;
}

export type CampaignImport = { state: CampaignState; ws: Workspace; chips: Imported } | { error: string };

/** Read a campaign file: progress merged into `st`, chips imported into `ws` (never overwriting). */
export function importCampaign(text: string, st: CampaignState, ws: Workspace): CampaignImport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'not JSON' };
  }
  if (!isObj(raw) || raw.format !== CAMPAIGN_FORMAT) return { error: 'not a campaign export' };
  if (typeof raw.schema !== 'number' || raw.schema > SCHEMA) return { error: 'exported by a newer version of the site' };
  const chips = (Array.isArray(raw.chips) ? raw.chips : []).map(sanitizeChip).filter((c): c is ChipDoc => !!c);
  const imp = importChips(chips, ws);
  // A level chip that came in renamed (yours differs): keep yours as the level's chip; the
  // imported one stays available under its new name.
  return { state: mergeCampaign(st, sanitizeCampaign(raw.progress)), ws: imp.ws, chips: imp };
}

/** The shared instance (the browser's storage). */
let shared: Progress | null = null;
export function progress(): Progress {
  return (shared ??= new Progress());
}
