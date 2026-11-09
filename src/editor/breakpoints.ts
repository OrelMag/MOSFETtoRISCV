// Breakpoints (DOM-free): a chip's ChipDoc.breaks checked against its simulation. A condition (breakexpr.ts) reads named
// signals: a pin, a pointer, `part.port`, or a path into placed chips (`cpu.rf.w5`, `alu1.y`), resolved again on every build
// (the nets are renumbered by each one). It is checked after every rising edge (EditorSim.edgeHooks); one that holds asks the
// run to stop (EditorSim.requestStop), which Run and runCycles do once the step is complete, as for a halt part.
// A PC breakpoint (`pc`) is the CPU drawer's: it holds when the instruction at that address retires (pcRetired).

import { type HierNode, findNode } from '../sim/flatten';
import { type Bit, netlistOf } from '../sim/types';
import { type BreakExpr, type BreakMemory, evalBreak, parseBreak } from './breakexpr';
import type { Compiled } from './compile';
import type { BreakDoc, ChipDoc } from './model';
import type { EditorSim } from './runtime';

/** What the list shows for one breakpoint. */
export interface BreakStatus {
  /** The condition does not parse (and where), or a name it reads is not in the circuit. */
  error?: string;
  /** Names it reads that this build has no signal for. */
  missing: string[];
  /** Times it held (a run stopped or not) since the chip was opened or powered on. */
  hits: number;
  /** The last check read an unknown bit (so it could not hold). */
  unknown: boolean;
  /** Flat nets it reads (lit on the circuit when it stops a run). */
  nets: number[];
}

/** A breakpoint's words in the run bar and the list. */
export const breakText = (b: BreakDoc): string => (b.pc !== undefined ? `pc == 0x${b.pc.toString(16)}` : (b.cond ?? '').trim());

/** The flat nets of a name in a design: a pin, a pointer, a named net, `part.port` or a path down to a port or named net. */
export function resolveName(name: string, doc: ChipDoc, built: Compiled, root: HierNode): readonly number[] | null {
  if (root.ports[name] && doc.pins.some((p) => p.name === name)) return root.ports[name];
  for (const l of doc.labels) {
    if (l.name !== name) continue;
    const n = built.netOfLabel.get(l.id);
    if (n !== undefined && n >= 0 && root.nets?.[n]) return root.nets[n];
  }
  const path = name.split('.');
  const last = path.pop()!;
  const node = findNode(root, path);
  if (!node) return null;
  if (path.length && node.ports[last]) return node.ports[last];
  const nl = netlistOf(node.def);
  const i = nl?.nets.findIndex((n) => n.name === last) ?? -1;
  return i >= 0 && node.nets?.[i] ? node.nets[i] : null;
}

interface Live { doc: BreakDoc; expr: BreakExpr | null; error?: string; mem: BreakMemory; nets: Map<string, readonly number[]>; status: BreakStatus }

/**
 * The breakpoints of the chip an EditorSim runs. `bind` after every build or edit of the list; `check` runs after every rising
 * edge on its own (the hook is added once, `dispose` removes it).
 */
export class Breakpoints {
  private live: Live[] = [];
  private hits = new Map<string, number>();
  private resets = -1;
  /** The breakpoint that stopped the run last (its id), until the next run. */
  stoppedBy: string | null = null;
  private readonly hook = { after: () => this.check('edge') };
  private readonly tick = () => this.check('tick');

  constructor(readonly sim: EditorSim) {
    sim.edgeHooks.add(this.hook);
    sim.tickHooks.add(this.tick);
  }

  dispose(): void {
    this.sim.edgeHooks.delete(this.hook);
    this.sim.tickHooks.delete(this.tick);
  }

  /** Resolve the chip's breakpoints against the simulation now (memories kept for a condition that did not change). */
  bind(doc: ChipDoc): void {
    const old = new Map(this.live.map((l) => [l.doc.id, l]));
    const built = this.sim.built, root = this.sim.sim?.design.root;
    this.live = (doc.breaks ?? []).map((b) => {
      const prev = old.get(b.id);
      const p = b.cond !== undefined ? parseBreak(b.cond) : null;
      const expr = p && !('error' in p) ? p : null;
      const error = p && 'error' in p ? `${p.error} (at ${p.at + 1})` : undefined;
      const nets = new Map<string, readonly number[]>();
      const missing: string[] = [];
      if (expr && built && root) for (const n of expr.names) { const r = resolveName(n, doc, built, root); if (r) nets.set(n, r); else missing.push(n); }
      const mem = prev && prev.doc.cond === b.cond ? prev.mem : [];
      return { doc: b, expr, error, mem, nets, status: { error, missing, hits: this.hits.get(b.id) ?? 0, unknown: false, nets: [...nets.values()].flat() } };
    });
  }

  /** Each breakpoint's status, by id. */
  status(id: string): BreakStatus | undefined {
    return this.live.find((l) => l.doc.id === id)?.status;
  }

  private count(l: Live): void {
    if (this.sim.resets !== this.resets) { this.resets = this.sim.resets; this.hits.clear(); for (const x of this.live) x.status.hits = 0; }
    const n = (this.hits.get(l.doc.id) ?? 0) + 1;
    this.hits.set(l.doc.id, n);
    l.status.hits = n;
    this.stoppedBy = l.doc.id;
    this.sim.requestStop(breakText(l.doc));
  }

  /**
   * After a rising edge, or after a gate delay in gate mode: every enabled condition checked at that grain, in list order
   * (each keeps its rose / fell memory, so all are evaluated). An "every change" breakpoint is checked after each gate delay
   * in gate mode (a run then stops between two edges) and after each edge in cycle mode.
   */
  check(at: 'edge' | 'tick' = 'edge'): void {
    const sim = this.sim.sim;
    if (!sim) return;
    const fine = this.sim.mode === 'gate';
    for (const l of this.live) {
      if (!l.expr || l.doc.off || (at === 'tick') !== (fine && !!l.doc.gate)) continue;
      const r = evalBreak(l.expr, (n) => { const nets = l.nets.get(n); return nets ? (sim.getBits(nets) as ArrayLike<Bit>) : null; }, l.mem);
      l.status.unknown = r.unknown;
      if (r.hit) this.count(l);
    }
  }

  /** The CPU drawer: the instruction at `pc` retired (PC breakpoints). */
  pcRetired(pc: number): void {
    for (const l of this.live) if (l.doc.pc === pc && !l.doc.off) this.count(l);
  }

  /** Is there a PC breakpoint at `pc` (enabled or not)? */
  pcBreak(pc: number): BreakDoc | undefined {
    return this.live.find((l) => l.doc.pc === pc)?.doc;
  }
}

/** A golden-model monitor as the CPU drawer has it: instructions retired since its reset, the latest of them last. */
export interface RetireLog { readonly retired: number; readonly log: readonly { pc: number }[] }

/**
 * Follows a monitor's retirements edge by edge (call it after each edge, after the monitor's own hook): each instruction
 * retired since the last call goes to `bp.pcRetired` by its listing row (`row`). With `bp` null (another chip shown) they
 * are only counted, so none is reported late.
 */
export function retireFollower(mon: RetireLog, row: (pc: number) => number = (pc) => pc): (bp: Breakpoints | null) => void {
  let seen = 0;
  return (bp) => {
    const r = mon.retired;
    if (r < seen) seen = 0;
    if (r > seen && bp) for (const e of mon.log.slice(-(r - seen))) bp.pcRetired(row(e.pc));
    seen = r;
  };
}
