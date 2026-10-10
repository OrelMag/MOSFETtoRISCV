// A level's solution walkthrough: the reference answer built on the canvas one step at a time,
// each step narrated, with its cost so far and how many truth-table rows each output already
// gets right. A step places one part (or, in a big reference, a group of like parts at the same
// dataflow rank) with the wiring that joins it to what is already there. Steps are authored
// (walks.ts) or generated in dataflow order from the input pins. "I'll take it from here" hands the
// learner partialDoc(walk, k). No DOM.

import { type BuildChallenge, type ChallengeCheck, type PinSpec, scoreOf, tableRows } from '../editor/challenges';
import { UserLibrary } from '../editor/library';
import {
  type ChipDoc, type DefOf, type EndRef, endKey, type LabelDoc, onSegment, orthogonal, type PartDoc, polyline, roundPt, SCHEMA,
  straightLine, type Vec, type WireDoc, type Workspace,
} from '../editor/model';
import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import type { Sim } from '../sim/sim';
import { SwitchSim } from '../sim/switchsim';
import { B0, B1, type Bit, type ComponentDef, netlistOf } from '../sim/types';
import { levelChallenge } from './levels';
import type { CampaignNode } from './types';
import { WALKS } from './walks';

export interface WalkScriptStep {
  title: string;
  text: string;
  /** Part ids of the main reference chip placed in this step. */
  parts: string[];
  codex?: string[];
}
export type WalkScript = WalkScriptStep[];

export interface WalkStep {
  title: string;
  /** One or a few plain sentences (no HTML). */
  text: string;
  /** Part ids placed in this step (wiring parts included: splitters, mergers, constants). */
  parts: string[];
  /** Wire ids this step adds, or reshapes (a trunk cut back to a branch earlier, now longer or whole). */
  wires: string[];
  /** Pointer (label) ids that appear in this step. */
  labels: string[];
  codex: string[];
  authored: boolean;
}

export interface Walk {
  nodeId: string;
  /** The reference answer: the chips it places first, the main chip last (as the challenge's answer()). */
  docs: ChipDoc[];
  main: ChipDoc;
  /** Parts the challenge places in the learner's chip from the start (a given ROM): in every partial doc, in no step. */
  given: string[];
  steps: WalkStep[];
}

/** More parts than this: like parts at the same rank are placed together. */
const GROUP_ABOVE = 12;
/** Most steps a generated walk aims for once grouped. */
const MAX_STEPS = 12;
/** Fewest steps a grouped walk is split into. */
const MIN_STEPS = 4;

const walks = new Map<string, Walk | null>();

/** The node's walkthrough (memoized), or undefined when it has no challenge. */
export function walkOf(node: CampaignNode): Walk | undefined {
  let w = walks.get(node.id);
  if (w === undefined) walks.set(node.id, (w = makeWalk(node) ?? null));
  return w ?? undefined;
}

/** A fresh walkthrough (not memoized): the authored script when there is one (or `script`; null: generated). */
export function makeWalk(node: CampaignNode, script: WalkScript | null = WALKS[node.id] ?? null): Walk | undefined {
  const ch = levelChallenge(node);
  if (!ch) return undefined;
  const docs = ch.answer();
  const main = docs[docs.length - 1];
  const g = analyze(docs, main, ch);
  const groups: { parts: string[]; title: string; text: string; codex: string[]; authored: boolean }[] = script
    ? script.map((s) => ({ parts: [...s.parts], title: s.title, text: s.text, codex: [...(s.codex ?? [])], authored: true }))
    : generate(g);
  // Wiring parts named by no step go with the step of the part they feed.
  const stepOf = new Map<string, number>();
  groups.forEach((s, i) => s.parts.forEach((p) => stepOf.set(p, i)));
  for (const p of g.wiring) {
    if (stepOf.has(p)) continue;
    const i = wiringStep(g, p, stepOf);
    stepOf.set(p, i);
    groups[i]?.parts.push(p);
  }
  if (!script && groups.length) groups[groups.length - 1].text += ' The circuit now matches the reference.';
  // The partial circuit after each step (index 0: before the first), and what each step adds or reshapes.
  const geo = wireGeometry(main, (p) => g.defs.get(p.id));
  const present = new Set(g.given);
  const partials: ChipDoc[] = [];
  // "This chip is a flip-flop" holds for the finished circuit only (compile tests it).
  const { ff: _ff, ...unfinished } = main;
  for (let k = -1; k < groups.length; k++) {
    groups[k]?.parts.forEach((p) => present.add(p));
    if (k === groups.length - 1) { partials.push(main); break; }
    const pw = partialWiring(main, geo, present);
    partials.push({ ...unfinished, parts: main.parts.filter((p) => present.has(p.id)), wires: pw.wires, labels: pw.labels });
  }
  const steps: WalkStep[] = groups.map((s, i) => {
    const before = partials[i], after = partials[i + 1];
    const old = new Map(before.wires.map((x) => [x.id, x])), oldL = new Map(before.labels.map((x) => [x.id, x]));
    return {
      title: s.title, text: s.text, parts: order(main, s.parts), codex: s.codex, authored: s.authored,
      wires: after.wires.filter((x) => !sameWire(old.get(x.id), x)).map((x) => x.id),
      labels: after.labels.filter((l) => !oldL.has(l.id)).map((l) => l.id),
    };
  });
  const w: Walk = { nodeId: node.id, docs, main, given: g.given, steps };
  partialsOf.set(w, partials);
  return w;
}

const sameWire = (a: WireDoc | undefined, b: WireDoc) => a === b || (!!a && JSON.stringify(a) === JSON.stringify(b));

/** Part ids in the document's order. */
const order = (doc: ChipDoc, ids: string[]): string[] => {
  const s = new Set(ids);
  return doc.parts.filter((p) => s.has(p.id)).map((p) => p.id);
};

const partialsOf = new WeakMap<Walk, ChipDoc[]>();

/**
 * The main chip after steps 0..k (k = -1: before the first step): every pin, the given parts and
 * those placed so far, and of each net the drawn wires that join what is present (a trunk whose
 * far end is still missing is cut back to its last branch; see partialWiring), with the pointers
 * they reach. At the last step it is the reference itself (the same arrays).
 */
export function partialDoc(w: Walk, k: number): ChipDoc {
  const ps = partialsOf.get(w);
  if (!ps) throw new Error('partialDoc: not a walk made by walkOf / makeWalk');
  return ps[Math.max(-1, Math.min(k, w.steps.length - 1)) + 1];
}

// ---- analysis of the reference -----------------------------------------------------------------

interface Graph {
  main: ChipDoc;
  defs: Map<string, ComponentDef>;
  /** Real parts (they cost or compute), in document order. */
  real: string[];
  /** Splitters, mergers, constants, rails, displays: they follow the parts they feed. */
  wiring: string[];
  given: string[];
  /** Real-part successors, wiring parts looked through. */
  succ: Map<string, string[]>;
  /** Per part input port: what feeds it, as names (pins, parts, constants). */
  feeds: Map<string, string[][]>;
  /** Per part: the output pins it drives (through wiring). */
  drives: Map<string, string[]>;
  /** Transistors: what the two channel ends connect to. */
  channel: Map<string, string[]>;
  docIndex: Map<string, number>;
  /** Wiring part → real consumers / producers (wiring looked through). */
  wireTo: Map<string, string[]>;
  wireFrom: Map<string, string[]>;
}

/** A library constant word (constW_hex). */
const LIB_CONST = /^const\d+_([0-9a-f]+)$/;

const isWiring = (p: PartDoc, d: ComponentDef | undefined): boolean => {
  const r = p.ref;
  if ('split' in r || 'merge' in r || 'const' in r || 'display' in r) return true;
  if (!d) return true;
  return d.prim === 'alias' || d.prim === 'vdd' || d.prim === 'gnd' || d.category === 'plumbing' || d.id === 'tie0' || d.id === 'tie1' || LIB_CONST.test(d.id) || d.id.startsWith('sb_const');
};

function analyze(docs: ChipDoc[], main: ChipDoc, ch: BuildChallenge): Graph {
  const lib = new UserLibrary(workspaceOf(docs));
  const c = lib.compiled(main.id);
  const nl = c && netlistOf(c.def);
  if (!c || !nl) throw new Error(`walk: ${main.id} does not compile`);
  const defs = new Map(nl.instances.map((i) => [i.name, i.def]));
  const docIndex = new Map(main.parts.map((p, i) => [p.id, i]));
  const givenIds = new Set((ch.given ?? []).map((p) => p.id));
  const given = main.parts.filter((p) => givenIds.has(p.id)).map((p) => p.id);
  // A reference of wiring alone (an immediate generator: bit fields regrouped) walks through its wiring.
  const wiringSet = new Set(main.parts.filter((p) => !givenIds.has(p.id) && isWiring(p, defs.get(p.id))).map((p) => p.id));
  if (wiringSet.size === main.parts.length - given.length) wiringSet.clear();
  const real = main.parts.filter((p) => !givenIds.has(p.id) && !wiringSet.has(p.id)).map((p) => p.id);

  // Nets: drivers (part outputs, input pins) and sinks (part inputs, output pins). Inouts are both.
  const pinDir = new Map(c.def.ports.map((p) => [p.name, p.dir]));
  type Drv = { part: string; port: string } | { pin: string };
  const drivers: Drv[][] = nl.nets.map(() => []);
  const sinks: ({ part: string; port: string } | { pin: string })[][] = nl.nets.map(() => []);
  const inNets = new Map<string, { port: string; net: number }[]>();
  const outNets = new Map<string, number[]>();
  nl.nets.forEach((net, ni) => {
    for (const e of net.ends) {
      const i = e.indexOf('.');
      if (i < 0) {
        const d = pinDir.get(e);
        if (d === 'in' || d === 'inout') drivers[ni].push({ pin: e });
        if (d === 'out' || d === 'inout') sinks[ni].push({ pin: e });
        continue;
      }
      const part = e.slice(0, i), port = e.slice(i + 1);
      const dir = defs.get(part)?.ports.find((p) => p.name === port)?.dir;
      if (dir === 'out' || dir === 'inout') {
        drivers[ni].push({ part, port });
        outNets.set(part, [...(outNets.get(part) ?? []), ni]);
      }
      if (dir === 'in' || dir === 'inout') {
        sinks[ni].push({ part, port });
        inNets.set(part, [...(inNets.get(part) ?? []), { port, net: ni }]);
      }
    }
  });

  // Real consumers of a wiring part, and real producers, looking through other wiring parts.
  const through = (start: string, dirOut: boolean): string[] => {
    const out = new Set<string>(), seen = new Set([start]), todo = [start];
    while (todo.length) {
      const p = todo.pop()!;
      const nets = dirOut ? outNets.get(p) ?? [] : (inNets.get(p) ?? []).map((x) => x.net);
      for (const ni of nets) {
        for (const e of dirOut ? sinks[ni] : drivers[ni]) {
          if (!('part' in e) || seen.has(e.part)) continue;
          seen.add(e.part);
          if (wiringSet.has(e.part)) todo.push(e.part);
          else if (!givenIds.has(e.part)) out.add(e.part);
        }
      }
    }
    return [...out].sort((a, b) => docIndex.get(a)! - docIndex.get(b)!);
  };
  const wireTo = new Map([...wiringSet].map((p) => [p, through(p, true)]));
  const wireFrom = new Map([...wiringSet].map((p) => [p, through(p, false)]));
  const succ = new Map(real.map((p) => [p, through(p, true)]));

  // Names of what feeds a net: a pin, a part, a constant; a splitter's output names the bits it takes.
  const nameOfNet = (ni: number, depth = 0): string[] => {
    const out: string[] = [];
    for (const d of drivers[ni]) {
      if ('pin' in d) { out.push(d.pin); continue; }
      const pd = main.parts.find((p) => p.id === d.part)!;
      const def = defs.get(d.part);
      const r = pd.ref;
      if ('const' in r) out.push(`constant ${r.const.value}`);
      else if (def?.prim === 'vdd') out.push('VDD');
      else if (def?.prim === 'gnd') out.push('GND');
      else if (def?.id === 'tie0' || def?.id === 'tie1') out.push(`constant ${def.id === 'tie1' ? 1 : 0}`);
      else if (def && LIB_CONST.test(def.id)) out.push(`constant ${parseInt(LIB_CONST.exec(def.id)![1], 16)}`);
      else if ((wiringSet.has(d.part) || 'split' in r) && depth < 8) {
        const src = (inNets.get(d.part) ?? []).flatMap((x) => nameOfNet(x.net, depth + 1));
        if ('split' in r && src.length === 1 && /^o\d+$/.test(d.port)) {
          const k = +d.port.slice(1), w = r.split[k];
          // Bits of bits (a splitter on a splitter's field) count from the outer field's low bit.
          const m = /^(.*)\[(\d+)(?::(\d+))?\]$/.exec(src[0]);
          const base = m ? m[1] : src[0], off = r.split.slice(0, k).reduce((a, b) => a + b, 0) + (m ? +(m[3] ?? m[2]) : 0);
          out.push(`${base}[${w === 1 ? off : `${off + w - 1}:${off}`}]`);
        } else out.push(...src);
      } else {
        const outs = (def?.ports ?? []).filter((p) => p.dir === 'out');
        out.push(outs.length > 1 ? `${d.part}.${d.port}` : d.part);
      }
    }
    return out;
  };
  const feeds = new Map(real.map((p) => {
    const ins = (defs.get(p)?.ports ?? []).filter((q) => q.dir === 'in' || q.dir === 'inout');
    return [p, ins.map((q) => [...new Set((inNets.get(p) ?? []).filter((x) => x.port === q.name).flatMap((x) => nameOfNet(x.net)))])];
  }));
  const pinsOut = (nets: number[]): string[] => {
    const out = new Set<string>(), seen = new Set<string>(), todo = [...nets];
    while (todo.length) {
      const ni = todo.pop()!;
      for (const e of sinks[ni]) {
        if ('pin' in e) { if (pinDir.get(e.pin) === 'out') out.add(e.pin); continue; }
        if (wiringSet.has(e.part) && !seen.has(e.part)) { seen.add(e.part); todo.push(...(outNets.get(e.part) ?? [])); }
      }
    }
    return [...out];
  };
  const drives = new Map(real.map((p) => [p, pinsOut(outNets.get(p) ?? [])]));
  // A transistor's channel ends: what else is on each net (a pin, else a rail, else other parts).
  const channel = new Map<string, string[]>();
  for (const p of real) {
    const prim = defs.get(p)?.prim;
    if (prim !== 'nmos' && prim !== 'pmos') continue;
    channel.set(p, (inNets.get(p) ?? []).filter((x) => x.port !== 'g').map((x) => {
      const others = [...drivers[x.net], ...sinks[x.net]].filter((e) => !('part' in e) || e.part !== p);
      const pinsOn = others.flatMap((e) => ('pin' in e ? [e.pin] : []));
      const rails = others.flatMap((e) => ('part' in e && (defs.get(e.part)?.prim === 'vdd' || defs.get(e.part)?.prim === 'gnd') ? [defs.get(e.part)!.prim!.toUpperCase()] : []));
      const parts = others.flatMap((e) => ('part' in e ? [e.part] : []));
      return list([...new Set(pinsOn.length ? pinsOn : rails.length ? rails : parts)]) || 'nothing yet';
    }));
  }
  return { main, defs, real, wiring: [...wiringSet], given, succ, feeds, drives, channel, docIndex, wireTo, wireFrom };
}

const workspaceOf = (docs: ChipDoc[]): Workspace =>
  ({ schema: SCHEMA, chips: Object.fromEntries(docs.map((d) => [d.id, d])), open: [docs[docs.length - 1].id] });

/**
 * Dataflow ranks: depth-first from the parts the input pins feed (pin order, then document order)
 * marks the edges that close a loop (a latch's cross-coupling); the longest path over the rest.
 */
function ranks(g: Graph): Map<string, number> {
  const idx = g.docIndex;
  const byDoc = (a: string, b: string) => idx.get(a)! - idx.get(b)!;
  const pinFed = (p: string) => g.feeds.get(p)!.some((ns) => ns.some((n) => g.main.pins.some((q) => q.dir !== 'out' && (n === q.name || n.startsWith(`${q.name}[`)))));
  const roots = [...g.real.filter(pinFed), ...g.real];
  const state = new Map<string, 1 | 2>(); // 1: on the stack, 2: done
  const back = new Set<string>();
  for (const r of roots) {
    if (state.has(r)) continue;
    const stack: { p: string; next: string[]; i: number }[] = [{ p: r, next: [...g.succ.get(r)!].sort(byDoc), i: 0 }];
    state.set(r, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i === top.next.length) { state.set(top.p, 2); stack.pop(); continue; }
      const q = top.next[top.i++];
      const s = state.get(q);
      if (s === 1) back.add(`${top.p}>${q}`);
      else if (s === undefined) { state.set(q, 1); stack.push({ p: q, next: [...g.succ.get(q)!].sort(byDoc), i: 0 }); }
    }
  }
  // Longest path (Kahn over the forward edges).
  const indeg = new Map(g.real.map((p) => [p, 0]));
  for (const p of g.real) for (const q of g.succ.get(p)!) if (!back.has(`${p}>${q}`)) indeg.set(q, indeg.get(q)! + 1);
  const rank = new Map(g.real.map((p) => [p, 0]));
  const queue = g.real.filter((p) => indeg.get(p) === 0);
  for (let h = 0; h < queue.length; h++) {
    const p = queue[h];
    for (const q of g.succ.get(p)!) {
      if (back.has(`${p}>${q}`)) continue;
      rank.set(q, Math.max(rank.get(q)!, rank.get(p)! + 1));
      indeg.set(q, indeg.get(q)! - 1);
      if (indeg.get(q) === 0) queue.push(q);
    }
  }
  return rank;
}

// ---- generated steps ---------------------------------------------------------------------------

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const count = (n: number) => WORDS[n] ?? String(n);
const GATE = /^(nand|and|or|nor|xor|xnor|not)\d*$/;
/** Acronyms read as words (a NAND, a RAM), not letter by letter. */
const WORDLIKE = /^(NAND|NOR|NOT|RAM|ROM|MUX|LED|CAM|FIFO|LUT|SRAM|DRAM)\b/;

/** A name in running text: a capitalized first word lower-cased (an acronym or a single letter kept). */
const inText = (name: string) => (/^[A-Z][a-z]/.test(name) ? name[0].toLowerCase() + name.slice(1) : name);

function article(name: string): string {
  if (WORDLIKE.test(name)) return 'a';
  if (/^[A-Z]{2,}|^[A-Z]\d|^[A-Z]\b/.test(name)) return /^[AEFHILMNORSX]/.test(name) ? 'an' : 'a';
  if (/^(8|11|18)/.test(name)) return 'an';
  return /^[aeiouAEIOU]/.test(name) ? 'an' : 'a';
}

/** Plural of a part name; a trailing parenthesis stays after the noun ("pipeline registers (16-bit)"). */
function plural(s: string): string {
  const m = /^(.*?)(\s*\(.*\))?$/.exec(s)!;
  return `${/(s|x|ch|sh)$/i.test(m[1]) ? `${m[1]}es` : `${m[1]}s`}${m[2] ?? ''}`;
}

function list(xs: string[], max = 4): string {
  const ys = xs.length > max ? [...xs.slice(0, max - 1), `${xs.length - max + 1} more`] : xs;
  return ys.length <= 1 ? ys.join('') : `${ys.slice(0, -1).join(', ')} and ${ys[ys.length - 1]}`;
}

/**
 * A part's type: its key (to group like parts), its name (library name, or the chip's name) and that
 * name in running text (a chip's name is a proper name: its case is kept).
 */
function typeOf(g: Graph, id: string): { key: string; name: string; text: string } {
  const p = g.main.parts.find((q) => q.id === id)!;
  const d = g.defs.get(id);
  if ('chip' in p.ref) {
    const name = (d?.name ?? p.ref.chip).replace(/ ref$/, '');
    return { key: `chip:${p.ref.chip}`, name, text: name };
  }
  const name = d?.name ?? id;
  return { key: 'lib' in p.ref ? `lib:${p.ref.lib}` : JSON.stringify(p.ref), name, text: inText(name) };
}

function describe(g: Graph, id: string): string {
  const t = typeOf(g, id);
  const ports = g.feeds.get(id)!;
  const names = [...new Set(ports.flat())];
  const isGate = GATE.test(g.defs.get(id)?.id ?? '');
  let src = '';
  if (names.length === 1 && ports.length > 1 && ports.every((p) => p.length === 1)) src = ` with ${ports.length === 2 ? 'both inputs' : 'every input'} on ${names[0]}`;
  else if (names.length) src = `${isGate ? ' of' : ' fed by'} ${list(names)}`;
  const drv = g.drives.get(id)!;
  const ch = g.channel.get(id);
  if (ch) return `Adds ${id}, ${article(t.name)} ${t.text}: gate on ${list(ports[0] ?? []) || 'nothing yet'}, channel between ${ch.join(' and ')}.`;
  return `Adds ${id}, ${article(t.name)} ${t.text}${src}${drv.length ? `; it drives ${list(drv)}` : ''}.`;
}

function generate(g: Graph): { parts: string[]; title: string; text: string; codex: string[]; authored: boolean }[] {
  const rank = ranks(g);
  const pos = (id: string) => g.main.parts.find((p) => p.id === id)!.at;
  const sorted = [...g.real].sort((a, b) => rank.get(a)! - rank.get(b)! || pos(a)[1] - pos(b)[1] || pos(a)[0] - pos(b)[0] || g.docIndex.get(a)! - g.docIndex.get(b)!);
  let groups: string[][];
  if (sorted.length <= GROUP_ABOVE) groups = sorted.map((p) => [p]);
  else {
    // Like parts at the same rank together; then, if still long, runs of one type across ranks.
    const by = new Map<string, string[]>();
    for (const p of sorted) {
      const k = `${rank.get(p)}|${typeOf(g, p).key}`;
      by.set(k, [...(by.get(k) ?? []), p]);
    }
    groups = [...by.values()];
    if (groups.length > MAX_STEPS) {
      const runs: string[][] = [];
      for (const gr of groups) {
        const last = runs[runs.length - 1];
        if (last && typeOf(g, last[0]).key === typeOf(g, gr[0]).key) last.push(...gr);
        else runs.push([...gr]);
      }
      groups = runs;
    }
    if (groups.length > MAX_STEPS) {
      // Contiguous chunks of about equal part counts, never splitting a group.
      const total = sorted.length, chunks: string[][] = [];
      let cur: string[] = [];
      for (const gr of groups) {
        cur.push(...gr);
        if (cur.length >= total / MAX_STEPS && chunks.length < MAX_STEPS - 1) { chunks.push(cur); cur = []; }
      }
      if (cur.length) chunks.push(cur);
      groups = chunks;
    }
    // A wide level of like parts side by side (sixteen multiplexers at rank 0) would be one step:
    // halve the biggest group until there are a few.
    while (groups.length < MIN_STEPS) {
      let big = 0;
      groups.forEach((gr, i) => { if (gr.length > groups[big].length) big = i; });
      const gr = groups[big];
      if (gr.length < 2) break;
      groups.splice(big, 1, gr.slice(0, Math.ceil(gr.length / 2)), gr.slice(Math.ceil(gr.length / 2)));
    }
  }
  const ofType = new Map<string, number>();
  for (const p of g.real) ofType.set(typeOf(g, p).key, (ofType.get(typeOf(g, p).key) ?? 0) + 1);
  return groups.map((parts) => {
    if (parts.length === 1) {
      const t = typeOf(g, parts[0]);
      return { parts, title: `${t.name} ${parts[0]}`, text: describe(g, parts[0]), codex: [], authored: false };
    }
    const types = new Map<string, { name: string; text: string; ids: string[] }>();
    for (const p of parts) {
      const t = typeOf(g, p);
      types.set(t.key, { name: t.name, text: t.text, ids: [...(types.get(t.key)?.ids ?? []), p] });
    }
    const ids = order(g.main, parts);
    const drv = [...new Set(parts.flatMap((p) => g.drives.get(p)!))];
    const tail = drv.length ? ` They drive ${list(drv)}.` : '';
    if (types.size === 1) {
      const t = [...types.values()][0];
      const all = ofType.get(typeOf(g, parts[0]).key) === parts.length;
      return { parts, title: `${parts.length} × ${t.name}`, text: `Places ${all ? 'the ' : ''}${count(parts.length)} ${plural(t.text)}: ${list(ids, 6)}.${tail}`, codex: [], authored: false };
    }
    const mix = [...types.values()].map((t) => `${count(t.ids.length)} ${t.ids.length > 1 ? plural(t.text) : t.text}`);
    return { parts, title: `${parts.length} parts`, text: `Places ${count(parts.length)} parts: ${list(mix, 5)}.${tail}`, codex: [], authored: false };
  });
}

/** A wiring part's step: the first step that places a part it feeds, else the last that places one feeding it. */
function wiringStep(g: Graph, p: string, stepOf: Map<string, number>): number {
  const to = g.wireTo.get(p)!.map((q) => stepOf.get(q)).filter((x): x is number => x !== undefined);
  if (to.length) return Math.min(...to);
  const from = g.wireFrom.get(p)!.map((q) => stepOf.get(q)).filter((x): x is number => x !== undefined);
  return from.length ? Math.max(...from) : 0;
}

// ---- partial wiring ----------------------------------------------------------------------------
//
// A reference draws a net as a tree of wires: a trunk from its topmost end to its bottommost, the
// other ends branching off it. Before the trunk's far end is placed the parts already there still
// need it, so a partial circuit keeps, of every net, the drawn segments that join what is present
// (the tree pruned of the leaves that are missing), and re-expresses them as wires: a trunk cut back
// to its last branch takes that branch's line as its continuation. Pins and pointers always count as
// present; a part, once placed.

interface Geo {
  lines: Map<string, Vec[]>;
  /** Arc length at each vertex of a line. */
  cum: Map<string, number[]>;
}

function wireGeometry(main: ChipDoc, defOf: DefOf): Geo {
  const lines = new Map<string, Vec[]>(), cum = new Map<string, number[]>();
  for (const w of main.wires) {
    const l = polyline(main, w, defOf);
    if (!l) continue;
    const c = [0];
    for (let i = 1; i < l.length; i++) c.push(c[i - 1] + Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]));
    lines.set(w.id, l);
    cum.set(w.id, c);
  }
  return { lines, cum };
}

const EPS = 1e-6;

/** Arc length along a wire's line of a point on it (-1: off it). */
function paramOf(geo: Geo, id: string, p: Vec): number {
  const l = geo.lines.get(id), c = geo.cum.get(id);
  if (!l || !c) return -1;
  if (l.length === 1) return 0;
  for (let i = 1; i < l.length; i++) if (onSegment(l[i - 1], l[i], p)) return c[i - 1] + Math.hypot(p[0] - l[i - 1][0], p[1] - l[i - 1][1]);
  return -1;
}

/** The stretch of a line between two arc lengths. */
function subLine(l: Vec[], c: number[], s0: number, s1: number): Vec[] {
  const at = (s: number): Vec => {
    for (let i = 1; i < l.length; i++) {
      if (s > c[i] + EPS) continue;
      const t = c[i] === c[i - 1] ? 0 : (s - c[i - 1]) / (c[i] - c[i - 1]);
      return roundPt([l[i - 1][0] + t * (l[i][0] - l[i - 1][0]), l[i - 1][1] + t * (l[i][1] - l[i - 1][1])]);
    }
    return l[l.length - 1];
  };
  return [at(s0), ...l.filter((_, i) => c[i] > s0 + EPS && c[i] < s1 - EPS), at(s1)];
}

type KEnd = { ref: EndRef; node: string } | { open: string };
interface KWire { id: string; line: Vec[]; a: KEnd; b: KEnd; changed: boolean }

function partialWiring(main: ChipDoc, geo: Geo, present: Set<string>): { wires: WireDoc[]; labels: LabelDoc[] } {
  const byId = new Map(main.wires.filter((w) => geo.lines.has(w.id)).map((w) => [w.id, w]));
  const len = (id: string) => geo.cum.get(id)!.at(-1)!;
  // Graph nodes: a wire's end on a part port, pin or pointer ('t:'), or a point where wires join ('j:').
  const nodeAt = (id: string, s: number, depth: number): string => {
    const w = byId.get(id)!;
    if (s <= EPS) return endNode(w.a, depth + 1);
    if (s >= len(id) - EPS) return endNode(w.b, depth + 1);
    return `j:${id}:${Math.round(s * 1e4)}`;
  };
  const endNode = (e: EndRef, depth = 0): string => {
    if (!('wire' in e)) return `t:${endKey(e)}`;
    if (depth > 64 || !byId.has(e.wire)) return `x:${endKey(e)}`;
    return nodeAt(e.wire, Math.max(0, paramOf(geo, e.wire, e.at)), depth);
  };
  // Edges: each wire cut at the points where others branch off it.
  const cuts = new Map<string, number[]>([...byId.keys()].map((id) => [id, [0, len(id)]]));
  for (const w of byId.values()) {
    for (const e of [w.a, w.b]) if ('wire' in e && cuts.has(e.wire)) cuts.get(e.wire)!.push(Math.max(0, paramOf(geo, e.wire, e.at)));
  }
  const edges: { w: string; s0: number; s1: number; a: string; b: string }[] = [];
  for (const [id, ss] of cuts) {
    const u = [...ss].sort((x, y) => x - y).filter((s, i, a) => i === 0 || s - a[i - 1] > EPS);
    for (let i = 1; i < u.length; i++) edges.push({ w: id, s0: u[i - 1], s1: u[i], a: nodeAt(id, u[i - 1], 0), b: nodeAt(id, u[i], 0) });
  }
  // Prune: a missing part's port goes with every wire on it (wires meeting at a port do not touch
  // without the part), then, repeatedly, the leaves that are not present.
  const keep = (n: string) => {
    if (!n.startsWith('t:')) return false;
    const k = n.slice(2);
    return k.startsWith('pin:') || k.startsWith('lbl:') || (k.startsWith('p:') && present.has(k.slice(2, k.indexOf('.'))));
  };
  const adj = new Map<string, Set<number>>();
  edges.forEach((e, i) => { for (const n of [e.a, e.b]) (adj.get(n) ?? adj.set(n, new Set()).get(n)!).add(i); });
  const alive = new Set(edges.keys());
  const queue: string[] = [];
  const drop = (i: number) => {
    const e = edges[i];
    alive.delete(i);
    for (const n of [e.a, e.b]) {
      const es = adj.get(n)!;
      es.delete(i);
      if (es.size === 1 && !keep(n)) queue.push(n);
    }
  };
  for (const [n, es] of adj) if (!n.startsWith('j:') && !keep(n)) [...es].forEach(drop);
  for (const [n, es] of adj) if (es.size === 1 && !keep(n)) queue.push(n);
  while (queue.length) {
    const es = adj.get(queue.pop()!)!;
    if (es.size === 1) drop(es.values().next().value!);
  }
  // What is left of each wire: one stretch of its line.
  const range = new Map<string, [number, number]>();
  for (const i of alive) {
    const e = edges[i], r = range.get(e.w);
    range.set(e.w, r ? [Math.min(r[0], e.s0), Math.max(r[1], e.s1)] : [e.s0, e.s1]);
  }
  const kws = new Map<string, KWire>();
  for (const w of main.wires) {
    const r = range.get(w.id);
    if (!r) continue;
    const L = len(w.id), full0 = r[0] <= EPS, full1 = r[1] >= L - EPS;
    kws.set(w.id, {
      id: w.id, changed: !(full0 && full1),
      line: full0 && full1 ? geo.lines.get(w.id)! : subLine(geo.lines.get(w.id)!, geo.cum.get(w.id)!, r[0], r[1]),
      a: full0 ? { ref: w.a, node: endNode(w.a) } : { open: nodeAt(w.id, r[0], 0) },
      b: full1 ? { ref: w.b, node: endNode(w.b) } : { open: nodeAt(w.id, r[1], 0) },
    });
  }
  // A branch off a wire that is gone entirely (both its ends missing) is open at that junction too.
  const sides = ['a', 'b'] as const;
  for (const k of kws.values()) {
    for (const s of sides) {
      const e = k[s];
      if ('ref' in e && 'wire' in e.ref && !kws.has(e.ref.wire)) k[s] = { open: e.node };
    }
  }
  // A wire cut back to a junction continues along a branch that leaves it there: merge the two.
  // Two branches of a vanished wire meet at their junction: merge them, and hang any third one there.
  const owner = new Map([...kws.keys()].map((id) => [id, id]));
  const rehost = new Map<string, { wire: string; at: Vec }>();
  for (let again = true; again;) {
    again = false;
    for (const k of kws.values()) {
      const side = sides.find((s) => 'open' in k[s]);
      if (!side) continue;
      const node = (k[side] as { open: string }).open;
      const host = rehost.get(node);
      if (host) {
        k[side] = { ref: { wire: host.wire, at: host.at }, node };
        k.changed = again = true;
        break;
      }
      const find = (test: (e: KEnd) => boolean): [KWire, 'a' | 'b'] | undefined => {
        for (const m of kws.values()) {
          const s = m === k ? undefined : sides.find((t) => test(m[t]));
          if (s) return [m, s];
        }
        return undefined;
      };
      let hit = find((e) => 'ref' in e && 'wire' in e.ref && e.node === node);
      if (!hit) {
        hit = find((e) => 'open' in e && e.open === node);
        if (hit) rehost.set(node, { wire: k.id, at: side === 'a' ? k.line[0] : k.line[k.line.length - 1] });
      }
      if (!hit) continue;
      const [x, xs] = hit;
      const kLine = side === 'a' ? [...k.line].reverse() : k.line, kOther = side === 'a' ? k.b : k.a;
      const xLine = xs === 'b' ? [...x.line].reverse() : x.line, xOther = xs === 'a' ? x.b : x.a;
      Object.assign(k, { line: [...kLine, ...xLine.slice(1)], a: kOther, b: xOther, changed: true });
      kws.delete(x.id);
      for (const [o, to] of owner) if (to === x.id) owner.set(o, k.id);
      again = true;
      break;
    }
  }
  const wires: WireDoc[] = [];
  for (const w of main.wires) {
    const k = kws.get(w.id);
    if (!k || 'open' in k.a || 'open' in k.b) continue; // (a cut with nowhere to go: left out)
    const ref = (e: EndRef): EndRef => ('wire' in e ? { wire: owner.get(e.wire) ?? e.wire, at: e.at } : e);
    const a = ref(k.a.ref), b = ref(k.b.ref);
    if (!k.changed && endKey(a) === endKey(w.a) && endKey(b) === endKey(w.b)) { wires.push(w); continue; }
    const line = (w.straight ? straightLine : orthogonal)(k.line);
    wires.push({ ...w, a, b, pts: line.slice(1, -1) });
  }
  const used = new Set(wires.flatMap((w) => [w.a, w.b].flatMap((e) => ('label' in e ? [e.label] : []))));
  return { wires, labels: main.labels.filter((l) => used.has(l.id)) };
}

// ---- metrics -----------------------------------------------------------------------------------

export interface StepMetrics {
  nand: number;
  transistors: number;
  /** null: sequential (feedback), switch level, or nothing to measure. */
  depth: number | null;
  /** Table levels: per output pin, the rows of Check's table it already gets right (X or Z is wrong). */
  rows?: { out: string; right: number; total: number }[];
}

const libs = new WeakMap<Walk, UserLibrary>();
const metricsCache = new WeakMap<Walk, Map<string, StepMetrics>>();

/** Cost and correctness of the partial circuit after steps 0..k, measured as Check measures it. */
export function stepMetrics(w: Walk, k: number, ch: BuildChallenge): StepMetrics {
  let cache = metricsCache.get(w);
  if (!cache) metricsCache.set(w, (cache = new Map()));
  const key = `${ch.id}|${k}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const doc = partialDoc(w, k);
  let lib = libs.get(w);
  if (!lib) libs.set(w, (lib = new UserLibrary()));
  lib.update(workspaceOf([...w.docs.slice(0, -1), doc]));
  const c = lib.compiled(doc.id)!;
  const s = scoreOf(c.def, c.mode, false);
  const m: StepMetrics = { nand: s.nand, transistors: s.transistors, depth: s.depth };
  if (ch.check.kind === 'table') {
    try {
      m.rows = rowsRight(c.def, c.mode, ch.ports, ch.check);
    } catch {
      m.rows = ch.ports.filter((p) => p.dir === 'out').map((p) => ({ out: p.name, right: 0, total: tableRows(ch.check as TableCheck, ch.ports).length }));
    }
  }
  cache.set(key, m);
  return m;
}

type TableCheck = Extract<ChallengeCheck, { kind: 'table' }>;

const bit = (x: number, i: number) => (i < 31 ? (x >>> i) & 1 : Math.floor(x / 2 ** i) % 2);

/**
 * Per output, the table rows it gets right. A NAND netlist is swept 32 rows at a time in
 * three-valued dual rail (a net is "is 1", "is 0", or neither: X), so an output a missing part
 * leaves undriven counts as wrong; anything else (transistors, behaviours) runs row by row.
 */
function rowsRight(def: ComponentDef, mode: 'gate' | 'switch', ports: PinSpec[], check: TableCheck): { out: string; right: number; total: number }[] {
  const rows = tableRows(check, ports);
  const I = ports.filter((p) => p.dir === 'in'), O = ports.filter((p) => p.dir === 'out');
  const right = O.map(() => 0);
  const score = (v: number[], got: (i: number, b: number) => Bit | null) => {
    const want = check.spec(v), care = check.care?.(v);
    O.forEach((p, k) => {
      for (let i = 0; i < p.width; i++) {
        if (care && !bit(care[k], i)) continue;
        if (got(k, i) !== (bit(want[k], i) ? B1 : B0)) return;
      }
      right[k]++;
    });
  };
  const design = flatten(def, { mode });
  const outNets = O.map((p) => design.root.ports[p.name]);
  if (mode === 'gate' && design.leaves.every((l) => l.kind === 'nand' || (l.kind === 'behavior' && !l.inputs.length))) {
    const n = design.netCount;
    const one = new Int32Array(n), zero = new Int32Array(n);
    const consts: [number, boolean][] = [];
    const nands: number[] = [];
    for (const l of design.leaves) {
      if (l.kind === 'nand') { nands.push(l.inputs[0][0], l.inputs[1][0], l.outputs[0][0]); continue; }
      const b = l.def.behavior!, outs = b.eval([], b.init?.());
      l.outputs.forEach((port, pi) => port.forEach((net, i) => consts.push([net, !!bit(outs[pi], i)])));
    }
    const ops = topoNands(nands, n);
    for (let at = 0; at < rows.length; at += 32) {
      const batch = rows.slice(at, at + 32);
      one.fill(0);
      zero.fill(0);
      for (const [net, v] of consts) (v ? one : zero)[net] = -1;
      I.forEach((p, pi) => design.root.ports[p.name].forEach((net, i) => {
        let o = 0;
        batch.forEach((v, l) => { o |= bit(v[pi], i) << l; });
        one[net] = o;
        zero[net] = ~o;
      }));
      // Sweep until nothing changes (one sweep when acyclic; X stays X in a loop nothing resolves).
      for (let sweep = 0, changed = true; changed && sweep <= ops.cyclic * 2 + 1; sweep++) {
        changed = false;
        for (let j = 0; j < ops.order.length; j += 3) {
          const a = ops.order[j], b = ops.order[j + 1], y = ops.order[j + 2];
          const y1 = zero[a] | zero[b], y0 = one[a] & one[b];
          if (y1 !== one[y] || y0 !== zero[y]) { one[y] = y1; zero[y] = y0; changed = true; }
        }
        if (!ops.cyclic) break;
      }
      batch.forEach((v, l) => score(v, (k, i) => {
        const net = outNets[k][i];
        return (one[net] >>> l) & 1 ? B1 : (zero[net] >>> l) & 1 ? B0 : null;
      }));
    }
  } else {
    const sim: Sim = mode === 'switch' ? new SwitchSim(design) : new GateSim(design);
    for (const v of rows) {
      I.forEach((p, i) => sim.setInput(p.name, v[i]));
      sim.settle();
      if (sim.unstable) continue;
      score(v, (k, i) => sim.getBits([outNets[k][i]])[0]);
    }
  }
  return O.map((p, k) => ({ out: p.name, right: right[k], total: rows.length }));
}

/** NAND triples in topological order (Kahn; what is left in loops goes last, swept until stable). */
function topoNands(t: number[], n: number): { order: Int32Array; cyclic: number } {
  const m = t.length / 3;
  const driver = new Int32Array(n).fill(-1);
  for (let g = 0; g < m; g++) driver[t[3 * g + 2]] = g;
  const indeg = new Int32Array(m), fan: number[][] = Array.from({ length: m }, () => []);
  for (let g = 0; g < m; g++) for (const net of [t[3 * g], t[3 * g + 1]]) if (driver[net] >= 0) { indeg[g]++; fan[driver[net]].push(g); }
  const order: number[] = [];
  for (let g = 0; g < m; g++) if (!indeg[g]) order.push(g);
  for (let h = 0; h < order.length; h++) for (const q of fan[order[h]]) if (--indeg[q] === 0) order.push(q);
  const left = m - order.length;
  for (let g = 0; g < m; g++) if (indeg[g] > 0) order.push(g);
  const out = new Int32Array(3 * m);
  order.forEach((g, i) => { out[3 * i] = t[3 * g]; out[3 * i + 1] = t[3 * g + 1]; out[3 * i + 2] = t[3 * g + 2]; });
  return { order: out, cyclic: left };
}
