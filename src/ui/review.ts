// The review queue's memory and schedule (DOM-free, tested in Node). Every multiple-choice question answered anywhere
// (a step's quiz, a recap's check, a codex entry's Check yourself: ui/quiz.ts quizBox) is logged under its settings.solved
// key: the first pick of a showing counts, right or wrong. Policy: right / wrong plus "Ask again soon", no ratings.
//   wrong          -> due now (the next session), streak 0
//   right          -> streak + 1, due in INTERVALS[streak - 1] days (2, 7, 21, 60)
//   Ask again soon -> due now, flagged, until the next answer
// The queue lists, among questions due: those last answered wrong, then the flagged ones, then the rest by how long
// since they were seen (never seen first). Questions come only from chapters the learner has visited (the codex's: once met).

import { moveKey, movedOf, STEP_MOVES } from '../chapters/stepmoves';

export const REVIEW_KEY = 'mosfet2riscv:review:v1';
const SCHEMA = 1;
export const DAY = 24 * 3600 * 1000;
export const INTERVALS_DAYS = [2, 7, 21, 60];
/** A question not seen for this long is "stale" in the summary line. */
export const STALE_DAYS = 14;

export interface Memo {
  /** Answers given. */
  n: number;
  /** When last answered (ms). */
  last: number;
  /** Was the last answer wrong? */
  miss?: boolean;
  /** When last answered wrong (ms), for "you missed this on …". */
  missed?: number;
  /** Right in a row. */
  streak: number;
  /** Due from this time (ms). */
  due: number;
  /** "Ask again soon" pressed since the last answer. */
  soon?: boolean;
}

export interface ReviewState {
  /** Batches of chapters/stepmoves.ts already applied to the keys. */
  moved?: number;
  schema: number;
  memos: Record<string, Memo>;
}

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }

export const emptyReview = (): ReviewState => ({ schema: SCHEMA, moved: STEP_MOVES.length, memos: {} });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function sanitizeReview(raw: unknown): ReviewState {
  const st = emptyReview();
  if (!isObj(raw) || !isObj(raw.memos)) return st;
  const since = movedOf(raw);
  for (const [k, v] of Object.entries(raw.memos).slice(0, 5000)) {
    if (k.length > 120 || !isObj(v) || !num(v.n) || !num(v.last) || !num(v.due) || !num(v.streak)) continue;
    const m: Memo = { n: Math.floor(v.n), last: v.last, streak: Math.floor(Math.min(v.streak, 1000)), due: v.due };
    if (v.miss === true) m.miss = true;
    if (num(v.missed)) m.missed = v.missed;
    if (v.soon === true) m.soon = true;
    st.memos[moveKey(k, since)] = m;
  }
  return st;
}

/** The memo after an answer at `now`. */
export function answered(prev: Memo | undefined, right: boolean, now: number): Memo {
  const n = (prev?.n ?? 0) + 1;
  if (!right) return { n, last: now, miss: true, missed: now, streak: 0, due: now };
  const streak = (prev?.streak ?? 0) + 1;
  const m: Memo = { n, last: now, streak, due: now + INTERVALS_DAYS[Math.min(streak, INTERVALS_DAYS.length) - 1] * DAY };
  if (prev?.missed) m.missed = prev.missed;
  return m;
}

/** "Ask again soon": due now and listed ahead of the plain ones, until it is answered. */
export function askSoon(prev: Memo | undefined, now: number): Memo {
  return { ...(prev ?? { n: 0, last: 0, streak: 0 }), soon: true, due: now };
}

/** Merge two states (the backup's rule): per question the one answered last wins; a flag with no answer since stays. */
export function mergeReview(a: ReviewState, b: ReviewState): ReviewState {
  const out = emptyReview();
  for (const [k, m] of [...Object.entries(a.memos), ...Object.entries(b.memos)]) {
    const had = out.memos[k];
    if (!had || m.last > had.last || (m.last === had.last && m.n > had.n)) out.memos[k] = m;
  }
  return out;
}

export interface Question {
  key: string;
  /** Where it is from, for the line above it. */
  origin: string;
  /** The step (or codex entry) to read. */
  href: string;
  /** The chapter id when from one (visited gate). */
  chapter?: string;
  /** Generated (learn/bank.ts): never seen, at most NEW_GENERATED of them in a queue, so they season the authored ones. */
  generated?: boolean;
}

/** New generated questions a queue may hold. */
export const NEW_GENERATED = 3;

export interface QueueOptions {
  now: number;
  /** Has the learner opened this chapter? */
  visited(chapter: string): boolean;
  limit?: number;
}

export interface QueueItem<Q extends Question> {
  q: Q;
  why: 'missed' | 'soon' | 'due' | 'new';
}

/** Which tier a question is in (0 first), or null when it is not asked now. */
function tier(q: Question, m: Memo | undefined, o: QueueOptions): number | null {
  if (q.chapter ? !o.visited(q.chapter) && !m : !m) return null;
  if (!m) return 2;
  if (m.miss && m.due <= o.now) return 0;
  if (m.soon) return 1;
  return m.due <= o.now ? 2 : null;
}

/** The questions to ask now, in order (see the file's header), at most `limit`. */
export function buildQueue<Q extends Question>(all: readonly Q[], st: ReviewState, o: QueueOptions): QueueItem<Q>[] {
  const rows: { q: Q; t: number; m?: Memo; i: number }[] = [];
  all.forEach((q, i) => {
    const m = st.memos[q.key];
    const t = tier(q, m, o);
    if (t !== null) rows.push({ q, t, m, i });
  });
  rows.sort((a, b) => a.t - b.t
    // misses: the oldest wrong first; the rest: unseen, then the longest unseen; ties keep the catalogue's order
    || (a.m?.last ?? 0) - (b.m?.last ?? 0) || a.i - b.i);
  const why = ['missed', 'soon', 'due'] as const;
  // new generated questions: at most NEW_GENERATED, every third place from the third, so a short session still meets one
  const fresh = rows.filter((r) => !r.m && r.q.generated).slice(0, NEW_GENERATED);
  const kept = rows.filter((r) => r.m || !r.q.generated);
  fresh.forEach((r, k) => kept.splice(Math.min(kept.length, 2 + 3 * k), 0, r));
  return kept.slice(0, o.limit ?? 12).map((r) => ({ q: r.q, why: r.m ? why[r.t] : 'new' }));
}

export interface Summary {
  /** Missed and not yet answered right. */
  missed: number;
  /** Not seen for STALE_DAYS (or never, in a chapter visited). */
  stale: number;
  /** Everything asked now (before the limit). */
  due: number;
}

export function summarize<Q extends Question>(all: readonly Q[], st: ReviewState, o: QueueOptions): Summary {
  const s: Summary = { missed: 0, stale: 0, due: 0 };
  for (const q of all) {
    const m = st.memos[q.key];
    const t = tier(q, m, o);
    if (t === null) continue;
    s.due++;
    if (t === 0) s.missed++;
    if (!m || o.now - m.last > STALE_DAYS * DAY) s.stale++;
  }
  return s;
}

const defaultKV = (): KV | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

export class ReviewLog {
  private st: ReviewState;

  constructor(private kv: KV | null = defaultKV(), private clock: () => number = Date.now) {
    try {
      this.st = sanitizeReview(JSON.parse(kv?.getItem(REVIEW_KEY) ?? 'null'));
    } catch {
      this.st = emptyReview();
    }
  }

  get state(): ReviewState {
    return this.st;
  }

  private save(): void {
    try { this.kv?.setItem(REVIEW_KEY, JSON.stringify(this.st)); } catch { /* not kept this time */ }
  }

  record(key: string, right: boolean): void {
    this.st.memos[key] = answered(this.st.memos[key], right, this.clock());
    this.save();
  }

  ask(key: string): void {
    this.st.memos[key] = askSoon(this.st.memos[key], this.clock());
    this.save();
  }

  replace(next: ReviewState): void {
    this.st = sanitizeReview(next);
    this.save();
  }
}

let shared: ReviewLog | null = null;
export function reviewLog(): ReviewLog {
  return shared ??= new ReviewLog();
}
