// Lint for a sandbox chip (DOM-free): what compiles but is probably not what was meant.
// - Two different nets drawn along the same line: on screen they look like one wire.
// - A wire ending at a pointer nobody else uses: the net stops there (a typo in a name?);
//   a pointer touching nothing.
// - Part inputs left unconnected: they read X, which spreads through everything after them.
// - Parts whose outputs reach no output of the chip: dead logic, often a wire never drawn.
// A freshly placed part's open inputs / dead output are hints until it is wired or the chip runs (opts.soft).
// Warnings only: the circuit still compiles and simulates.

import type { Vec } from '../sim/geometry';
import { deadInstances } from '../sim/dead';
import { netlistOf } from '../sim/types';
import type { Compiled, Diag } from './compile';
import { wireGroups } from './geom';
import { type ChipDoc, PIPE_CORE_LIB } from './model';

export interface LintResult {
  diags: Diag[];
  /** Part inputs with nothing connected (drawn as hints on the canvas). */
  open: { part: string; port: string }[];
}

/** At most this many overlap warnings (a badly drawn chip should not flood the list). */
const MAX_OVERLAPS = 12;

export function lintChip(doc: ChipDoc, built: Compiled, polys: ReadonlyMap<string, Vec[]>, opts: { soft?: boolean } = {}): LintResult {
  const diags: Diag[] = [];
  // Until the learner runs the chip, a part nothing is wired to yet is still being placed: its open inputs and
  // dead output are a hint (neutral, uncounted), not a warning.
  const wired = new Set<string>();
  for (const w of doc.wires) for (const e of [w.a, w.b]) if ("part" in e) wired.add(e.part);
  const level = (ids: string[]): Diag["level"] => (opts.soft && ids.every((id) => !wired.has(id)) ? "hint" : "warn");
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
    diags.push({ level: 'warn', msg: `two nets drawn on one line (${p.at}): ${name(p.nets[0])} and ${name(p.nets[1])}`, fix: 'They look joined but are not. Drag a segment of one aside.', wires: [...p.wires] });
  }
  if (pairs.size > MAX_OVERLAPS) diags.push({ level: 'warn', msg: `${pairs.size - MAX_OVERLAPS} more places where two nets are drawn on one line` });

  // ---- pointers going nowhere ----
  const count = new Map<string, number>();
  for (const l of doc.labels) count.set(l.name, (count.get(l.name) ?? 0) + 1);
  for (const l of doc.labels) {
    if (count.get(l.name) !== 1) continue;
    const ws = doc.wires.filter((w) => ('label' in w.a && w.a.label === l.id) || ('label' in w.b && w.b.label === l.id)).map((w) => w.id);
    diags.push(ws.length
      ? { level: 'warn', msg: `pointer '${l.name}' has no twin: its wire ends there`, fix: `Place another pointer named ${l.name} where the wire goes on (same name = connected).`, labels: [l.id], wires: ws }
      : { level: 'warn', msg: `pointer '${l.name}' connects nothing`, fix: 'Wire it to a pin, or delete it (Del).', labels: [l.id] });
  }

  // ---- inputs left open ----
  const open = openInputs(built);
  // real warnings first, then the hints (parts nothing is wired to yet): one diagnostic each
  const split = <T>(xs: T[], part: (x: T) => string): [Diag['level'], T[]][] => {
    const hint = xs.filter((x) => level([part(x)]) === 'hint');
    return [['warn', xs.filter((x) => !hint.includes(x))], ['hint', hint]];
  };
  for (const [lvl, group] of split(open, (o) => o.part)) {
    if (!group.length) continue;
    const list = group.slice(0, 6).map((o) => `${o.part}.${o.port}`).join(', ');
    const one = group.length === 1;
    diags.push({
      level: lvl,
      msg: group.length > 6 ? `${group.length} inputs (${list}, …) are not connected` : `${list} ${one ? 'is' : 'are'} not connected`,
      fix: one ? 'and reads X. Wire it, or tie it with Constant 0 / 1.' : 'and read X. Wire them, or tie them with Constant 0 / 1.',
      parts: [...new Set(group.map((o) => o.part))],
    });
  }

  // ---- parts nothing reads ----
  const label = new Map(doc.parts.map((p) => [p.id, p.label]));
  for (const [lvl, group] of split(deadParts(doc, built), (id) => id)) {
    if (!group.length) continue;
    const list = group.slice(0, 6).map((id) => (label.get(id) ? `${id} (${label.get(id)})` : id)).join(', ');
    const one = group.length === 1;
    diags.push({
      level: lvl,
      msg: one ? `${list} drives nothing that reaches an output.` : group.length > 6 ? `${group.length} parts (${list}, …) drive nothing that reaches an output.` : `${list} drive nothing that reaches an output.`,
      fix: one ? 'Wire its output on, or delete it (Del).' : 'Wire their outputs on, or delete them (Del).',
      parts: group,
    });
  }
  diags.push(...isaMismatch(doc));
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

/** The width / extension a placed core implements (null: not one of the byte-addressed RISC-V cores). */
function coreIsa(ref: ChipDoc['parts'][number]['ref']): { xlen: 32 | 64; c: boolean } | null {
  if ('core' in ref) return { xlen: 32, c: false };
  if (!('lib' in ref)) return null;
  if (ref.lib === 'rv32i_core' || PIPE_CORE_LIB.test(ref.lib)) return { xlen: 32, c: false };
  if (ref.lib === 'rv32ic_core') return { xlen: 32, c: true };
  return /^rv64(i|im)(_d[0-9])?_core$/.test(ref.lib) ? { xlen: 64, c: false } : null;
}

/**
 * A Program ROM whose extension does not match the core placed beside it: a C ROM (halfword reads, packed 16-bit
 * instructions) for a core without the expander, a plain ROM for the C core, a ROM assembled for RV64 on a 32-bit core, or
 * RV32 source for a 64-bit one. The drawer's golden model would only say so later, as a mismatch.
 */
export function isaMismatch(doc: ChipDoc): Diag[] {
  const cores = doc.parts.flatMap((p) => { const i = coreIsa(p.ref); return i ? [{ id: p.id, ...i }] : []; });
  if (cores.length !== 1) return [];
  const core = cores[0];
  const out: Diag[] = [];
  const isa = `${core.xlen === 64 ? 'RV64' : 'RV32'}${core.c ? 'C' : ''}`;
  for (const p of doc.parts) {
    if (!('rom' in p.ref) || p.ref.rom.addr !== 'rv32' || p.ref.rom.w !== 32 || p.ref.rom.lang !== 'asm') continue;
    const r = p.ref.rom, rom = `ROM ${p.id}`;
    const warn = (msg: string, fix: string) => out.push({ level: 'warn', msg, fix, parts: [p.id, core.id] });
    if (r.c && !core.c) warn(`${rom} has the C extension but core ${core.id} is ${isa}, with no C expander`, 'The ROM answers with packed 16-bit instructions the core cannot read. Use the RV32IC core, or untick C extension on the ROM.');
    else if (!r.c && core.c) warn(`core ${core.id} is RV32IC but ${rom} is a plain ROM`, 'The core reads 32-bit words at word addresses only, so 16-bit instructions would be misread. Tick C extension on the ROM.');
    if (r.xlen === 64 && core.xlen === 32) warn(`${rom} is assembled for RV64 but core ${core.id} is ${isa}`, 'ld, sd and the W instructions are illegal on a 32-bit core. Use an RV64 core, or untick RV64 on the ROM.');
    else if (r.xlen !== 64 && core.xlen === 64) warn(`${rom} is assembled as RV32 but core ${core.id} is RV64`, 'ld, sd, the W instructions and 64-bit li will not assemble. Tick RV64 on the ROM.');
  }
  return out;
}
