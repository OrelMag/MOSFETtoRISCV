// Build challenges (Turing Complete style): "make a chip with these pins that behaves like this,
// from these parts". The learner builds it in the sandbox like any chip; checkChallenge then
// drives it exhaustively (a truth table) or through a clocked sequence, checks the palette
// restriction on the compiled hierarchy, and scores it (NANDs, transistors, depth) against par.
// Every challenge carries a reference answer as chip documents (challengeset.ts). No DOM here.

import { BitSim } from '../sim/bitsim';
import { flatten, type FlatDesign } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import type { Sim } from '../sim/sim';
import { logicDepth, stats } from '../sim/stats';
import { SwitchSim } from '../sim/switchsim';
import { B0, B1, BZ, type Bit, type ComponentDef, netlistOf } from '../sim/types';
import type { Compiled } from './compile';
import { type ChipDoc, emptyChip, type PartDoc, type PinDoc, type Workspace } from './model';
import { openChip } from './session';
import { importChips } from './store';

export type Level = 'transistors' | 'gates' | 'arithmetic' | 'sequential' | 'memory' | 'cpu';

export const LEVELS: { id: Level; title: string }[] = [
  { id: 'transistors', title: 'Transistors' }, { id: 'gates', title: 'Gates from NAND' }, { id: 'arithmetic', title: 'Arithmetic' },
  { id: 'sequential', title: 'Sequential logic' }, { id: 'memory', title: 'Memory' }, { id: 'cpu', title: 'Towards a CPU' },
];

/** A pin of the chip to build. */
export interface PinSpec {
  name: string;
  dir: 'in' | 'out';
  width: number;
  /** Driven by the run loop (and by `tick` steps of a sequence). */
  clock?: boolean;
}

export interface SeqStep {
  /** Inputs to change before this step (the others keep their values). */
  set?: Record<string, number>;
  /** After setting: one clock cycle (rising edge, then falling edge). */
  tick?: boolean;
  /** Outputs that must hold these values after the step. */
  expect: Record<string, number>;
}

export type ChallengeCheck =
  /** Combinational: spec(inputs in port order) → outputs in port order, every input combination. */
  | { kind: 'table'; spec: (ins: number[]) => number[] }
  /** Sequential: inputs start at `init` (others 0), power on, then the steps in order. */
  | { kind: 'sequence'; init?: Record<string, number>; steps: SeqStep[] };

/**
 * What the chip may be built from. 'transistors': MOSFETs and rails; 'nand': NAND gates (and
 * anything below them); wiring, constants, displays and the learner's own chips (built from the
 * same) are always allowed. 'any': the whole library.
 */
export type Allowed = 'transistors' | 'nand' | 'any';

export interface Limits {
  maxNand?: number;
  maxTransistors?: number;
  /** Longest input → output path, in NAND delays (combinational chips). */
  maxDepth?: number;
}

export interface BuildChallenge {
  id: string;
  title: string;
  level: Level;
  /** HTML: short and precise. */
  brief: string;
  ports: PinSpec[];
  check: ChallengeCheck;
  allowed: Allowed;
  /** Par: shown next to the score, never required. */
  limits?: Limits;
  /** Parts placed in the new chip (e.g. a program ROM the challenge provides). */
  given?: PartDoc[];
  /** Reference solution: the chips it needs first, the answer itself last. */
  answer: () => ChipDoc[];
}

export interface Score {
  nand: number;
  transistors: number;
  /** null: sequential (feedback) or switch level. */
  depth: number | null;
}

export interface CheckResult {
  ok: boolean;
  /** Pin mismatches, compile errors, and the first failing vectors or steps. */
  failures: string[];
  score: Score;
  restrictionViolations: string[];
  /** Vectors (table) or steps (sequence) that were run. */
  tested: number;
  /** Table checks: the first failing input vector, by pin name (to put it on the canvas). */
  vector?: Record<string, number>;
}

/** Progress key in settings.solve(). */
export const solvedKey = (ch: BuildChallenge) => `sandbox:${ch.id}`;

export const challengeChipId = (ch: BuildChallenge) => `u_ch_${ch.id}`;

/** The challenge a chip was started for, if any. */
export function challengeOf(chipId: string, all: readonly BuildChallenge[]): BuildChallenge | undefined {
  return chipId.startsWith('u_ch_') ? all.find((c) => challengeChipId(c) === chipId) : undefined;
}

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/**
 * The challenge's chip, created with its pins in place (inputs on the left, outputs on the
 * right) and the brief in its notes, and opened. An existing one is only opened: the learner's
 * work is never replaced.
 */
export function startChallenge(ws: Workspace, ch: BuildChallenge): { ws: Workspace; chipId: string; created: boolean } {
  const id = challengeChipId(ch);
  if (ws.chips[id]) return { ws: openChip(ws, id), chipId: id, created: false };
  const ins = ch.ports.filter((p) => p.dir === 'in'), outs = ch.ports.filter((p) => p.dir === 'out');
  const right = Math.max(40, ...(ch.given ?? []).map((p) => p.at[0] + 24));
  const pins: PinDoc[] = [
    ...ins.map((p, i): PinDoc => ({ id: p.name, name: p.name, dir: 'in', width: p.width, at: [0, 2 + 4 * i], ...(p.clock ? { kind: 'clock' } : {}) })),
    ...outs.map((p, i): PinDoc => ({ id: p.name, name: p.name, dir: 'out', width: p.width, at: [right, 2 + 4 * i] })),
  ];
  const names = new Set(Object.values(ws.chips).map((c) => c.name));
  let name = ch.title;
  for (let i = 2; names.has(name); i++) name = `${ch.title} ${i}`;
  const doc: ChipDoc = { ...emptyChip(id, name), notes: `Challenge: ${stripHtml(ch.brief)}`, pins, parts: (ch.given ?? []).map((p) => ({ ...p })) };
  return { ws: openChip({ ...ws, chips: { ...ws.chips, [id]: doc } }, id), chipId: id, created: true };
}

// ---- checking --------------------------------------------------------------------------------

/** Most failing vectors / steps listed. */
const SHOW = 5;
/** Exhaustive up to this many input bits; random vectors above. */
const MAX_EXHAUSTIVE = 16;
const RANDOM_VECTORS = 4096;

const ZERO: Score = { nand: 0, transistors: 0, depth: null };

/** What a simulation run found. */
interface Run { failures: string[]; tested: number; vector?: Record<string, number> }

/** Check a compiled chip against a challenge. Never throws. */
export function checkChallenge(ch: BuildChallenge, compiled: Compiled | undefined): CheckResult {
  const res: CheckResult = { ok: false, failures: [], score: { ...ZERO }, restrictionViolations: [], tested: 0 };
  if (!compiled) {
    res.failures.push('nothing to check: the chip does not exist');
    return res;
  }
  try {
    const def = compiled.def;
    res.score = score(def, compiled.mode);
    res.restrictionViolations = violations(def, ch.allowed);
    const pinProblems = checkPins(def, ch.ports);
    const errors = compiled.diags.filter((d) => d.level === 'error').map((d) => `error: ${d.msg}`);
    res.failures.push(...pinProblems, ...errors.slice(0, 3));
    if (errors.length > 3) res.failures.push(`… and ${errors.length - 3} more errors`);
    if (!res.failures.length) {
      const r: Run = ch.check.kind === 'table'
        ? runTable(def, compiled.mode, ch.ports, ch.check.spec)
        : runSequence(def, compiled.mode, ch.ports, ch.check);
      res.failures.push(...r.failures);
      res.tested = r.tested;
      if (r.vector) res.vector = r.vector;
    }
  } catch (e) {
    res.failures.push(`cannot simulate: ${e instanceof Error ? e.message : String(e)}`);
  }
  res.ok = !res.failures.length && !res.restrictionViolations.length;
  return res;
}

function score(def: ComponentDef, mode: 'gate' | 'switch'): Score {
  let s = { nands: 0, transistors: 0 };
  try { s = stats(def); } catch { /* a broken part: no score */ }
  let depth: number | null = null;
  if (mode === 'gate') {
    try { depth = logicDepth(def); } catch { /* ditto */ }
  }
  return { nand: s.nands, transistors: s.transistors, depth };
}

function checkPins(def: ComponentDef, want: PinSpec[]): string[] {
  const out: string[] = [];
  for (const p of want) {
    const q = def.ports.find((x) => x.name === p.name);
    const kind = p.dir === 'in' ? 'input' : 'output';
    if (!q) out.push(`missing ${kind} pin '${p.name}'${p.width > 1 ? ` (${p.width} bits)` : ''}`);
    else if (q.dir !== p.dir) out.push(`pin '${p.name}' must be an ${kind}`);
    else if (q.width !== p.width) out.push(`pin '${p.name}' must be ${p.width} bit${p.width > 1 ? 's' : ''} wide (it is ${q.width})`);
  }
  for (const q of def.ports) {
    if (q.dir !== 'out' && !want.some((p) => p.name === q.name)) out.push(`unexpected input pin '${q.name}': the test drives only ${want.filter((p) => p.dir === 'in').map((p) => p.name).join(', ')}`);
  }
  return out;
}

/** Library parts allowed under every restriction: they cost nothing or are below the NAND. */
function allowedLeaf(d: ComponentDef, allowed: Allowed): string | null {
  if (d.prim === 'alias') return null; // splitters, mergers, displays
  if (d.prim === 'nmos' || d.prim === 'pmos' || d.prim === 'vdd' || d.prim === 'gnd') return null;
  if (d.id === 'tie0' || d.id === 'tie1' || d.id.startsWith('sb_const')) return null;
  if (d.prim === 'nand') return allowed === 'transistors' ? 'a library NAND: build it from transistors' : null;
  return `library part ${d.name}: ${allowed === 'nand' ? 'only NAND gates (and your chips built from them)' : 'only transistors (and your chips built from them)'}`;
}

const isUserChip = (d: ComponentDef) => d.category === 'custom' && d.id.startsWith('u_');

/** Parts the restriction forbids, anywhere in the hierarchy (each kind reported once). */
function violations(def: ComponentDef, allowed: Allowed): string[] {
  if (allowed === 'any') return [];
  const out: string[] = [];
  const seen = new Set<ComponentDef>();
  const walk = (d: ComponentDef, path: string[]) => {
    for (const inst of netlistOf(d)?.instances ?? []) {
      const c = inst.def;
      if (seen.has(c)) continue;
      seen.add(c);
      const where = [...path, inst.name];
      if (isUserChip(c)) walk(c, where);
      else {
        const why = allowedLeaf(c, allowed);
        if (why) out.push(`${where.join('.')}: ${why}`);
      }
    }
  };
  walk(def, []);
  return out;
}

// ---- simulation ------------------------------------------------------------------------------

const ins = (ports: PinSpec[]) => ports.filter((p) => p.dir === 'in');
const outs = (ports: PinSpec[]) => ports.filter((p) => p.dir === 'out');

const fmtNum = (v: number, w: number) => (w >= 8 ? `0x${v.toString(16).padStart(Math.ceil(w / 4), '0')}` : String(v));

function fmtBits(bits: Bit[]): string {
  const v = bits.every((b) => b === B0 || b === B1) ? bits.reduce((a: number, b, i) => a + b * 2 ** i, 0) : -1;
  if (v >= 0) return fmtNum(v, bits.length);
  const ch = (b: Bit) => (b === B1 ? '1' : b === B0 ? '0' : b === BZ ? 'Z' : 'X');
  if (bits.length === 1) return ch(bits[0]);
  return `0b${bits.map(ch).reverse().join('')}`;
}

const fmtIns = (ps: PinSpec[], vals: number[]) => ps.map((p, i) => `${p.name}=${fmtNum(vals[i], p.width)}`).join(' ');

function simFor(def: ComponentDef, mode: 'gate' | 'switch'): { sim: Sim; design: FlatDesign } {
  const design = flatten(def, { mode });
  return { sim: mode === 'switch' ? new SwitchSim(design) : new GateSim(design), design };
}

const readBits = (sim: Sim, port: string): Bit[] => sim.getBits(sim.design.root.ports[port]);

/** Vectors: every combination (first input port most significant), or random ones above 16 bits. */
function vectors(ps: PinSpec[]): number[][] {
  const total = ps.reduce((a, p) => a + p.width, 0);
  const split = (v: number) => {
    const r: number[] = [];
    for (let i = ps.length - 1; i >= 0; i--) {
      r[i] = v % 2 ** ps[i].width;
      v = Math.floor(v / 2 ** ps[i].width);
    }
    return r;
  };
  if (total <= MAX_EXHAUSTIVE) return Array.from({ length: 2 ** total }, (_, v) => split(v));
  let s = 0x9e3779b9;
  const rnd = (w: number) => {
    let v = 0;
    for (let b = 0; b < w; b += 16) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      v += ((s >>> 8) & 0xffff) * 2 ** b;
    }
    return v % 2 ** w;
  };
  return Array.from({ length: RANDOM_VECTORS }, () => ps.map((p) => rnd(p.width)));
}

function runTable(def: ComponentDef, mode: 'gate' | 'switch', ports: PinSpec[], spec: (ins: number[]) => number[]): Run {
  const I = ins(ports), O = outs(ports);
  const vs = vectors(I);
  const { sim, design } = simFor(def, mode);
  const failures: string[] = [];
  let bad = 0;
  let vector: Record<string, number> | undefined;
  const compare = (v: number[], got: Bit[][]) => {
    const want = spec(v);
    const wrong = O.map((p, k) => {
      const g = got[k];
      const ok = g.every((b, i) => b === (Math.floor(want[k] / 2 ** i) % 2 ? B1 : B0));
      return ok ? null : `${p.name}=${fmtBits(g)}`;
    });
    if (wrong.every((w) => w === null)) return;
    bad++;
    vector ??= Object.fromEntries(I.map((p, i) => [p.name, v[i]]));
    if (failures.length < SHOW) {
      failures.push(`${fmtIns(I, v)} → ${wrong.filter(Boolean).join(' ')}, expected ${O.map((p, k) => (wrong[k] ? `${p.name}=${fmtNum(want[k], p.width)}` : '')).filter(Boolean).join(' ')}`);
    }
  };
  // The event-driven simulator sees X and Z (an unconnected output, a short); once the first
  // vectors pass, an acyclic NAND netlist is swept 32 vectors at a time.
  const slow = (v: number[]) => {
    I.forEach((p, i) => sim.setInput(p.name, v[i]));
    sim.settle();
    if (sim.unstable) throw new Error(`it does not settle for ${fmtIns(I, v)} (it oscillates)`);
    compare(v, O.map((p) => readBits(sim, p.name)));
  };
  const head = Math.min(vs.length, 64);
  for (let k = 0; k < head; k++) slow(vs[k]);
  let rest = vs.slice(head);
  if (rest.length && !bad && mode === 'gate' && design.leaves.every((l) => l.kind === 'nand' || (l.kind === 'behavior' && !l.inputs.length))) {
    let bs: BitSim | null = null;
    try {
      bs = new BitSim(design);
    } catch { /* fall back to the event-driven simulator */ }
    if (bs && bs.acyclic) {
      for (let at = 0; at < rest.length; at += 32) {
        const batch = rest.slice(at, at + 32);
        I.forEach((p, i) => bs!.setInput(p.name, batch.map((v) => v[i])));
        bs.settle();
        const got = O.map((p) => bs!.get(p.name, batch.length));
        batch.forEach((v, l) => compare(v, O.map((p, k) => Array.from({ length: p.width }, (_, i) => (Math.floor(got[k][l] / 2 ** i) % 2) as Bit))));
      }
      rest = [];
    }
  }
  for (const v of rest) slow(v);
  if (bad > failures.length) failures.push(`… ${bad - failures.length} more of ${vs.length} rows wrong`);
  return { failures, tested: vs.length, ...(vector ? { vector } : {}) };
}

function runSequence(def: ComponentDef, mode: 'gate' | 'switch', ports: PinSpec[], check: Extract<ChallengeCheck, { kind: 'sequence' }>): Run {
  const I = ins(ports);
  const clk = I.find((p) => p.clock)?.name ?? 'clk';
  const { sim } = simFor(def, mode);
  const vals: Record<string, number> = Object.fromEntries(I.map((p) => [p.name, check.init?.[p.name] ?? 0]));
  for (const [k, v] of Object.entries(vals)) sim.setInput(k, v);
  sim.reset('zero');
  sim.settle();
  const failures: string[] = [];
  let bad = 0;
  const settle = (what: string) => {
    sim.settle();
    if (sim.unstable) throw new Error(`it does not settle (${what})`);
  };
  check.steps.forEach((st, k) => {
    for (const [p, v] of Object.entries(st.set ?? {})) {
      vals[p] = v;
      sim.setInput(p, v);
    }
    settle(`step ${k + 1}`);
    if (st.tick) {
      sim.setInput(clk, 1);
      settle(`rising edge, step ${k + 1}`);
      sim.setInput(clk, 0);
      settle(`falling edge, step ${k + 1}`);
    }
    const wrong = Object.entries(st.expect).flatMap(([p, want]) => {
      const g = readBits(sim, p);
      const ok = g.every((b, i) => b === (Math.floor(want / 2 ** i) % 2 ? B1 : B0));
      return ok ? [] : [[p, fmtBits(g), fmtNum(want, g.length)]];
    });
    if (!wrong.length) return;
    bad++;
    if (failures.length < SHOW) {
      const inputs = I.filter((p) => p.name !== clk || !st.tick).map((p) => `${p.name}=${fmtNum(vals[p.name], p.width)}`).join(' ');
      failures.push(`step ${k + 1}: ${inputs}${st.tick ? ', clock edge' : ''} → ${wrong.map(([p, g]) => `${p}=${g}`).join(' ')}, expected ${wrong.map(([p, , w]) => `${p}=${w}`).join(' ')}`);
    }
  });
  if (bad > failures.length) failures.push(`… ${bad - failures.length} more of ${check.steps.length} steps wrong`);
  return { failures, tested: check.steps.length };
}

// ---- answers ---------------------------------------------------------------------------------

/**
 * "Show answer": the reference chips imported as new chips (an identical chip already there is
 * reused, a different one with the same id is never touched: the import renames), the answer
 * itself opened. `main` is the id the answer ended up as.
 */
export function importAnswer(ws: Workspace, ch: BuildChallenge): { ws: Workspace; main: string; added: string[] } {
  const r = importChips(ch.answer(), ws);
  const main = r.order[r.order.length - 1];
  return { ws: openChip(r.ws, main), main, added: r.added };
}

/**
 * "Do it for me": the challenge chip's drawing replaced by the answer's (its id, name and notes
 * stay); the chips the answer places come in as by importAnswer. Starts the challenge if needed.
 */
export function solveChallenge(ws: Workspace, ch: BuildChallenge): { ws: Workspace; chipId: string; added: string[] } {
  const started = startChallenge(ws, ch);
  const id = started.chipId;
  const r = importChips(ch.answer(), started.ws);
  const mainId = r.order[r.order.length - 1];
  const main = r.ws.chips[mainId];
  const chips = { ...r.ws.chips };
  if (r.added.includes(mainId)) delete chips[mainId];
  const cur = chips[id];
  const { ff: _ff, ...rest } = cur;
  chips[id] = { ...rest, pins: main.pins, parts: main.parts, wires: main.wires, labels: main.labels, ...(main.ff ? { ff: { ...main.ff } } : {}) };
  return { ws: openChip({ ...r.ws, chips }, id), chipId: id, added: r.added.filter((a) => a !== mainId) };
}
