// Lint for a sandbox chip (DOM-free): what compiles but is probably not what was meant.
// - Two different nets drawn along the same line: on screen they look like one wire.
// - A wire ending at a pointer nobody else uses: the net stops there (a typo in a name?);
//   a pointer touching nothing.
// - Part inputs left unconnected: they read X, which spreads through everything after them.
// - Parts whose outputs reach no output of the chip: dead logic, often a wire never drawn.
// Warnings only: the circuit still compiles and simulates.

import type { Vec } from '../sim/geometry';
import { deadInstances } from '../sim/dead';
import { netlistOf } from '../sim/types';
import type { Compiled, Diag } from './compile';
import { wireGroups } from './geom';
import type { ChipDoc } from './model';

export interface LintResult {
  diags: Diag[];
  /** Part inputs with nothing connected (drawn as hints on the canvas). */
  open: { part: string; port: string }[];
}

/** At most this many overlap warnings (a badly drawn chip should not flood the list). */
const MAX_OVERLAPS = 12;

export function lintChip(doc: ChipDoc, built: Compiled, polys: ReadonlyMap<string, Vec[]>): LintResult {
  const diags: Diag[] = [];
  const nl = netlistOf(built.def);
  const netName = (i: number) => {
    const n = nl?.nets[i];
    return n ? n.name ?? n.ends[0] : 'an unfinished net';
  };

  // ---- overlapping wires of different nets ----
  // Wires not on a working net still have a group (what they connect, as drawn).
  const group = new Map<string, string>();
  wireGroups(doc.wires).forEach((ids, gi) => ids.forEach((id) => group.set(id, `g${gi}`)));
  const netKey = (id: string) => {
    const n = built.netOfWire.get(id) ?? -1;
    return n >= 0 ? `n${n}` : group.get(id) ?? id;
  };
  type Seg = { a: number; b: number; net: string; wire: string };
  const rows = new Map<string, Seg[]>();
  for (const w of doc.wires) {
    const p = polys.get(w.id);
    if (!p) continue;
    const net = netKey(w.id);
    for (let i = 1; i < p.length; i++) {
      const [u, v] = [p[i - 1], p[i]];
      const horiz = u[1] === v[1];
      if (horiz === (u[0] === v[0])) continue; // a point (or not orthogonal)
      const k = horiz ? `h${u[1]}` : `v${u[0]}`;
      const [a, b] = horiz ? [u[0], v[0]] : [u[1], v[1]];
      const list = rows.get(k) ?? rows.set(k, []).get(k)!;
      list.push({ a: Math.min(a, b), b: Math.max(a, b), net, wire: w.id });
    }
  }
  // One warning per pair of nets on one line, with every wire involved.
  const pairs = new Map<string, { wires: Set<string>; nets: [Seg, Seg]; at: string }>();
  for (const [k, segs] of rows) {
    segs.sort((x, y) => x.a - y.a);
    const active: Seg[] = [];
    for (const s of segs) {
      for (let i = active.length - 1; i >= 0; i--) if (active[i].b <= s.a) active.splice(i, 1);
      for (const o of active) {
        if (o.net === s.net || Math.min(o.b, s.b) - s.a <= 0) continue;
        const [x, y] = o.net < s.net ? [o, s] : [s, o];
        const key = `${x.net}|${y.net}|${k}`;
        const p = pairs.get(key) ?? pairs.set(key, { wires: new Set(), nets: [x, y], at: `${k[0] === 'h' ? 'y' : 'x'} = ${k.slice(1)}` }).get(key)!;
        p.wires.add(o.wire).add(s.wire);
      }
      active.push(s);
    }
  }
  const name = (s: Seg) => (s.net.startsWith('n') ? netName(Number(s.net.slice(1))) : `wire ${s.wire}`);
  let shown = 0;
  for (const p of pairs.values()) {
    if (shown++ >= MAX_OVERLAPS) break;
    diags.push({ level: 'warn', msg: `two nets drawn on one line (${p.at}): ${name(p.nets[0])} and ${name(p.nets[1])}`, wires: [...p.wires] });
  }
  if (pairs.size > MAX_OVERLAPS) diags.push({ level: 'warn', msg: `${pairs.size - MAX_OVERLAPS} more places where two nets are drawn on one line` });

  // ---- pointers going nowhere ----
  const count = new Map<string, number>();
  for (const l of doc.labels) count.set(l.name, (count.get(l.name) ?? 0) + 1);
  for (const l of doc.labels) {
    if (count.get(l.name) !== 1) continue;
    const ws = doc.wires.filter((w) => ('label' in w.a && w.a.label === l.id) || ('label' in w.b && w.b.label === l.id)).map((w) => w.id);
    diags.push(ws.length
      ? { level: 'warn', msg: `pointer '${l.name}' has no twin: its wire ends there`, labels: [l.id], wires: ws }
      : { level: 'warn', msg: `pointer '${l.name}' connects nothing`, labels: [l.id] });
  }

  // ---- inputs left open ----
  const open = openInputs(built);
  if (open.length) {
    const list = open.slice(0, 6).map((o) => `${o.part}.${o.port}`).join(', ');
    diags.push({
      level: 'warn',
      msg: `${open.length} input${open.length > 1 ? 's' : ''} not connected, reading X: ${list}${open.length > 6 ? ', …' : ''}`,
      parts: [...new Set(open.map((o) => o.part))],
    });
  }

  // ---- parts nothing reads ----
  const dead = deadParts(doc, built);
  if (dead.length) {
    const label = new Map(doc.parts.map((p) => [p.id, p.label]));
    const list = dead.slice(0, 6).map((id) => (label.get(id) ? `${id} (${label.get(id)})` : id)).join(', ');
    diags.push({
      level: 'warn',
      msg: `${dead.length} part${dead.length > 1 ? 's' : ''} driving nothing that reaches an output: ${list}${dead.length > 6 ? ', …' : ''}`,
      parts: dead,
    });
  }
  return { diags, open };
}

/** Part inputs with no net (they read X). */
export function openInputs(built: Compiled): { part: string; port: string }[] {
  const open: { part: string; port: string }[] = [];
  for (const inst of netlistOf(built.def)?.instances ?? []) {
    for (const p of inst.def.ports) {
      if (p.dir === 'in' && !built.netOfEnd.has(`p:${inst.name}.${p.name}`)) open.push({ part: inst.name, port: p.name });
    }
  }
  return open;
}

/**
 * Parts from which nothing leads to an output pin, a bidirectional pin or a display (sim/dead.ts).
 * A chip with no output pin and no display is still being drawn: nothing is reported.
 */
export function deadParts(doc: ChipDoc, built: Compiled): string[] {
  const nl = netlistOf(built.def);
  if (!nl) return [];
  const sinks = built.def.ports.some((p) => p.dir !== 'in') || nl.instances.some((i) => !i.def.ports.some((p) => p.dir !== 'in'));
  if (!sinks) return [];
  const ids = new Set(doc.parts.map((p) => p.id));
  return deadInstances(nl, built.def.ports).filter((n) => ids.has(n));
}
