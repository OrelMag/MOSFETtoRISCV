// Undo / redo over immutable states. A drag is one transaction: begin(), update() on every
// mouse move, commit() on release, so the whole drag is a single undo step (and cancel() on
// Escape puts back the state from before it). States are compared structurally, so a step that
// ends where it started (a drag back to the origin) leaves no entry.

/** Deep equality of JSON-like values; identical references short-circuit (structural sharing). */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => same(x, bb[i]));
  }
  // Keys holding undefined are absent in JSON, so they do not count.
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private cur: T;
  /** State at the outermost begin(); depth counts nested begin()s. */
  private base: T | null = null;
  private depth = 0;

  constructor(initial: T, private readonly cap = 200, private readonly eq: (a: T, b: T) => boolean = same) {
    this.cur = initial;
  }

  get current(): T {
    return this.cur;
  }
  get canUndo(): boolean {
    return this.past.length > 0 || (this.depth > 0 && !this.eq(this.cur, this.base as T));
  }
  get canRedo(): boolean {
    return this.depth === 0 && this.future.length > 0;
  }
  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /** A new undo step (inside a transaction: same as update). */
  push(next: T): void {
    if (this.depth) return void (this.cur = next);
    if (this.eq(next, this.cur)) return void (this.cur = next);
    this.record(this.cur);
    this.cur = next;
  }

  begin(): void {
    if (this.depth++ === 0) this.base = this.cur;
  }

  /** Inside a transaction: replaces the current state without a new step. Outside: push. */
  update(next: T): void {
    if (this.depth) this.cur = next;
    else this.push(next);
  }

  commit(): void {
    if (!this.depth || --this.depth) return;
    const base = this.base as T;
    this.base = null;
    if (!this.eq(base, this.cur)) this.record(base);
  }

  /** Abandons the whole transaction (all nesting levels): back to the state at the first begin. */
  cancel(): void {
    if (!this.depth) return;
    this.cur = this.base as T;
    this.base = null;
    this.depth = 0;
  }

  /** Steps back (an open transaction is committed first). Null when there is nothing to undo. */
  undo(): T | null {
    while (this.depth) this.commit();
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.cur);
    return (this.cur = prev);
  }

  redo(): T | null {
    if (this.depth) return null;
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.cur);
    return (this.cur = next);
  }

  /** Forgets all history (loading another workspace). */
  clear(state: T): void {
    this.past = [];
    this.future = [];
    this.base = null;
    this.depth = 0;
    this.cur = state;
  }

  private record(prev: T): void {
    this.past.push(prev);
    if (this.past.length > this.cap) this.past.splice(0, this.past.length - this.cap);
    this.future = [];
  }
}
