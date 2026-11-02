// The learner's path (DOM-free, tested in Node): where they chose to start, the chapters they tested out of, and the
// placement check's last result. Kept apart from settings.solved and the review memos on purpose: a placement answer
// or a test-out marks skills practised on My path, never a chapter's checks or the review queue. In the one-file backup
// (ui/backup.ts) as LEARN_KEY.

export const LEARN_KEY = 'mosfet2riscv:learn:v1';
const SCHEMA = 1;

export const PERSONAS = ['new', 'software', 'logic', 'hardware'] as const;
export type Persona = (typeof PERSONAS)[number];

export interface LearnState {
  schema: number;
  /** Where the learner chose to start, and when. */
  start?: { persona: Persona; tier: number; at: number };
  /** Chapter id → when it was tested out (every skill it teaches counts as practised). */
  tested: Record<string, number>;
  /** The placement check's last run. */
  placement?: { at: number; right: number; total: number; tier: number };
}

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }

export const emptyLearn = (): LearnState => ({ schema: SCHEMA, tested: {} });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const tierN = (v: unknown): v is number => v === 0 || v === 1 || v === 2 || v === 3 || v === 4;

export function sanitizeLearn(raw: unknown): LearnState {
  const st = emptyLearn();
  if (!isObj(raw)) return st;
  const s = raw.start;
  if (isObj(s) && PERSONAS.includes(s.persona as Persona) && tierN(s.tier) && time(s.at)) st.start = { persona: s.persona as Persona, tier: s.tier, at: s.at };
  if (isObj(raw.tested)) for (const [k, v] of Object.entries(raw.tested).slice(0, 200)) if (/^[\w-]{1,40}$/.test(k) && time(v)) st.tested[k] = v;
  const p = raw.placement;
  if (isObj(p) && time(p.at) && time(p.right) && time(p.total) && p.right <= p.total && p.total <= 50 && tierN(p.tier)) st.placement = { at: p.at, right: p.right, total: p.total, tier: p.tier };
  return st;
}

/** Two states as one: every test-out kept (the earlier time), the later start and placement. */
export function mergeLearn(a: LearnState, b: LearnState): LearnState {
  const out = emptyLearn();
  for (const [k, v] of [...Object.entries(a.tested), ...Object.entries(b.tested)]) out.tested[k] = Math.min(v, out.tested[k] ?? v);
  const later = <T extends { at: number }>(x?: T, y?: T) => (!x ? y : !y ? x : y.at > x.at ? y : x);
  const start = later(a.start, b.start), placement = later(a.placement, b.placement);
  if (start) out.start = start;
  if (placement) out.placement = placement;
  return out;
}

function defaultKV(): KV | null {
  try {
    return (globalThis as { localStorage?: KV }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** The state bound to a storage, with change listeners. */
export class Learn {
  state: LearnState;
  private subs = new Set<() => void>();
  constructor(private kv: KV | null = defaultKV()) {
    this.state = this.read();
  }
  private read(): LearnState {
    try {
      return sanitizeLearn(JSON.parse(this.kv?.getItem(LEARN_KEY) ?? 'null'));
    } catch {
      return emptyLearn();
    }
  }
  reload(): void {
    this.state = this.read();
    this.emit();
  }
  private save(): void {
    try { this.kv?.setItem(LEARN_KEY, JSON.stringify(this.state)); } catch { /* full or blocked: the session keeps it */ }
    this.emit();
  }
  private emit(): void { for (const f of this.subs) f(); }
  onChange(f: () => void): () => void {
    this.subs.add(f);
    return () => this.subs.delete(f);
  }
  setStart(persona: Persona, tier: number, now = Date.now()): void {
    this.state.start = { persona, tier: Math.max(0, Math.min(4, Math.round(tier))), at: now };
    this.save();
  }
  testOut(chapter: string, now = Date.now()): void {
    this.state.tested[chapter] ??= now;
    this.save();
  }
  untest(chapter: string): void {
    delete this.state.tested[chapter];
    this.save();
  }
  setPlacement(right: number, total: number, tier: number, now = Date.now()): void {
    this.state.placement = { at: now, right, total, tier };
    this.save();
  }
}

let shared: Learn | null = null;
export function learn(): Learn {
  return (shared ??= new Learn());
}
