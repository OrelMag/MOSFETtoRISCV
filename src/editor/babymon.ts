// The Manchester Baby in the sandbox, DOM-free: a chip with a `baby` part (editor/babypart.ts; Examples > Manchester Baby). The
// golden model (ssem/iss.ts) runs in lock step through widgets/babymon.ts's BabyFollower: it steps at every edge that ends
// an instruction (the part's retire pin high just before it) and CI, A and the Stop lamp are compared there. The store is
// read from the tube's own state, so the listing shows what a line reads now: a line not rewritten for HOLD_BEATS beats
// has faded to dots. The model has no fading, so a run with REGEN off is followed, never checked (the hardware is right).

import { HOLD_BEATS, isTubeState, type TubeState, tubeWord } from '../lib/baby';
import type { HierNode } from '../sim/flatten';
import { pack } from '../sim/values';
import { assembleSsem } from '../ssem/asm';
import { disasm, fnOf, lineOf } from '../ssem/isa';
import { BabyFollower, type BabyHw } from '../widgets/babymon';
import type { Chips, Mismatch, MonitorSim, Retired } from './cpu';
import { partNode } from './cpu';
import type { ChipDoc } from './model';

export interface BabyDesc {
  /** The part's id on the chip. */
  part: string;
  /** Its program text. */
  src: string;
}

/** A baby part on the chip (the first), or null. */
export function detectBaby(doc: ChipDoc, _chips?: Chips): BabyDesc | null {
  for (const p of doc.parts) if ('baby' in p.ref) return { part: p.id, src: p.ref.baby.src };
  return null;
}

/** What the drawer shows: the machine now (-1: unknown). */
export interface BabyRead {
  /** The 32 lines as they read now (-1: X; a faded line reads 0) and the beats since each was last written. */
  store: number[];
  age: number[];
  ci: number; pi: number; a: number; t: number; beat: number; line: number; stop: number;
}

const PINS = ['ci', 'pi', 'a', 'beat', 't', 'stop', 'retire', 'line'] as const;
const BEATS = ['S1', 'A1', 'S2', 'A2'];
export const beatName = (b: number) => (b < 0 ? 'beat ?' : BEATS[b & 3]);

export class BabyMonitor {
  desc: BabyDesc | null = null;
  problem: string | null = null;
  mismatch: Mismatch | null = null;
  retired = 0;
  log: Retired[] = [];
  seq = 0;
  synced = false;
  /** REGEN was off at some edge of this run: the model does not fade, so it is followed, not checked. */
  fading = false;
  /** Lines fetched as instructions (the listing shows the rest as numbers). */
  readonly fetched = new Set<number>();
  private follower: BabyFollower | null = null;
  private words: number[] = [];
  private asmText = new Map<number, string>();
  private progKey = '';
  private resets = -1;
  private lastDoc: ChipDoc | null = null;
  private nodes: { root: unknown; node: HierNode | undefined; tube: number } = { root: null, node: undefined, tube: -1 };
  private prior: ReturnType<BabyFollower['iss']['save']> | null = null;
  private hook = { before: () => this.before(), after: () => this.after() };
  private static readonly LOG = 64;

  constructor(readonly es: MonitorSim, private doc: () => ChipDoc, private chips: () => Chips | undefined = () => undefined) {
    es.edgeHooks.add(this.hook);
    this.sync();
  }

  destroy(): void { this.es.edgeHooks.delete(this.hook); }

  /** Re-detect; restart on a reset or a new program ('program' mid-run: the caller resets). */
  sync(): 'program' | null {
    const doc = this.doc();
    if (doc === this.lastDoc && this.es.resets === this.resets) return null;
    this.lastDoc = doc;
    this.desc = detectBaby(doc, this.chips());
    const pk = this.desc?.src ?? '';
    const changed = !!this.progKey && pk !== this.progKey;
    if (changed || this.es.resets !== this.resets || !this.progKey) {
      this.progKey = pk;
      this.resets = this.es.resets;
      this.restart();
      return changed && this.es.cycles > 0 ? 'program' : null;
    }
    return null;
  }

  private restart(): void {
    this.mismatch = null;
    this.retired = 0;
    this.log.length = 0;
    this.seq++;
    this.fading = false;
    this.fetched.clear();
    this.synced = this.es.cycles === 0;
    this.follower = null;
    this.prior = null;
    this.asmText.clear();
    this.words = [];
    if (!this.desc) { this.problem = 'no Baby on this chip'; return; }
    const r = assembleSsem(this.desc.src);
    this.problem = r.errors.length ? `the program does not build: line ${r.errors[0].line}: ${r.errors[0].message}` : null;
    if (this.problem) return;
    this.words = r.words;
    for (const l of r.lines) this.asmText.set(l.line, l.text.replace(/\s+/g, ' '));
    this.follower = new BabyFollower(this.words);
  }

  private node(): HierNode | undefined {
    const sim = this.es.sim;
    if (!sim || !this.desc) return undefined;
    if (this.nodes.root !== sim.design.root) {
      let tube = -1;
      for (let i = 0; i < sim.design.leaves.length && tube < 0; i++) if (isTubeState(sim.leafState(i))) tube = i;
      this.nodes = { root: sim.design.root, node: partNode(sim, this.desc.part), tube };
    }
    return this.nodes.node;
  }

  private pin(name: string): number {
    const nets = this.node()?.ports[name], sim = this.es.sim;
    return nets && sim ? pack(sim.getBits(nets)) : -1;
  }

  private tube(): TubeState | null {
    this.node();
    const sim = this.es.sim, i = this.nodes.tube;
    const s = sim && i >= 0 ? sim.leafState(i) : null;
    return isTubeState(s) ? s : null;
  }

  private hw(): BabyHw | null {
    if (!this.node()) return null;
    const r = {} as Record<(typeof PINS)[number], number>;
    for (const p of PINS) r[p] = this.pin(p);
    return r;
  }

  get hasState(): boolean { return !!this.node()?.ports.ci && !!this.tube(); }

  get checking(): boolean { return !!this.follower && this.synced && !this.problem && !this.fading && this.hasState; }

  get iss() { return this.follower?.iss ?? null; }

  /** Why the model is not compared (null: it is, or it waits for a Reset). */
  get unchecked(): string | null {
    if (this.problem) return null;
    if (!this.hasState) return 'the Baby part is not simulated here';
    return this.fading ? 'REGEN is off: the store fades, which the golden model does not model; the lines are shown as the tube reads them' : null;
  }

  get done(): boolean { return !!this.mismatch || !!this.follower?.iss.halted || this.pin('stop') === 1; }

  read(): BabyRead | null {
    const t = this.tube();
    if (!t || !this.node()) return null;
    return {
      store: Array.from({ length: 32 }, (_, i) => tubeWord(t, i)), age: Array.from(t.age),
      ci: this.pin('ci'), pi: this.pin('pi'), a: this.pin('a'), t: this.pin('t'), beat: this.pin('beat'), line: this.pin('line'), stop: this.pin('stop'),
    };
  }

  /** Is the line's charge gone (it reads as dots)? */
  static faded(age: number): boolean { return age > HOLD_BEATS; }

  /** A store line as the listing writes it: the program's own statement while the word is unchanged, else the instruction if it was fetched, else its value. */
  rowText(line: number, word: number): string {
    if (word < 0) return '?';
    if (this.words[line] === word && this.asmText.has(line)) return this.asmText.get(line)!;
    if (this.fetched.has(line)) return disasm(word);
    return `NUM ${word | 0}`;
  }

  /** Changes when rowText may: a new fetch. */
  get rowKey(): string { return `${this.fetched.size}`; }

  private before(): void {
    if (!this.follower || this.problem || this.mismatch || !this.hasState) return;
    const hw = this.hw();
    if (!hw) return;
    if (this.pin('regen') === 0) this.fading = true;
    if (this.fading || !this.synced) return;
    this.follower.before(hw);
    this.prior = this.follower.iss.save();
  }

  private after(): void {
    const f = this.follower;
    if (!f || this.problem || this.mismatch || this.fading || !this.synced || !this.prior) return;
    const hw = this.hw();
    if (!hw) return;
    const was = this.prior;
    this.prior = null;
    if (!f.after(hw)) return;
    this.retired++;
    // the instruction the model just ran: at line CI + 1, as the model stood before the step
    const line = (was.ci + 1) & 31, word = was.store[line], fn = fnOf(word), s = lineOf(word);
    this.fetched.add(line);
    const iss = f.iss, eff: string[] = [];
    if (iss.ci !== was.ci + 1 && fn <= 1) eff.push(`CI ← ${iss.ci}`);
    if (iss.a !== was.a) eff.push(`A ← ${iss.a}`);
    if (fn === 3) eff.push(`line ${s} ← ${iss.store[s]}`);
    if (fn === 6 && iss.ci === was.ci + 2) eff.push('skip the next line');
    if (iss.halted) eff.push('Stop');
    this.seq++;
    this.log.push({ cycle: this.es.cycles, pc: line, text: `${line}: ${disasm(word)}`, effect: eff.join(', ') || '—' });
    if (this.log.length > BabyMonitor.LOG) this.log.shift();
    if (f.mismatch) {
      this.mismatch = { what: 'baby', name: 'Baby', expected: 0, got: 0, after: this.log.at(-1)!.text, cycle: this.es.cycles, detail: f.mismatch };
    }
  }

  runToHalt(budgetMs = 12, cap = 5_000_000): number {
    if (!this.checking) return 0;
    const left = cap - this.es.cycles;
    return left > 0 ? this.es.runCycles(left, () => this.done, budgetMs) : 0;
  }

  /** One instruction: clock until the model has retired another (four beats). */
  stepInstr(): number {
    const from = this.retired;
    return this.es.runCycles(8, () => this.done || this.retired > from);
  }
}
