// The learner's campaign progress: per level status, best result and stars, tips revealed, puzzle
// sources; Unlock all. Kept in its own storage key (the site's settings hold the chapters'), and
// exported together with the level chips as one file. Storage is injected (tests use a Map).

import type { Imported, KV } from '../editor/store';
import { closure, importChips, sanitizeChip } from '../editor/store';
import type { ChipDoc, Workspace } from '../editor/model';
import { better, type Measured, stars as starsOf } from './grade';
import { isDone, type ProgressView } from './graph';
import { levelChipId } from './levels';
import { CAPSTONES } from '../learn/capstones';
import { NODES, nodeById } from './nodes';
import { isTwinKey } from './twinids';

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
  /**
   * Passed with the reference answer put in by Do it for me: solved (the next level opens), no stars of its own. Stars
   * earned before (or by a later rebuild by hand) stay; this clears when a pass of the learner's own earns them.
   */
  helped?: boolean;
  /** connKey of the circuit Do it for me left: a Check of it unchanged is still the answer's, not the learner's. */
  helpKey?: string;
  /** The design brief's submissions (cap_t4), newest first: what was measured, not the chip. */
  subs?: Submission[];
}

/** What a pass earned: 0 stars is a lesson or a pass with the answer put in (`helped`). */
export interface PassGrade { stars: 0 | 1 | 2 | 3; best: boolean; first: boolean; helped: boolean }

/** One measured design of the tier 4 brief. */
export interface Submission { nand: number; period: number; cycles: number; stars: 1 | 2 | 3; at: number }

/** Submissions kept per brief. */
export const MAX_SUBMISSIONS = 10;

function cleanSubs(v: unknown): Submission[] {
  if (!Array.isArray(v)) return [];
  const out: Submission[] = [];
  for (const x of v) {
    if (!isObj(x)) continue;
    const { nand, period, cycles, stars, at } = x;
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if (ok(nand) && ok(period) && ok(cycles) && (stars === 1 || stars === 2 || stars === 3) && ok(at)) out.push({ nand, period, cycles, stars, at });
  }
  return out.slice(0, MAX_SUBMISSIONS);
}

export interface CampaignState {
  schema: number;
  nodes: Record<string, NodeProgress>;
  unlockAll?: boolean;
}

export const emptyCampaign = (): CampaignState => ({ schema: SCHEMA, nodes: {} });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A tier capstone (learn/capstones.ts): recorded here beside the nodes, not on the campaign map. */
const isCapstone = (id: string) => CAPSTONES.some((c) => c.id === id);
const STATUSES = new Set(['started', 'solved', 'skipped']);

/** Untrusted JSON → a state with only known nodes and well-formed fields. */
export function sanitizeCampaign(raw: unknown): CampaignState {
  const st = emptyCampaign();
  if (!isObj(raw)) return st;
  if (raw.unlockAll === true) st.unlockAll = true;
  const nodes = isObj(raw.nodes) ? raw.nodes : {};
  for (const [id, v] of Object.entries(nodes)) {
    if ((!nodeById(id) && !isCapstone(id) && !isTwinKey(id)) || !isObj(v)) continue;
    const p: NodeProgress = {};
    if (typeof v.status === 'string' && STATUSES.has(v.status)) p.status = v.status as NodeProgress['status'];
    if (v.stars === 1 || v.stars === 2 || v.stars === 3) p.stars = v.stars;
    if (isObj(v.best)) {
      const b: Measured = {};
      for (const [k, x] of Object.entries(v.best)) if (typeof x === 'number' && Number.isFinite(x) && x >= 0 && ['nand', 'transistors', 'depth', 'period', 'cycles', 'size', 'mistakes', 'idle', 'laneops', 'relays', 'tubes', 'steps'].includes(k)) b[k as keyof Measured] = x;
      p.best = b;
    }
    if (typeof v.tips === 'number' && v.tips >= 0) p.tips = Math.floor(Math.min(v.tips, 20));
    if (v.seen === true) p.seen = true;
    if (v.helped === true) p.helped = true;
    if (typeof v.helpKey === 'string' && v.helpKey.length < 200) p.helpKey = v.helpKey;
    if (typeof v.src === 'string' && v.src.length < 100_000) p.src = v.src;
    if (typeof v.at === 'number' && Number.isFinite(v.at)) p.at = v.at;
    const subs = cleanSubs(v.subs);
    if (subs.length && isCapstone(id)) p.subs = subs;
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

  /** Do it for me replaced the circuit: remember which one, so a Check of it unchanged counts as helped. */
  markHelp(id: string, key: string): void {
    this.node(id).helpKey = key;
    this.save(false);
  }

  /**
   * A pass: solved, best result kept. Returns the stars of this result and whether it is a new best. A lesson earns no
   * stars; a pass of the answer Do it for me put in (`key` = the circuit's connKey) is solved "with help": no stars.
   */
  solve(id: string, m: Measured = {}, key?: string): PassGrade {
    const par = nodeById(id)?.par;
    const p = this.node(id);
    const first = p.status !== 'solved';
    if (nodeById(id)?.kind === 'lesson') {
      p.status = 'solved';
      p.at = Date.now();
      delete p.stars;
      this.save();
      return { stars: 0, best: false, first, helped: false };
    }
    if (key !== undefined && p.helpKey === key) {
      p.status = 'solved';
      p.at = Date.now();
      if (!p.stars) p.helped = true;
      this.save();
      return { stars: 0, best: false, first, helped: true };
    }
    const s = starsOf(m, par);
    const best = better({ stars: s, m }, p.stars ? { stars: p.stars, m: p.best ?? {} } : undefined, par);
    p.status = 'solved';
    p.at = Date.now();
    delete p.helped;
    delete p.helpKey;
    if (best) {
      p.stars = s;
      p.best = m;
    }
    this.save();
    return { stars: s, best, first, helped: false };
  }

  /**
   * A capstone passed: solved, with the best result kept (fewer NANDs, then a shorter period, then fewer cycles). No stars:
   * a capstone is a pass or not yet.
   */
  solveCapstone(id: string, m: Measured = {}, rank?: (m: Measured) => number[]): { first: boolean; best: boolean } {
    const p = this.node(id);
    const first = p.status !== 'solved';
    const key = (x?: Measured) => (x && rank ? rank(x) : [x?.nand ?? Infinity, x?.period ?? Infinity, x?.cycles ?? Infinity]);
    const a = key(m), b = key(p.best);
    const i = a.findIndex((v, k) => v !== b[k]);
    const best = first || !p.best || (i >= 0 && a[i] < b[i]);
    p.status = 'solved';
    p.at = Date.now();
    if (best) p.best = m;
    this.save();
    return { first, best };
  }

  /**
   * A Verilog twin passed (campaign/verilog.ts): solved with its stars and NAND count, the best kept (more stars, then fewer
   * NANDs). Twins are optional and sit outside the map's summary, so nothing else reads them.
   */
  solveTwin(id: string, stars: 1 | 2 | 3, nand: number): { first: boolean; best: boolean } {
    const p = this.node(id);
    const first = p.status !== 'solved';
    const best = first || !p.stars || stars > p.stars || (stars === p.stars && nand < (p.best?.nand ?? Infinity));
    p.status = 'solved';
    p.at = Date.now();
    if (best) { p.stars = stars; p.best = { nand }; }
    this.save();
    return { first, best };
  }

  /** A measured design of the brief: kept newest first (at most MAX_SUBMISSIONS); the best grade is the node's stars. */
  addSubmission(id: string, sub: Omit<Submission, 'at'>): void {
    const p = this.node(id);
    p.subs = [{ ...sub, at: Date.now() }, ...(p.subs ?? [])].slice(0, MAX_SUBMISSIONS);
    p.stars = Math.max(p.stars ?? 1, sub.stars) as 1 | 2 | 3;
    this.save();
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
      // a lesson earns none (older saves may hold some)
      if (n.kind !== 'lesson') stars += p?.stars ?? 0;
    }
    return { done, required, requiredDone, stars, maxStars, playable };
  }
}

// ---- export / import -------------------------------------------------------------------------

/** The campaign as a file: progress plus the level chips and every chip they use. */
export function exportCampaign(st: CampaignState, ws: Workspace): string {
  const ids = [...NODES.map(levelChipId), ...CAPSTONES.map((c) => `u_ch_${c.id}`)].filter((id) => ws.chips[id]);
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
    if ((x.helped || y.helped) && p.stars === undefined) p.helped = true;
    else delete p.helped;
    if (!p.helped && !(x.helpKey ?? y.helpKey)) delete p.helpKey;
    const subs = [...(y.subs ?? []), ...(x.subs ?? [])].filter((q, i, a) => a.findIndex((r) => r.at === q.at) === i).sort((a, b) => b.at - a.at).slice(0, MAX_SUBMISSIONS);
    if (subs.length) p.subs = subs;
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
