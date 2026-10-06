// A library component → an editable chip document: "open it in the sandbox". The document is
// what a user would have drawn to make the same circuit: the instances where the schematic puts
// them, the wires the inside view draws (route.ts), and the schematic's tags as pointers. It
// compiles back (compile.ts) to the same flat circuit, which tests/editor-roundtrip.test.ts
// checks for every component of the library.

import { type ExitDir, instPort, type Vec } from '../sim/geometry';
import { type ComponentDef, netlistOf, parseEnd } from '../sim/types';
import { routeNetlist, tagStub } from '../view/route';
import {
  type ChipDoc, type EndRef, isIdent, type LabelDoc, onPolyline, type PartDoc, type PartRef, type PinDoc, slug,
  uniqueName, type WireDoc,
} from './model';
import { isError, MAX_WIDTH, partDef } from './parts';

export interface FromDefOptions {
  /** Chip id (default `u_<slug of the def's id>`). */
  id?: string;
  /** Chip name (default the def's name). */
  name?: string;
  /** How to place a part other than by library reference (e.g. a user chip: `{ chip: id }`). */
  refOf?: (def: ComponentDef) => PartRef | undefined;
}

/**
 * The chip document of a component with a netlist, or why it cannot be one: a port the sandbox
 * has no pin for (wider than MAX_WIDTH), a name that is not an identifier, or a part that
 * cannot be placed by reference (partDef must give back the very same def).
 *
 * Wires: one per drawn sink path (driver → sink). A path that shares its beginning with an
 * earlier one of the same net starts as a branch where they part, so a fan-out reads as one tree
 * of wires. Tags become pointers named after the net, each joined to its end by a short wire; a
 * net with tags gets a pointer at its driver too (route.ts leaves it out when the driver also
 * has wired sinks), so the islands are one net. Net properties: `name` and `cap` go on the
 * net's first wire, a power-on hint on that wire's `init`.
 */
export function docFromDef(def: ComponentDef, opts: FromDefOptions = {}): ChipDoc | { error: string } {
  const nl = netlistOf(def);
  if (!nl) return { error: `${def.id} has no netlist (a primitive): nothing to draw` };
  for (const p of def.ports) {
    if (!isIdent(p.name) || p.name.includes('.')) return { error: `port name '${p.name}' is not an identifier` };
    if (p.width > MAX_WIDTH) return { error: `port '${p.name}' is ${p.width} bits wide (pins: at most ${MAX_WIDTH})` };
  }

  const parts: PartDoc[] = [];
  for (const inst of nl.instances) {
    if (!isIdent(inst.name)) return { error: `instance name '${inst.name}' is not an identifier` };
    const own = opts.refOf?.(inst.def);
    const ref = own ?? refOf(inst.def);
    const back = own ? inst.def : partDef(ref, () => undefined);
    if (isError(back) || back !== inst.def) {
      return { error: `part '${inst.name}' (${inst.def.id}) cannot be placed by reference${isError(back) ? `: ${back.error}` : ' (its id names another component)'}` };
    }
    const at = inst.at ?? [0, 0];
    parts.push({ id: inst.name, ref, at: [at[0], at[1]], ...(inst.flip ? { flip: true } : {}), ...(inst.label ? { label: inst.label } : {}) });
  }

  const { nets: routed, pins: pg } = routeNetlist(def, nl);
  const pins: PinDoc[] = def.ports.map((p) => {
    const g = pg.get(p.name)!;
    const face: ExitDir = p.dir === 'out' ? 'left' : 'right';
    return {
      id: p.name, name: p.name, dir: p.dir, width: p.width, at: [g.pos[0], g.pos[1]],
      ...(g.exit !== face ? { face: g.exit } : {}), ...(p.clock ? { kind: 'clock' as const } : {}),
    };
  });

  const geom = (end: string): { pos: Vec; exit: ExitDir } => {
    const { inst, port } = parseEnd(end);
    if (inst === null) return pg.get(port)!;
    const i = nl.instances.find((x) => x.name === inst)!;
    return instPort(i.def, i.at ?? [0, 0], i.flip, port);
  };
  const ref = (end: string): EndRef => {
    const { inst, port } = parseEnd(end);
    return inst === null ? { pin: port } : { part: inst, port };
  };

  // Pointer names: the net's own name where it is the first net of that name, else made unique
  // (same name = same net in the sandbox, so two nets must never share one).
  const taken = new Set<string>();
  const names = nl.nets.map((n) => (n.name !== undefined && !taken.has(n.name) ? (taken.add(n.name), n.name) : undefined));
  nl.nets.forEach((n, i) => {
    if (names[i] === undefined) taken.add((names[i] = uniqueName(n.name ?? `n${i}`, taken)));
  });

  const wires: WireDoc[] = [];
  const labels: LabelDoc[] = [];
  const firstWire: (WireDoc | undefined)[] = [];
  let wn = 0, ln = 0;
  const addWire = (w: Omit<WireDoc, 'id'>): WireDoc => {
    const doc = { id: `w${++wn}`, ...w };
    wires.push(doc);
    return doc;
  };

  nl.nets.forEach((net, ni) => {
    const rn = routed[ni];
    const tagged = new Set(rn.tags.map((t) => t.end));
    const drv = net.ends[0];
    const P = geom(drv).pos;
    /** This net's wires: the drawn polyline of each, and the whole driver → sink path. */
    const mine: { w: WireDoc; line: Vec[]; full: Vec[] }[] = [];
    const drawn = net.ends.slice(1).filter((e) => !tagged.has(e));
    drawn.forEach((sink, k) => {
      let path = rn.paths[k];
      const S = geom(sink).pos;
      if (!path || !same(path[0], P) || !same(path[path.length - 1], S)) path = [P, S]; // (route.ts always ends paths on their ends)
      // Branch off the drawn wire this path shares the longest beginning with.
      let best: { at: Vec; rest: Vec[]; len: number } | null = null;
      for (const m of mine) {
        const c = commonPrefix(m.full, path);
        if (c.len > 0 && (!best || c.len > best.len)) best = c;
      }
      const at = best?.at;
      const host = at && mine.find((m) => m.line.length && onPolyline(m.line, at));
      if (best && host) {
        const w = addWire({ a: { wire: host.w.id, at: best.at }, b: ref(sink), pts: best.rest.slice(0, -1) });
        mine.push({ w, line: [best.at, ...best.rest], full: path });
      } else {
        const w = addWire({ a: ref(drv), b: ref(sink), pts: path.slice(1, -1) });
        mine.push({ w, line: path, full: path });
      }
    });
    if (rn.tags.length) {
      const tags = [...rn.tags];
      if (!tagged.has(drv)) {
        const g = geom(drv);
        tags.unshift({ end: drv, pos: g.pos, dir: g.exit, stub: 2 });
      }
      for (const t of tags) {
        const l: LabelDoc = { id: `l${++ln}`, name: names[ni]!, at: [0, 0], face: t.dir };
        let pts: Vec[] = [];
        if (t.at) {
          const g = geom(t.end);
          l.at = [t.at[0], t.at[1]];
          pts = tagStub(g.pos, g.exit, t.at).path.slice(1, -1);
        } else {
          const d = DIR[t.dir], s = t.stub;
          l.at = [t.pos[0] + d[0] * s, t.pos[1] + d[1] * s];
        }
        labels.push(l);
        const w = t.end === drv
          ? addWire({ a: ref(t.end), b: { label: l.id }, pts })
          : addWire({ a: { label: l.id }, b: ref(t.end), pts: [...pts].reverse() });
        mine.push({ w, line: [], full: [] });
      }
    }
    firstWire[ni] = mine[0]?.w;
  });

  // Net properties ride on the net's first wire.
  for (const [ni, net] of nl.nets.entries()) {
    const w = firstWire[ni];
    if (!w) continue;
    if (net.name !== undefined) w.name = net.name;
    if (net.cap) w.cap = true;
  }
  for (const [key, v] of Object.entries(def.powerOn ?? {})) {
    let ni = nl.nets.findIndex((n) => n.name === key);
    if (ni < 0) ni = nl.nets.findIndex((n) => n.ends.includes(key));
    const w = ni >= 0 ? firstWire[ni] : undefined;
    if (!w) return { error: `power-on value of '${key}' has no wire to sit on` };
    w.init = v;
  }

  return {
    id: opts.id ?? `u_${slug(def.id)}`, name: opts.name ?? def.name,
    ...(def.notes ? { notes: def.notes } : {}),
    pins, parts, wires, labels,
  };
}

/** How a library part is placed: splitters and mergers by their widths, the rest by id. */
function refOf(d: ComponentDef): PartRef {
  if (d.prim === 'alias' && (d.symbol.kind === 'split' || d.symbol.kind === 'merge')) {
    const ws = d.ports.filter((p) => p.dir === (d.symbol.kind === 'split' ? 'out' : 'in')).map((p) => p.width);
    const pitch = d.symbol.pitch ?? 2;
    const extra = pitch !== 2 ? { pitch } : {};
    if (d.id.startsWith('split_') && d.symbol.kind === 'split') return { split: ws, ...extra };
    if (d.id.startsWith('merge_') && d.symbol.kind === 'merge') return { merge: ws, ...extra };
  }
  return { lib: d.id };
}

const DIR: Record<ExitDir, Vec> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
const same = (a: Vec, b: Vec) => a[0] === b[0] && a[1] === b[1];

/**
 * The longest common beginning of two orthogonal polylines that start at the same point: where
 * they part, its length, and the rest of `b` after that point.
 */
function commonPrefix(a: Vec[], b: Vec[]): { at: Vec; rest: Vec[]; len: number } {
  let cur: Vec = b[0], i = 1, j = 1, len = 0;
  const dir = (p: Vec, q: Vec): Vec => [Math.sign(q[0] - p[0]), Math.sign(q[1] - p[1])];
  while (i < a.length && j < b.length) {
    if (same(a[i], cur)) { i++; continue; }
    if (same(b[j], cur)) { j++; continue; }
    const da = dir(cur, a[i]), db = dir(cur, b[j]);
    if (!same(da, db)) break;
    const la = Math.abs(a[i][0] - cur[0]) + Math.abs(a[i][1] - cur[1]);
    const lb = Math.abs(b[j][0] - cur[0]) + Math.abs(b[j][1] - cur[1]);
    const step = Math.min(la, lb);
    cur = [cur[0] + da[0] * step, cur[1] + da[1] * step];
    len += step;
  }
  while (j < b.length && same(b[j], cur)) j++;
  return { at: cur, rest: b.slice(j), len };
}
