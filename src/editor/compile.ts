// A ChipDoc (what the user drew) → a ComponentDef (what the rest of the site understands). The
// netlist keeps the drawing: instances where they were placed, pins where they were put, and
// each net's `via` is exactly the wire the user drew, so the chip's inside view (route.ts)
// shows the user's own schematic, and simulation, statistics and Verilog come for free.
//
// Connectivity: wires, part ports, pins and pointers are joined by union-find. A wire joins its
// two ends; a branch joins the wire it starts on; pointers with the same name are one net with
// no wire between them. Each group becomes one NetDef, or is dropped with a diagnostic when it
// cannot be one (mixed widths, two outputs at gate level, nothing driving it).
//
// Bidirectional (inout) pins exist at switch level only: like a transistor terminal, the pin
// is neither a driver nor a sink, and its net may be driven from inside and from the parent at
// once (an SRAM cell's bit lines). In a gate-level chip such a pin is an error and is dropped.
//
// compileChip never throws: an unfinished drawing is the normal state of an editor.

import { flatten } from '../sim/flatten';
import type { Vec } from '../sim/geometry';
import { GateSim } from '../sim/gatesim';
import { reachesTransistors } from '../sim/harness';
import { SwitchSim } from '../sim/switchsim';
import { B0, B1, BX, type ComponentDef, type NetDef, type Netlist, netlistOf, type PortDef } from '../sim/types';
import { deriveBehavior, type Derived } from './derive';
import {
  type ChipDoc, defaultFace, type EndRef, endKey, isIdent, onPolyline, orthogonal, type PartDoc, type PartRef,
  type PinDoc, polyline, uniqueName, type WireDoc,
} from './model';
import { MAX_WIDTH, type PartResult } from './parts';

export interface Diag {
  level: 'error' | 'warn';
  msg: string;
  parts?: string[];
  pins?: string[];
  wires?: string[];
  labels?: string[];
}

export interface Compiled {
  def: ComponentDef;
  diags: Diag[];
  /** Wire id → index into the netlist's nets; -1 when its group was dropped or the wire is broken. */
  netOfWire: Map<string, number>;
  /** endKey of a part port (`p:part.port`) or pin (`pin:id`) → net index; -1 dropped, absent unconnected. */
  netOfEnd: Map<string, number>;
  /** Pointer id → net index; -1 when dropped, absent when it touches nothing. */
  netOfLabel: Map<string, number>;
  /** Hash of the connectivity alone: unchanged by edits that only move things. */
  connKey: string;
  mode: 'gate' | 'switch';
  /** Switch-level chips: the gate-level model derived from the truth table (or why not). */
  derived?: Derived;
}

export function compileChip(doc: ChipDoc, defOfRef: (ref: PartRef) => PartResult): Compiled {
  try {
    return compile(doc, defOfRef);
  } catch (e) {
    // A bug here must not take the editor down: show an empty chip and say why.
    const def: ComponentDef = { id: doc.id, name: doc.name, category: 'custom', ports: [], symbol: { kind: 'box', label: doc.name } };
    return {
      def, mode: 'gate', connKey: 'internal-error', netOfWire: new Map(), netOfEnd: new Map(), netOfLabel: new Map(),
      diags: [{ level: 'error', msg: `internal error: ${e instanceof Error ? e.message : String(e)}` }],
    };
  }
}

/** One part port or chip pin on a net. */
interface Ep {
  key: string;
  /** NetDef endpoint: `part.port`, or the pin's (port) name. */
  end: string;
  width: number;
  /** drv: part output or chip input; sink: part input or chip output; bi: inout (transistor terminal). */
  role: 'drv' | 'sink' | 'bi';
  rail: boolean;
  part?: string;
  pin?: string;
}

const uniq = <T>(a: T[]) => [...new Set(a)];

function compile(doc: ChipDoc, defOfRef: (ref: PartRef) => PartResult): Compiled {
  const diags: Diag[] = [];
  const err = (msg: string, o: Omit<Diag, 'level' | 'msg'> = {}) => diags.push({ level: 'error', msg, ...o });
  const warn = (msg: string, o: Omit<Diag, 'level' | 'msg'> = {}) => diags.push({ level: 'warn', msg, ...o });

  // ---- pins ----
  const pins = new Map<string, PinDoc>();
  const pinNames = new Set<string>();
  const dupNames = new Set<string>();
  for (const p of doc.pins) {
    if (pins.has(p.id) || doc.pins.find((q) => q.id === p.id) !== p) { err(`duplicate pin id '${p.id}'`, { pins: [p.id] }); continue; }
    if (!isIdent(p.name)) { err(`pin name '${p.name}' is not an identifier (letters, digits, _)`, { pins: [p.id] }); continue; }
    if (pinNames.has(p.name)) {
      if (!dupNames.has(p.name)) err(`duplicate pin name '${p.name}'`, { pins: doc.pins.filter((q) => q.name === p.name).map((q) => q.id) });
      dupNames.add(p.name);
      continue;
    }
    if (!Number.isInteger(p.width) || p.width < 1 || p.width > MAX_WIDTH) { err(`pin '${p.name}': width must be 1–${MAX_WIDTH}`, { pins: [p.id] }); continue; }
    pinNames.add(p.name);
    pins.set(p.id, p);
  }

  // ---- parts ----
  const parts = new Map<string, { doc: PartDoc; def: ComponentDef }>();
  for (const p of doc.parts) {
    if (!isIdent(p.id)) { err(`part name '${p.id}' is not an identifier`, { parts: [p.id] }); continue; }
    if (parts.has(p.id) || doc.parts.find((q) => q.id === p.id) !== p) { err(`duplicate part name '${p.id}'`, { parts: [p.id] }); continue; }
    let r: PartResult;
    try {
      r = defOfRef(p.ref);
    } catch (e) {
      r = { error: e instanceof Error ? e.message : String(e) };
    }
    if ('error' in r) { err(`${p.id}: ${r.error}`, { parts: [p.id] }); continue; }
    parts.set(p.id, { doc: p, def: r });
  }
  const defOfPart = (p: PartDoc) => (parts.get(p.id)?.doc === p ? parts.get(p.id)!.def : undefined);

  // A chip is solved at switch level when a gate-level flatten would reach a transistor (the
  // test circuitMode() applies to the finished def). There, several drivers on a node are legal.
  const mode: 'gate' | 'switch' = [...parts.values()].some((p) => reachesTransistors(p.def)) ? 'switch' : 'gate';
  if (mode === 'gate') {
    for (const p of pins.values()) {
      if (p.dir === 'inout') { err(`pin '${p.name}': bidirectional pins need switch level (transistors inside)`, { pins: [p.id] }); pins.delete(p.id); }
    }
  }
  const labels = new Map(doc.labels.map((l) => [l.id, l]));

  // ---- wires: keep those whose ends all resolve (a branch needs its wire to be kept) ----
  const wires = new Map<string, WireDoc>();
  for (const w of doc.wires) {
    if (wires.has(w.id)) err(`duplicate wire id '${w.id}'`, { wires: [w.id] });
    else wires.set(w.id, w);
  }
  const candidates: WireDoc[] = [];
  for (const w of wires.values()) {
    let ok = true;
    for (const e of [w.a, w.b]) {
      if ('part' in e) {
        const p = doc.parts.find((q) => q.id === e.part);
        const d = p && defOfPart(p);
        if (!p) { err(`wire to unknown part '${e.part}'`, { wires: [w.id] }); ok = false; }
        else if (!d) ok = false; // the part's own diagnostic says why
        else if (!d.ports.some((q) => q.name === e.port)) { err(`${e.part} has no port '${e.port}'`, { wires: [w.id], parts: [e.part] }); ok = false; }
      } else if ('pin' in e) {
        if (!doc.pins.some((q) => q.id === e.pin)) { err('wire to an unknown pin', { wires: [w.id] }); ok = false; }
        else if (!pins.has(e.pin)) ok = false;
      } else if ('label' in e) {
        if (!labels.has(e.label)) { err('wire to an unknown pointer', { wires: [w.id] }); ok = false; }
      } else if (!wires.has(e.wire) || e.wire === w.id) {
        err('branch off an unknown wire', { wires: [w.id] });
        ok = false;
      }
    }
    if (ok) candidates.push(w);
  }
  const valid = new Set<string>();
  const branchOk = (w: WireDoc) => [w.a, w.b].every((e) => !('wire' in e) || valid.has(e.wire));
  for (let changed = true; changed;) {
    changed = false;
    for (const w of candidates) if (!valid.has(w.id) && branchOk(w)) { valid.add(w.id); changed = true; }
  }
  const lines = new Map<string, Vec[]>();
  for (const w of candidates) {
    if (!valid.has(w.id)) continue;
    const pl = polyline(doc, w, defOfPart);
    if (pl) lines.set(w.id, pl);
    else valid.delete(w.id);
  }
  for (const w of candidates) {
    if (!valid.has(w.id)) continue;
    for (const e of [w.a, w.b]) {
      if ('wire' in e && !onPolyline(lines.get(e.wire)!, e.at)) warn('branch does not start on its wire', { wires: [w.id, e.wire] });
    }
  }

  // ---- union-find: groups (nets) and islands (joined by wires only) ----
  const keyOf = (e: EndRef) => ('wire' in e ? `w:${e.wire}` : endKey(e));
  const group = new UF(), island = new UF();
  const both = (a: string, b: string) => { group.union(a, b); island.union(a, b); };
  for (const id of valid) {
    const w = wires.get(id)!;
    both(`w:${id}`, keyOf(w.a));
    both(`w:${id}`, keyOf(w.b));
  }
  const byName = new Map<string, string>();
  for (const l of doc.labels) {
    const first = byName.get(l.name);
    if (first) group.union(first, `lbl:${l.id}`);
    else byName.set(l.name, `lbl:${l.id}`);
  }

  // Endpoints, in drawing order (wire order, a before b).
  const eps = new Map<string, Ep>();
  for (const id of valid) {
    const w = wires.get(id)!;
    for (const e of [w.a, w.b]) {
      const k = keyOf(e);
      if (eps.has(k)) continue;
      if ('part' in e) {
        const d = parts.get(e.part)!.def;
        const port = d.ports.find((q) => q.name === e.port)!;
        eps.set(k, {
          key: k, end: `${e.part}.${e.port}`, width: port.width, part: e.part,
          role: port.dir === 'out' ? 'drv' : port.dir === 'inout' ? 'bi' : 'sink',
          rail: d.prim === 'vdd' || d.prim === 'gnd',
        });
      } else if ('pin' in e) {
        const p = pins.get(e.pin)!;
        eps.set(k, { key: k, end: p.name, width: p.width, role: p.dir === 'in' ? 'drv' : p.dir === 'inout' ? 'bi' : 'sink', rail: false, pin: p.id });
      }
    }
  }

  interface Group { wires: string[]; labels: string[]; eps: Ep[] }
  const groups = new Map<string, Group>();
  const groupOf = (k: string) => {
    const r = group.find(k);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { wires: [], labels: [], eps: [] }));
    return g;
  };
  for (const id of valid) groupOf(`w:${id}`).wires.push(id);
  for (const l of doc.labels) groupOf(`lbl:${l.id}`).labels.push(l.id);
  for (const ep of eps.values()) groupOf(ep.key).eps.push(ep);

  const graph = wireGraph(valid, wires, lines);
  const labelAt = (id: string) => labels.get(id)!.at;

  const netOfWire = new Map<string, number>();
  const netOfEnd = new Map<string, number>();
  const netOfLabel = new Map<string, number>();
  for (const w of doc.wires) netOfWire.set(w.id, -1);

  const nets: NetDef[] = [];
  const wantName: (string | undefined)[] = [];
  const nameFromLabel: boolean[] = [];
  const inits: (0 | 1 | undefined)[] = [];
  for (const g of groups.values()) {
    const where = {
      wires: g.wires, labels: g.labels,
      parts: uniq(g.eps.flatMap((e) => (e.part ? [e.part] : []))), pins: g.eps.flatMap((e) => (e.pin ? [e.pin] : [])),
    };
    const drop = () => {
      for (const l of g.labels) netOfLabel.set(l, -1);
      for (const e of g.eps) netOfEnd.set(e.key, -1);
    };
    if (!g.eps.length) {
      if (g.wires.length) warn('wire connects no pin or part', where);
      continue; // a lone pointer touches nothing
    }
    const widths = uniq(g.eps.map((e) => e.width));
    if (widths.length > 1) {
      err(`width mismatch on one net: ${g.eps.map((e) => `${e.end} (${e.width})`).join(', ')}`, where);
      drop();
      continue;
    }
    const drivers = g.eps.filter((e) => e.role === 'drv');
    const bis = g.eps.filter((e) => e.role === 'bi');
    if (!drivers.length && !bis.length) {
      warn(`nothing drives ${g.eps.map((e) => e.end).join(', ')}`, where);
      drop();
      continue;
    }
    if (mode === 'gate' && drivers.length > 1) {
      err(`${drivers.length} outputs drive one net: ${drivers.map((e) => e.end).join(', ')}`, {
        ...where, parts: uniq(drivers.flatMap((e) => (e.part ? [e.part] : []))), pins: drivers.flatMap((e) => (e.pin ? [e.pin] : [])),
      });
      drop();
      continue;
    }
    // The end drawn as the source: the chip's input, else a rail, else an output, else (a node
    // between transistors) a bidirectional pin or the first terminal.
    const drv = drivers.find((e) => e.pin) ?? drivers.find((e) => e.rail) ?? drivers[0] ?? bis.find((e) => e.pin) ?? bis[0];
    const ends = [drv, ...g.eps.filter((e) => e !== drv)];
    const index = nets.length;
    const net: NetDef = { ends: ends.map((e) => e.end) };

    // Drawn paths: endpoints in the driver's island follow the wires; the others are reached
    // through a pointer, so they are tags placed at the pointer of their own island.
    const home = island.find(drv.key);
    const fromDrv = graph.search([`T:${drv.key}`]);
    const groupLabels = g.labels.map((l) => `T:lbl:${l}`);
    const via: Record<string, Vec[]> = {};
    const tags: string[] = [];
    const tagAt: Record<string, Vec> = {};
    for (const e of ends.slice(1)) {
      if (island.find(e.key) === home) {
        const p = graph.path(fromDrv, `T:${e.key}`);
        if (p) via[e.end] = interior(p);
      } else {
        tags.push(e.end);
        const near = graph.nearest(graph.search([`T:${e.key}`]), groupLabels);
        if (near) tagAt[e.end] = labelAt(near.slice('T:lbl:'.length));
      }
    }
    if (tags.length) {
      // route.ts tags the driver when every sink is tagged; tagging it explicitly also covers a
      // driver whose island has sinks of its own, and puts its tag at its island's pointer.
      tags.unshift(drv.end);
      const near = graph.nearest(fromDrv, groupLabels);
      if (near) tagAt[drv.end] = labelAt(near.slice('T:lbl:'.length));
    }
    if (Object.keys(via).length) net.via = via;
    if (tags.length) net.tags = tags;
    if (Object.keys(tagAt).length) net.tagAt = tagAt;
    const ws = g.wires.map((id) => wires.get(id)!);
    if (ws.some((w) => w.cap)) net.cap = true;
    const label = doc.labels.find((l) => g.labels.includes(l.id));
    wantName.push(label?.name ?? ws.find((w) => w.name)?.name);
    nameFromLabel.push(!!label);
    inits.push(ws.find((w) => w.init !== undefined)?.init);

    nets.push(net);
    for (const id of g.wires) netOfWire.set(id, index);
    for (const l of g.labels) netOfLabel.set(l, index);
    for (const e of g.eps) netOfEnd.set(e.key, index);
  }

  // Net names: pointer names are unique by construction (one name, one net); wire names may
  // repeat, so they are made unique. A net with a power-on value needs a name to be found by.
  const taken = new Set<string>();
  nets.forEach((n, i) => {
    if (nameFromLabel[i]) taken.add((n.name = wantName[i]!));
  });
  nets.forEach((n, i) => {
    if (nameFromLabel[i]) return;
    const want = wantName[i] ?? (inits[i] !== undefined ? `n_${n.ends[0].replace(/\W/g, '_')}` : undefined);
    if (want !== undefined) taken.add((n.name = uniqueName(want, taken)));
  });
  const powerOn: Record<string, 0 | 1> = {};
  nets.forEach((n, i) => {
    if (inits[i] !== undefined) powerOn[n.name!] = inits[i]!;
  });

  // ---- ports: DLS pin order, top to bottom (then left to right): inputs, then inouts (both on
  // the left of the box, geometry.ts), then outputs ----
  const byPos = (a: PinDoc, b: PinDoc) => a.at[1] - b.at[1] || a.at[0] - b.at[0];
  const pinList = [...pins.values()];
  const ordered = (['in', 'inout', 'out'] as const).flatMap((d) => pinList.filter((p) => p.dir === d).sort(byPos));
  const ports: PortDef[] = ordered.map((p) => ({ name: p.name, width: p.width, dir: p.dir, ...(p.kind === 'clock' ? { clock: true } : {}) }));

  const nl: Netlist = {
    level: mode,
    instances: [...parts.values()].map(({ doc: p, def }) => ({
      name: p.id, def, at: [p.at[0], p.at[1]], ...(p.flip ? { flip: true } : {}), ...(p.label ? { label: p.label } : {}),
    })),
    nets,
    pins: Object.fromEntries(ordered.map((p) => [p.name, [p.at[0], p.at[1]]])),
    pinDirs: Object.fromEntries(ordered.map((p) => [p.name, defaultFace(p)])),
  };
  const base: ComponentDef = {
    id: doc.id, name: doc.name, category: 'custom', ports,
    symbol: { kind: 'box', label: doc.name, ...(doc.hue !== undefined ? { color: doc.hue } : {}) },
    ...(doc.notes ? { notes: doc.notes } : {}),
    netlist: () => nl,
    ...(Object.keys(powerOn).length ? { powerOn } : {}),
  };

  // A switch-level chip that turns out to be combinational also gets a gate-level model, so it
  // can be a brick of gate-level chips the way the library NAND is.
  let def = base;
  let derived: Derived | undefined;
  if (mode === 'switch') {
    try {
      derived = deriveBehavior(base);
    } catch (e) {
      derived = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (derived.ok) def = { ...base, behavior: derived.behavior, spec: derived.spec };
  }

  // "This chip is a flip-flop": only once it behaves like one.
  if (doc.ff) {
    const names = Object.values(doc.ff);
    const why = ffProblem(def, doc.ff, mode);
    if (why) err(`not an edge-triggered flip-flop: ${why}`, { pins: doc.pins.filter((p) => names.includes(p.name)).map((p) => p.id) });
    else def = { ...def, ff: { ...doc.ff } };
  }

  const connKey = hash(JSON.stringify([
    [...parts.values()].map(({ doc: p }) => [p.id, p.ref]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    ports.map((p) => [p.name, p.width, p.dir, !!p.clock]),
    nets.map((n) => JSON.stringify([[...n.ends].sort(), !!n.cap])).sort(),
    Object.entries(powerOn).sort(),
    def.ff ?? null,
  ]));

  return { def, diags, netOfWire, netOfEnd, netOfLabel, connKey, mode, ...(derived ? { derived } : {}) };
}

/**
 * Why `def` is not a rising-edge flip-flop with these pins, or null. The pins must exist, be 1 bit
 * wide, d / clk / en inputs and q an output. Then a short clocked test, from q = 0 and from q = 1
 * (other inputs held at 0): q loads d at a rising edge of clk (with en = 1), and holds while clk
 * is low, while it is high (not a latch), at the falling edge, and at a rising edge with en = 0.
 */
function ffProblem(def: ComponentDef, ff: NonNullable<ChipDoc['ff']>, mode: 'gate' | 'switch'): string | null {
  const roles: [string, string | undefined, 'in' | 'out'][] = [['d', ff.d, 'in'], ['q', ff.q, 'out'], ['clk', ff.clk, 'in'], ['en', ff.en, 'in']];
  const used = new Set<string>();
  for (const [role, name, dir] of roles) {
    if (name === undefined) continue;
    const p = def.ports.find((x) => x.name === name);
    if (!p) return `no pin '${name}' (${role})`;
    if (used.has(name)) return `pin '${name}' has two roles`;
    used.add(name);
    if (p.width !== 1) return `${role} pin '${name}' must be 1 bit wide`;
    if (p.dir !== dir) return `${role} pin '${name}' must be an ${dir === 'in' ? 'input' : 'output'}`;
  }
  let sim: GateSim | SwitchSim;
  try {
    const d = flatten(def, { mode });
    sim = mode === 'gate' ? new GateSim(d) : new SwitchSim(d);
  } catch (e) {
    return `cannot be simulated (${e instanceof Error ? e.message : String(e)})`;
  }
  const q = () => {
    const b = sim.get(sim.design.root.ports[ff.q][0]);
    return b === B0 ? '0' : b === B1 ? '1' : b === BX ? 'X' : 'Z';
  };
  const set = (v: Record<string, number>) => {
    for (const [k, x] of Object.entries(v)) if (k === ff.d || k === ff.clk || k === ff.en) sim.setInput(k, x);
    sim.settle();
    return !sim.unstable;
  };
  for (const p of def.ports) if (p.dir === 'in') sim.setInput(p.name, 0);
  const en = (x: number) => (ff.en ? { [ff.en]: x } : {});
  for (const init of [0, 1]) {
    const v = String(init), nv = String(1 - init);
    const steps: [Record<string, number>, string, string][] = [
      [{ [ff.clk]: 0, [ff.d]: init, ...en(1) }, '', ''],
      [{ [ff.clk]: 1 }, '', ''],
      [{ [ff.clk]: 0 }, v, `q = %q after a rising edge with d = ${v}`],
      [{ [ff.d]: 1 - init }, v, `q follows d while clk = 0 (q = %q)`],
      [{ [ff.clk]: 1 }, nv, `q does not take d = ${nv} at the rising edge of clk (q = %q)`],
      [{ [ff.d]: init }, nv, `q follows d while clk = 1: a latch? (q = %q)`],
      [{ [ff.clk]: 0 }, nv, `q changes at the falling edge of clk (q = %q)`],
      ...(ff.en ? [
        [{ [ff.en]: 0, [ff.d]: init }, nv, ''],
        [{ [ff.clk]: 1 }, nv, `q loads at a rising edge with ${ff.en} = 0 (q = %q)`],
        [{ [ff.clk]: 0, [ff.en]: 1 }, nv, ''],
      ] as [Record<string, number>, string, string][] : []),
    ];
    for (const [inputs, want, msg] of steps) {
      if (!set(inputs)) return 'it does not settle';
      if (msg && q() !== want) return msg.replace('%q', q());
    }
  }
  return null;
}

/** Points strictly between the driver and the sink; never empty, so route.ts draws exactly this. */
function interior(path: Vec[]): Vec[] {
  const p = orthogonal(path);
  if (p.length > 2) return p.slice(1, -1);
  const [a, b] = [p[0], p[p.length - 1]];
  return [[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]];
}

// ---- the drawn wires as a graph ------------------------------------------------------------

interface Search { dist: Map<string, number>; prev: Map<string, string> }

/**
 * Vertices: every polyline point of every kept wire (a branch point splits its segment), plus
 * one terminal `T:<endKey>` per part port, pin or pointer. Two wires meet only where one ends on
 * the other or both end on the same terminal, never where they merely cross.
 */
function wireGraph(valid: Set<string>, wires: Map<string, WireDoc>, lines: Map<string, Vec[]>) {
  const pos = new Map<string, Vec>();
  const adj = new Map<string, [string, number][]>();
  const node = (id: string, p: Vec) => {
    if (!pos.has(id)) { pos.set(id, p); adj.set(id, []); }
    return id;
  };
  const edge = (a: string, b: string, w: number) => { adj.get(a)!.push([b, w]); adj.get(b)!.push([a, w]); };
  const man = (a: Vec, b: Vec) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

  // Branch points split the segment they start on.
  const extra = new Map<string, Vec[]>();
  for (const id of valid) {
    for (const e of [wires.get(id)!.a, wires.get(id)!.b]) {
      if ('wire' in e) (extra.get(e.wire) ?? extra.set(e.wire, []).get(e.wire)!).push(e.at);
    }
  }
  const chains = new Map<string, string[]>();
  for (const id of valid) {
    const pts = lines.get(id)!.map((p): Vec => [p[0], p[1]]);
    for (const q of extra.get(id) ?? []) {
      if (pts.some((p) => p[0] === q[0] && p[1] === q[1])) continue;
      for (let i = 1; i < pts.length; i++) {
        if (onPolyline([pts[i - 1], pts[i]], q)) { pts.splice(i, 0, [q[0], q[1]]); break; }
      }
    }
    const chain = pts.map((p, k) => node(`${id}#${k}`, p));
    for (let k = 1; k < chain.length; k++) edge(chain[k - 1], chain[k], man(pts[k - 1], pts[k]));
    chains.set(id, chain);
  }
  const keyOf = (e: EndRef) => endKey(e);
  for (const id of valid) {
    const w = wires.get(id)!, chain = chains.get(id)!;
    const ends: [EndRef, string][] = [[w.a, chain[0]], [w.b, chain[chain.length - 1]]];
    for (const [e, n] of ends) {
      if ('wire' in e) {
        // The vertex of the other wire at the branch point, else (off its line) the nearest one.
        const other = chains.get(e.wire)!;
        let best = other[0];
        for (const m of other) if (man(pos.get(m)!, e.at) < man(pos.get(best)!, e.at)) best = m;
        edge(n, best, man(pos.get(best)!, e.at));
      } else {
        edge(n, node(`T:${keyOf(e)}`, pos.get(n)!), 0);
      }
    }
  }

  const search = (from: string[]): Search => {
    const dist = new Map<string, number>(), prev = new Map<string, string>();
    const heap = new MinHeap();
    for (const f of from) if (pos.has(f)) { dist.set(f, 0); heap.push(0, f); }
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist.get(u)!) continue;
      for (const [v, w] of adj.get(u)!) {
        const nd = d + w;
        if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); heap.push(nd, v); }
      }
    }
    return { dist, prev };
  };
  const path = (s: Search, to: string): Vec[] | null => {
    if (!s.dist.has(to)) return null;
    const out: Vec[] = [];
    for (let n: string | undefined = to; n !== undefined; n = s.prev.get(n)) out.push(pos.get(n)!);
    return out.reverse();
  };
  const nearest = (s: Search, targets: string[]): string | null => {
    let best: string | null = null;
    for (const t of targets) if (s.dist.has(t) && (best === null || s.dist.get(t)! < s.dist.get(best)!)) best = t;
    return best;
  };
  return { search, path, nearest };
}

class MinHeap {
  private a: [number, string][] = [];
  get size() { return this.a.length; }
  push(k: number, v: string) {
    const a = this.a;
    a.push([k, v]);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, string] {
    const a = this.a, top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

class UF {
  private p = new Map<string, string>();
  find(x: string): string {
    let r = x;
    for (let q = this.p.get(r); q !== undefined && q !== r; q = this.p.get(r)) r = q;
    for (let y = x; y !== r;) { const n = this.p.get(y)!; this.p.set(y, r); y = n; }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p.set(rb, ra);
  }
}

/** cyrb53: a fast 53-bit string hash, as hex. */
export function hash(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Can the compiled chip actually be flattened and simulated? Catches what only shows up below
 * this level (e.g. a short through a part's inside). Never throws.
 */
export function checkSimulatable(c: Compiled): Diag[] {
  try {
    const d = flatten(c.def, { mode: c.mode });
    if (c.mode === 'gate') new GateSim(d);
    else new SwitchSim(d);
    return [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    let names: string[] = [];
    try {
      const insts = new Set(netlistOf(c.def)?.instances.map((i) => i.name) ?? []);
      const both = msg.match(/driven by both (\S+) and (\S+)/);
      const refs = both ? [both[1], both[2]] : [...msg.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      names = uniq(refs.map((r) => r.split('.')[0]).filter((n) => insts.has(n)));
    } catch { /* names are a courtesy */ }
    return [{ level: 'error', msg: `cannot simulate: ${msg}`, ...(names.length ? { parts: names } : {}) }];
  }
}
