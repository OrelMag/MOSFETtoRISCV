// A library component → an editable chip document: "open it in the sandbox". The document is
// what a user would have drawn to make the same circuit: the instances where the schematic puts
// them, the wires the inside view draws (route.ts), and the schematic's tags as pointers. It
// compiles back (compile.ts) to the same flat circuit, which tests/editor-roundtrip.test.ts
// checks for every component of the library.

import { type ExitDir, instPort, symbolGeom, type Vec } from '../sim/geometry';
import { type ComponentDef, type Netlist, netlistOf, parseEnd } from '../sim/types';
import { tagStub } from '../view/route';
import { autoFace } from './face';
import {
  type ChipDoc, type EndRef, type FaceDoc, type FacePinDoc, type FaceSide, isIdent, type LabelDoc, onPolyline, type PartDoc, type PartRef, type PinDoc, slug,
  polyline, uniqueName, type WireDoc,
} from './model';
import { partBox } from './geom';
import { isError, MAX_WIDTH, partDef } from './parts';
import { drawnNetlist, routedOnce } from '../view/wirefirst';
import { deviceOf } from './devparts';
import { puzzlePortOf } from './puzzleparts';

/** A sandbox copy is drawn once: wires-first applies to levels up to this many nets (a stage stops at wirefirst.ts LOCAL_NETS). */
const FROMDEF_NETS = 120;

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
  const raw = netlistOf(def);
  if (!raw) return { error: `${def.id} has no netlist (a primitive): nothing to draw` };
  return drawDoc(def, settled(def, raw, opts), opts);
}

const routedOf = routedOnce;

/** Per definition, the netlist docFromDef draws (the wires it settled on depend on the drawing, not on ids or names). */
const settledNl = new WeakMap<ComponentDef, Netlist>();

/**
 * The netlist as a stage shows it: the nets that read better as wires (short, forward, few sinks) are wires, not pointer pairs.
 * The editor's wires branch where the schematic's paths share a beginning, so a wire the router kept clear can still cross a part
 * or run along another net here: those sinks go back to pointers and the chip is drawn again, unless the author's own drawing has
 * the same fault (that stays as it was). Not settled after a few passes: the author's netlist.
 */
function settled(def: ComponentDef, raw: Netlist, opts: FromDefOptions): Netlist {
  // a caller placing parts its own way (refOf) may draw what a plain reference cannot: settled for it alone, not kept
  const keep = !opts.refOf;
  const known = keep ? settledNl.get(def) : undefined;
  if (known) return known;
  const check: FromDefOptions = opts.refOf ? { refOf: opts.refOf } : {};
  let nl = drawnNetlist(def, raw, FROMDEF_NETS);
  let rawHits: Set<string> | undefined;
  let out = raw;
  for (let pass = 0; pass < 12 && nl !== raw; pass++) {
    const doc = drawDoc(def, nl, check);
    if ('error' in doc) break;
    const found = sinksThroughParts(doc, nl);
    if (!found.size) { out = nl; break; }
    rawHits ??= ((d) => ('error' in d ? new Set<string>() : sinksThroughParts(d, raw)))(drawDoc(def, raw, check));
    const hit = new Set([...found].filter((e) => !rawHits!.has(e)));
    if (!hit.size) { out = nl; break; }
    nl = { ...nl, nets: nl.nets.map((n) => {
      const back = n.ends.slice(1).filter((e) => hit.has(e));
      if (!back.length || n.tags === true) return n;
      const tags = [...new Set([...(Array.isArray(n.tags) ? n.tags : []), ...back])];
      return { ...n, tags: tags.length >= n.ends.length - 1 ? true : tags };
    }) };
  }
  if (keep) settledNl.set(def, out);
  return out;
}

/**
 * Sinks (as netlist ends) whose wire in the drawn chip runs through a part other than its own ends (a splitter's bar does not hide
 * it), or lies on a line another net's wire runs along (they would look joined: lint.ts warns of it).
 */
function sinksThroughParts(doc: ChipDoc, nl: Netlist): Set<string> {
  const out = new Set<string>();
  const sinkOf = (w: WireDoc) => ('part' in w.b ? `${w.b.part}.${w.b.port}` : 'pin' in w.b ? w.b.pin : null);
  const defsAll = new Map(nl.instances.map((i) => [i.name, i.def]));
  const nets = wireNets.get(doc);
  if (nets) {
    type Seg = { a: number; b: number; net: number; w: WireDoc };
    const rows = new Map<string, Seg[]>();
    for (const w of doc.wires) {
      const p = polyline(doc, w, ((x: PartDoc) => defsAll.get(x.id)) as never);
      if (!p) continue;
      for (let i = 1; i < p.length; i++) {
        const [u, v] = [p[i - 1], p[i]], horiz = u[1] === v[1];
        if (horiz === (u[0] === v[0])) continue;
        const k = horiz ? `h${u[1]}` : `v${u[0]}`, [a, b] = horiz ? [u[0], v[0]] : [u[1], v[1]];
        (rows.get(k) ?? rows.set(k, []).get(k)!).push({ a: Math.min(a, b), b: Math.max(a, b), net: nets.get(w.id) ?? -1, w });
      }
    }
    for (const segs of rows.values()) for (const x of segs) for (const y of segs) {
      if (x.net === y.net || x.net < 0 || y.net < 0 || Math.min(x.b, y.b) - Math.max(x.a, y.a) <= 0) continue;
      for (const z of [x, y]) { const e = sinkOf(z.w); if (e) out.add(e); }
    }
  }
  for (const e of sinksInParts(doc, nl)) out.add(e);
  return out;
}

function sinksInParts(doc: ChipDoc, nl: Netlist): Set<string> {
  const defs = new Map(nl.instances.map((i) => [i.name, i.def]));
  const defOf = (p: PartDoc) => defs.get(p.id);
  const boxes = doc.parts.filter((p) => defs.get(p.id)?.prim !== 'alias').map((p) => ({ id: p.id, r: partBox(defs.get(p.id)!, p.at, p.flip, p.rot) }));
  const out = new Set<string>();
  for (const w of doc.wires) {
    const sink = 'part' in w.b ? `${w.b.part}.${w.b.port}` : 'pin' in w.b ? w.b.pin : null;
    if (!sink) continue;
    const pts = polyline(doc, w, defOf as never);
    if (!pts) continue;
    const own = new Set([w.a, w.b].flatMap((e) => ('part' in e ? [e.part] : [])));
    const hit = boxes.some(({ id, r }) => !own.has(id) && pts.some((p, i) => {
      if (i + 1 >= pts.length) return false;
      const q = pts[i + 1], lx = Math.min(p[0], q[0]), hx = Math.max(p[0], q[0]), ly = Math.min(p[1], q[1]), hy = Math.max(p[1], q[1]);
      return hx > r.x + 0.1 && lx < r.x + r.w - 0.1 && hy > r.y + 0.1 && ly < r.y + r.h - 0.1;
    }));
    if (hit) out.add(sink);
  }
  return out;
}

function drawDoc(def: ComponentDef, nl: Netlist, opts: FromDefOptions): ChipDoc | { error: string } {
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
    parts.push({ id: inst.name, ref, at: [at[0], at[1]], ...(inst.flip ? { flip: true } : {}), ...(inst.rot ? { rot: inst.rot } : {}), ...(inst.label ? { label: inst.label } : {}) });
  }

  const { nets: routed, pins: pg } = routedOf(def, nl);
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
    return instPort(i.def, i.at ?? [0, 0], i.flip, port, i.rot);
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
  const netOfWire = new Map<string, number>();
  let curNet = -1;
  const addWire = (w: Omit<WireDoc, 'id'>): WireDoc => {
    const doc = { id: `w${++wn}`, ...w };
    wires.push(doc);
    netOfWire.set(doc.id, curNet);
    return doc;
  };

  nl.nets.forEach((net, ni) => {
    curNet = ni;
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
        if (net.hue !== undefined) l.hue = net.hue;
        labels.push(l);
        const w = t.end === drv
          ? addWire({ a: ref(t.end), b: { label: l.id }, pts })
          : addWire({ a: { label: l.id }, b: ref(t.end), pts: [...pts].reverse() });
        mine.push({ w, line: [], full: [] });
      }
    }
    // a colour the learner picked on the stage (view/layout.ts, put on the net by applyLayout) goes to every piece of the net
    if (net.hue !== undefined) for (const m of mine) m.w.hue = net.hue;
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

  const name = opts.name ?? def.name;
  const face = boxFace(def, pins, name);
  const out: ChipDoc = {
    id: opts.id ?? `u_${slug(def.id)}`, name,
    ...(def.notes ? { notes: def.notes } : {}),
    pins, parts, wires, labels, ...(face ? { face } : {}),
  };
  wireNets.set(out, netOfWire);
  return out;
}

/** The net each wire of a drawn chip belongs to (drawDoc's own record). */
const wireNets = new WeakMap<ChipDoc, Map<string, number>>();

/**
 * A box part's own box as the chip's face, when it differs from the box the chip would get by itself (pins on the
 * top or bottom, a size of its own): a copy of the chip placed where the part was then lines up with the wires
 * drawn to the part (a reference answer drawing its sub-units as chips). Undefined when the automatic box is the same.
 */
function boxFace(def: ComponentDef, pins: PinDoc[], label: string): FaceDoc | undefined {
  if (def.symbol.kind !== 'box') return undefined;
  const g = symbolGeom(def);
  const auto = autoFace(pins, label);
  const sideOf = (e: ExitDir): FaceSide => (e === 'up' ? 'top' : e === 'down' ? 'bottom' : e);
  const places: Record<string, FacePinDoc> = {};
  let same = auto.w === g.w && auto.h === g.h;
  for (const p of pins) {
    const pg = g.ports[p.name];
    if (!pg) return undefined;
    const side = sideOf(pg.exit), at = side === 'left' || side === 'right' ? pg.pos[1] : pg.pos[0];
    if (!Number.isInteger(at) || at < 1) return undefined;
    places[p.id] = { side, at };
    const a = auto.pins.get(p.id);
    if (!a || a.side !== side || a.at !== at) same = false;
  }
  return same ? undefined : { w: g.w, h: g.h, pins: places };
}

/** How a library part is placed: splitters and mergers by their widths, the rest by id. */
function refOf(d: ComponentDef): PartRef {
  const dev = deviceOf(d);
  if (dev) return dev.en ? { device: dev.dev, en: true } : { device: dev.dev };
  const pz = puzzlePortOf(d);
  if (pz) return { puzzle: pz.kind, width: pz.width };
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
