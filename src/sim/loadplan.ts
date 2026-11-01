// The phases of building a big scene (Stage.load) as data: which one is running, how long each took, how far the
// running one is, the bar's fraction and what is left. DOM-free; view/loadcard.ts draws it, tests/loadplan.test.ts
// pins the arithmetic.

export interface PhaseSpec {
  id: string;
  label: string;
  /** Its share of the bar (relative; from measuring chapter 34). */
  weight: number;
  /** How a running count reads after the label (done and total as shown); none: no count. */
  unit?: string;
}

export type PhaseState = 'todo' | 'active' | 'done';

export interface PhaseRow {
  id: string;
  label: string;
  state: PhaseState;
  /** Milliseconds a finished phase took. */
  ms?: number;
  /** The running phase's count, where it reports one. */
  done?: number;
  total?: number;
  unit?: string;
}

/** The phases Stage.load goes through for a scene too big to build between two frames. */
export const LOAD_PHASES: readonly PhaseSpec[] = [
  { id: 'hierarchy', label: 'Build the hierarchy', weight: 4 },
  { id: 'flatten', label: 'Flatten to 1-bit nets', weight: 58, unit: 'parts' },
  { id: 'engine', label: 'Power on and settle the simulation', weight: 16 },
  { id: 'draw', label: 'Route and draw the circuit', weight: 22 },
];

export class LoadPlan {
  private rows: PhaseRow[];
  private weights: number[];
  private cur = -1;
  private since = 0;
  private t0: number;

  constructor(specs: readonly PhaseSpec[] = LOAD_PHASES, private now: () => number = () => performance.now()) {
    this.rows = specs.map((s) => ({ id: s.id, label: s.label, state: 'todo', unit: s.unit }));
    this.weights = specs.map((s) => s.weight);
    this.t0 = this.since = now();
  }

  private index(id: string): number {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`no load phase '${id}'`);
    return i;
  }

  /** A phase that ran before the plan was made (building the hierarchy happens ahead of the stage), `ms` long. */
  completed(id: string, ms: number): void {
    const r = this.rows[this.index(id)];
    r.state = 'done';
    r.ms = ms;
    this.t0 -= ms;
  }

  /** Start phase `id`; the running one is finished at this moment (later phases not entered stay todo). */
  enter(id: string): void {
    const t = this.now();
    const i = this.index(id);
    if (this.cur >= 0) this.finishCurrent(t);
    this.cur = i;
    this.since = t;
    const r = this.rows[i];
    r.state = 'active';
    r.done = r.total = undefined;
  }

  private finishCurrent(t: number): void {
    const r = this.rows[this.cur];
    r.state = 'done';
    r.ms = t - this.since;
    r.done = r.total = undefined;
  }

  /** The running phase's count (`done` of `total`, the total an estimate: it never shows past 100 %). */
  report(done: number, total: number): void {
    if (this.cur < 0) return;
    const r = this.rows[this.cur];
    r.done = done;
    r.total = Math.max(total, done);
  }

  finish(): void {
    if (this.cur >= 0 && this.rows[this.cur].state === 'active') this.finishCurrent(this.now());
    this.cur = -1;
  }

  get phases(): readonly PhaseRow[] {
    return this.rows;
  }

  /** How much of the work is done, 0 to 1: finished phases by weight, the running one by its count. */
  get fraction(): number {
    let sum = 0, all = 0;
    this.rows.forEach((r, i) => {
      all += this.weights[i];
      if (r.state === 'done') sum += this.weights[i];
      else if (r.state === 'active' && r.done !== undefined && r.total) sum += this.weights[i] * Math.min(0.98, r.done / r.total);
    });
    return all ? sum / all : 0;
  }

  get elapsedMs(): number {
    return this.now() - this.t0;
  }

  /** Milliseconds left by extending the pace so far, or null while too little is done to say (or nothing is left). */
  etaMs(): number | null {
    const f = this.fraction;
    if (f < 0.12 || f >= 1) return null;
    const t = this.elapsedMs;
    return (t / f) * (1 - f);
  }
}

/** "256 000": groups of three, thin enough for a card. */
export const fmtCount = (n: number): string => Math.round(n).toLocaleString('en').replace(/,/g, ' ');

/** "0.3 s" / "12 s". */
export const fmtSeconds = (ms: number): string => `${ms < 9950 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)} s`;
