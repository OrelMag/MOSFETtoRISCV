// Logisim-evolution (and original Logisim 2.7) .circ files → sandbox chips, DOM-free.
//
// A .circ holds every circuit of a project; each becomes a ChipDoc, the main circuit last. The drawing is kept:
// Logisim's coordinates are pixels on a 10 px grid and ours are 10 px units, so a point (x, y) becomes (x / 10, y / 10).
// Our parts have other shapes than Logisim's, so each is placed (and turned or mirrored) where its ports come closest
// to the Logisim ports they stand for, and Logisim's wire segments are redrawn as our wires from those ports: the
// corners are Logisim's points, a short jog joins a port of ours that is not exactly on its Logisim point.
//
// Connectivity is Logisim's: wire segments join at their ends and where an end (or a component's port) lies on
// another segment; component ports join the wires (or other ports) at their points; tunnels with the same label are
// one net (our pointers, by name). Every port position is computed as Logisim computes it (facing, size, inputs,
// select location, appearance...), ported from Logisim-evolution's sources, with the defaults of the version that
// wrote the file (a gate's absent input count, a multiplexer's enable pin, the appearance of flip-flops).
//
// Components become library parts when one has the same behaviour (2-input gates, multiplexers, decoders, adders,
// ROM, RAM, constants, displays) and otherwise a small chip of their own built from library parts ("helper" chips,
// shared by every instance with the same settings): wide or multi-input gates, negated inputs, flip-flops with
// reset, registers, counters, comparators. A Logisim input left open keeps Logisim's meaning (a carry in reads 0,
// an enable reads 1) through a constant tied to it. Anything without an equivalent becomes an empty chip with the
// same pins, so its connections survive, and a line in the report.

import { compileChip } from '../editor/compile';
import {
  type ChipDoc, type CommentDoc, type EndRef, type LabelDoc, type PartDoc, type PartRef, type PinDoc, type WireDoc,
  isIdent, onSegment, slug, uniqueName,
} from '../editor/model';
import { isError, partDef } from '../editor/parts';
import { type ExitDir, instPort, symbolGeom, type Vec } from '../sim/geometry';
import type { ComponentDef } from '../sim/types';
import { type ImportFailure, type ImportOptions, type ImportResult, MappingTally, type SourceFile } from './report';

// ---------------------------------------------------------------------------------------------
// A small XML reader (no DOM in Node): elements, attributes, text, comments, CDATA, entities.

interface XEl { tag: string; at: Record<string, string>; kids: XEl[]; text: string }

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unent = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  }
  return ENT[e] ?? m;
});

function parseXml(s: string): XEl {
  const root: XEl = { tag: '#root', at: {}, kids: [], text: '' };
  const stack = [root];
  let i = 0;
  const upto = (t: string, from: number) => {
    const e = s.indexOf(t, from);
    if (e < 0) throw new Error(`unterminated ${t === '-->' ? 'comment' : 'markup'}`);
    return e;
  };
  while (i < s.length) {
    const top = stack[stack.length - 1];
    const lt = s.indexOf('<', i);
    if (lt < 0) { top.text += unent(s.slice(i)); break; }
    if (lt > i) top.text += unent(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) { i = upto('-->', lt) + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = upto(']]>', lt); top.text += s.slice(lt + 9, e); i = e + 3; continue; }
    if (s.startsWith('<?', lt)) { i = upto('?>', lt) + 2; continue; }
    if (s.startsWith('<!', lt)) { i = upto('>', lt) + 1; continue; }
    if (s[lt + 1] === '/') {
      const e = upto('>', lt);
      const name = s.slice(lt + 2, e).trim();
      if (stack.length < 2 || top.tag !== name) throw new Error(`unexpected </${name}>`);
      stack.pop();
      i = e + 1;
      continue;
    }
    const m = /^<([^\s/>]+)/.exec(s.slice(lt, lt + 200));
    if (!m) throw new Error('bad tag');
    const el: XEl = { tag: m[1], at: {}, kids: [], text: '' };
    let j = lt + m[0].length;
    for (;;) {
      while (j < s.length && /\s/.test(s[j])) j++;
      if (j >= s.length) throw new Error(`unterminated <${el.tag}>`);
      if (s.startsWith('/>', j)) { top.kids.push(el); j += 2; break; }
      if (s[j] === '>') { top.kids.push(el); stack.push(el); j++; break; }
      const a = /^([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(s.slice(j, j + 100000));
      if (!a) throw new Error(`bad attribute in <${el.tag}>`);
      el.at[a[1]] = unent(a[3] ?? a[4] ?? '');
      j += a[0].length;
    }
    i = j;
  }
  if (stack.length !== 1) throw new Error(`<${stack[stack.length - 1].tag}> is not closed`);
  return root;
}

// ---------------------------------------------------------------------------------------------
// The project as Logisim stores it.

type Dir = 'east' | 'west' | 'north' | 'south';
type Ver = [number, number, number];

interface LComp { lib: string | null; name: string; loc: Vec; a: Map<string, string> }
interface Appear { anchor: Vec; ports: { pin: Vec; at: Vec }[] }
interface LCirc { name: string; a: Map<string, string>; comps: LComp[]; wires: [Vec, Vec][]; appear: Appear | null }
interface Project { ver: Ver; hc: boolean; libs: Map<string, string>; circuits: LCirc[]; main: string }

const point = (s: string | undefined): Vec | null => {
  const m = s && /^\s*\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*\)?\s*$/.exec(s);
  return m ? [+m[1], +m[2]] : null;
};

function attrsOf(el: XEl): Map<string, string> {
  const a = new Map<string, string>();
  for (const k of el.kids) if (k.tag === 'a' && k.at.name !== undefined) a.set(k.at.name, k.at.val ?? k.text);
  return a;
}

function parseVer(s: string | undefined): Ver {
  const m = s && /(\d+)\.(\d+)(?:\.(\d+))?/.exec(s);
  return m ? [+m[1], +m[2], +(m[3] ?? 0)] : [4, 0, 0];
}
const cmpVer = (a: Ver, b: Ver) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function readProject(text: string): Project | ImportFailure {
  let doc: XEl;
  try {
    doc = parseXml(text);
  } catch (e) {
    return { error: `not readable XML: ${e instanceof Error ? e.message : String(e)}` };
  }
  const proj = doc.kids.find((k) => k.tag === 'project');
  if (!proj) return { error: 'not a Logisim project (no <project> element)' };
  const libs = new Map<string, string>();
  for (const l of proj.kids) if (l.tag === 'lib' && l.at.name !== undefined) libs.set(l.at.name, l.at.desc ?? '');
  const circuits: LCirc[] = [];
  for (const c of proj.kids) {
    if (c.tag !== 'circuit' || !c.at.name) continue;
    const comps: LComp[] = [];
    const wires: [Vec, Vec][] = [];
    let appear: Appear | null = null;
    for (const k of c.kids) {
      if (k.tag === 'comp') {
        const loc = point(k.at.loc);
        if (loc && k.at.name) comps.push({ lib: k.at.lib ?? null, name: k.at.name, loc, a: attrsOf(k) });
      } else if (k.tag === 'wire') {
        const a = point(k.at.from), b = point(k.at.to);
        if (a && b && (a[0] !== b[0] || a[1] !== b[1])) wires.push([a, b]);
      } else if (k.tag === 'appear') {
        appear = readAppear(k);
      }
    }
    circuits.push({ name: c.at.name, a: attrsOf(c), comps, wires, appear });
  }
  if (!circuits.length) return { error: 'the project has no circuit' };
  const mainEl = proj.kids.find((k) => k.tag === 'main');
  const main = circuits.some((c) => c.name === mainEl?.at.name) ? mainEl!.at.name : circuits[0].name;
  return { ver: parseVer(proj.at.source), hc: /-HC$/.test(proj.at.source ?? ''), libs, circuits, main };
}

/** A custom appearance: the anchor and each port's point, by the location of its pin in the circuit. */
function readAppear(el: XEl): Appear | null {
  const centre = (k: XEl): Vec => [+(k.at.x ?? 0) + +(k.at.width ?? 0) / 2, +(k.at.y ?? 0) + +(k.at.height ?? 0) / 2];
  const anchorEl = el.kids.find((k) => k.tag === 'circ-anchor');
  if (!anchorEl) return null;
  const ports: Appear['ports'] = [];
  for (const k of el.kids) {
    if (k.tag !== 'circ-port') continue;
    const pin = point(k.at.pin);
    if (pin) ports.push({ pin, at: centre(k) });
  }
  return { anchor: centre(anchorEl), ports };
}

// ---------------------------------------------------------------------------------------------
// Geometry.

const DV: Record<Dir, Vec> = { east: [1, 0], west: [-1, 0], north: [0, -1], south: [0, 1] };
const dirOf = (s: string | undefined, d: Dir): Dir => (s === 'east' || s === 'west' || s === 'north' || s === 'south' ? s : d);
const tr = (p: Vec, d: Dir, n: number): Vec => [p[0] + DV[d][0] * n, p[1] + DV[d][1] * n];
/** An offset drawn facing east, turned to face d (Logisim's Bounds / Location rotate from EAST). */
const turn = (v: Vec, d: Dir): Vec => (d === 'east' ? v : d === 'west' ? [-v[0], -v[1]] : d === 'north' ? [v[1], -v[0]] : [-v[1], v[0]]);
const EXIT: Record<ExitDir, Vec> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
const FACE: Record<Dir, ExitDir> = { east: 'right', west: 'left', north: 'up', south: 'down' };
const key = (p: Vec) => `${p[0]},${p[1]}`;
const unit = (p: Vec): Vec => [p[0] / 10, p[1] / 10];

// ---------------------------------------------------------------------------------------------
// Component kinds: their ports where Logisim puts them, and what they become.

interface LPort { key: string; at: Vec; w: number; dir: 'in' | 'out' | 'any' }

/** What a component becomes: parts (the first aligned on Logisim's ports), each Logisim port's end, ties. */
interface Real {
  parts: { ref: PartRef; prefix: string; label?: string }[];
  map: Record<string, [number, string]>;
  links?: [number, string, number, string][];
  ties?: [number, string, number, number][];
  becomes: string;
  status?: 'ok' | 'stub';
  problem?: string;
}

interface Env {
  ctx: Ctx;
  orig: boolean;
  ver: Ver;
  hc: boolean;
  /** Logisim port keys whose net reaches anything else. */
  conn: Set<string>;
  where: string;
}

interface Kind {
  ports: LPort[];
  /** Absent: handled by the circuit builder (pins, tunnels, splitters, constants, text...). */
  make?: (env: Env) => Real | { drop: string; problem?: string };
  special?: 'pin' | 'clock' | 'tunnel' | 'const' | 'splitter' | 'text' | 'drop' | 'sub' | 'unknown';
  facing: Dir;
}

const num = (s: string | undefined, d: number) => {
  if (s === undefined || s.trim() === '') return d;
  const t = s.trim();
  const v = /^-?0x/i.test(t) ? (t[0] === '-' ? -parseInt(t.slice(3), 16) : parseInt(t.slice(2), 16)) : parseInt(t, 10);
  return Number.isFinite(v) ? v : d;
};
const big = (s: string | undefined, d: bigint): bigint => {
  if (s === undefined || !s.trim()) return d;
  try {
    const t = s.trim();
    return t.startsWith('-') ? -BigInt(t.slice(1)) : BigInt(t);
  } catch {
    return d;
  }
};
const W = (c: LComp, name: string, d: number) => Math.max(1, num(c.a.get(name), d));
const bool = (c: LComp, name: string, d: boolean) => (c.a.has(name) ? c.a.get(name) === 'true' : d);
const ones = (n: number) => Array.from({ length: n }, () => 1);
const allOnes = (w: number) => 2 ** w - 1;

/** A Logisim name turned into one of ours: identifier characters, not starting with a digit (Logisim's own rule). */
export function logisimName(s: string): string {
  let t = s.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+(?=.)|_+$/g, '');
  if (!t) return '';
  if (/^\d/.test(t)) t = `_${t}`;
  return t;
}

const GATE_OP: Record<string, { base: 'and' | 'or' | 'xor'; inv: boolean }> = {
  'AND Gate': { base: 'and', inv: false }, 'OR Gate': { base: 'or', inv: false }, 'NAND Gate': { base: 'and', inv: true },
  'NOR Gate': { base: 'or', inv: true }, 'XOR Gate': { base: 'xor', inv: false }, 'XNOR Gate': { base: 'xor', inv: true },
  'Odd Parity': { base: 'xor', inv: false }, 'Even Parity': { base: 'xor', inv: true },
};

function gateInputOffset(size: number, inputs: number, index: number, axis: number, negated: boolean, facing: Dir): Vec {
  let skipStart: number, skipDist: number, skipLowerEven: number;
  if (inputs <= 3) {
    if (size < 40) [skipStart, skipDist, skipLowerEven] = [-5, 10, 10];
    else if (size < 60 || inputs <= 2) [skipStart, skipDist, skipLowerEven] = [-10, 20, 20];
    else [skipStart, skipDist, skipLowerEven] = [-15, 30, 30];
  } else if (inputs === 4 && size >= 60) [skipStart, skipDist, skipLowerEven] = [-5, 20, 0];
  else [skipStart, skipDist, skipLowerEven] = [-5, 10, 10];
  let dy: number;
  if (inputs & 1) dy = skipStart * (inputs - 1) + skipDist * index;
  else {
    dy = skipStart * inputs + skipDist * index;
    if (index >= inputs / 2) dy += skipLowerEven;
    if (inputs === 4 && size >= 60) dy -= 10;
  }
  const dx = axis + (negated ? 10 : 0);
  return facing === 'north' ? [dy, dx] : facing === 'south' ? [dy, -dx] : facing === 'west' ? [dx, dy] : [-dx, dy];
}

/** Ports of a component, in Logisim's geometry, and how it is made. */
function kindOf(c: LComp, p: Project, ctx: Ctx): Kind {
  const desc = c.lib === null ? null : (p.libs.get(c.lib) ?? '?');
  const facing = dirOf(c.a.get('facing'), 'east');
  const orig = cmpVer(p.ver, [2, 7, 2]) < 0;
  const classicApp = c.a.has('appearance') ? c.a.get('appearance') === 'classic' : orig || p.hc;
  if (desc === null) {
    const sub = ctx.ifaces.get(c.name);
    if (sub) return { special: 'sub', facing, ports: subPorts(ctx, c.name, facing) };
    return { special: 'unknown', facing, ports: [{ key: 'p', at: [0, 0], w: 0, dir: 'any' }] };
  }
  const n = c.name;
  const width = W(c, 'width', 1);
  switch (n) {
    case 'Pin': return { special: 'pin', facing, ports: [{ key: 'p', at: [0, 0], w: width, dir: isOutputPin(c) ? 'in' : 'out' }] };
    case 'Clock': return { special: 'clock', facing, ports: [{ key: 'p', at: [0, 0], w: 1, dir: 'out' }] };
    case 'Tunnel': return { special: 'tunnel', facing: dirOf(c.a.get('facing'), 'west'), ports: [{ key: 'p', at: [0, 0], w: width, dir: 'any' }] };
    case 'Constant': case 'Power': case 'Ground':
      return { special: 'const', facing, ports: [{ key: 'p', at: [0, 0], w: width, dir: 'out' }] };
    case 'Splitter': return { special: 'splitter', facing, ports: splitterPorts(c, p) };
    case 'Text': return { special: 'text', facing, ports: [] };
    case 'Probe': case 'Pull Resistor': case 'Bit Probe':
      return { special: 'drop', facing, ports: [] };
  }
  if (n in GATE_OP) {
    const op = GATE_OP[n];
    const size = num(c.a.get('size'), 50);
    const inputs = Math.max(1, num(c.a.get('inputs'), orig ? 5 : 2));
    const axis = size + (op.base === 'xor' ? 10 : 0) + (op.inv ? 10 : 0);
    const neg = (i: number) => c.a.get(`negate${i}`) === 'true';
    const ports: LPort[] = [{ key: 'y', at: [0, 0], w: width, dir: 'out' }];
    for (let i = 0; i < inputs; i++) ports.push({ key: `i${i}`, at: gateInputOffset(size, inputs, i, axis, neg(i), facing), w: width, dir: 'in' });
    return { facing, ports, make: (env) => makeGate(env, n, op, inputs, width, neg, c.a.get('xor') === '1') };
  }
  if (n === 'NOT Gate' || n === 'Buffer') {
    const len = n === 'Buffer' ? 20 : num(c.a.get('size'), 30) === 20 ? 20 : 30;
    const ports: LPort[] = [{ key: 'y', at: [0, 0], w: width, dir: 'out' }, { key: 'a', at: tr([0, 0], facing, -len), w: width, dir: 'in' }];
    return { facing, ports, make: (env) => makeNot(env, n === 'NOT Gate', width) };
  }
  if (n === 'Multiplexer' || n === 'Demultiplexer' || n === 'Decoder') return plexer(c, p, facing);
  if (n === 'Bit Selector') return bitSelector(c, facing);
  if (n === 'Priority Encoder') {
    const sel = W(c, 'select', 3), N = 1 << sel;
    const ports: LPort[] = [];
    const x = facing === 'west' ? 40 : -40, y = -5 * N + 10;
    const vert = facing === 'north' || facing === 'south';
    const at = (dx: number, dy: number): Vec => (vert ? [dy, facing === 'north' ? -dx : dx] : [dx, dy]);
    for (let i = 0; i < N; i++) ports.push({ key: `i${i}`, at: at(x, y + 10 * i), w: 1, dir: 'in' });
    ports.push({ key: 'out', at: [0, 0], w: sel, dir: 'out' }, { key: 'en', at: at(x / 2, y + 10 * N), w: 1, dir: 'in' },
      { key: 'eo', at: at(x / 2, y - 10), w: 1, dir: 'out' }, { key: 'gs', at: vert ? [10, 0] : [0, 10], w: 1, dir: 'out' });
    return { facing, ports, make: () => ({ parts: [], map: {}, becomes: '', status: 'stub' }) };
  }
  const arith = (keys: [string, Vec, number, 'in' | 'out'][]): LPort[] => keys.map(([k, at, w, dir]) => ({ key: k, at, w, dir }));
  const aw = W(c, 'width', 8);
  switch (n) {
    case 'Adder': case 'Subtractor': case 'Multiplier': {
      const cw = n === 'Multiplier' ? aw : 1;
      const ports = arith([['a', [-40, -10], aw, 'in'], ['b', [-40, 10], aw, 'in'], ['y', [0, 0], aw, 'out'], ['ci', [-20, -20], cw, 'in'], ['co', [-20, 20], cw, 'out']]);
      return { facing: 'east', ports, make: (env) => makeArith(env, n, aw, c.a.get('mode') ?? 'unsigned') };
    }
    case 'Comparator': {
      const ports = arith([['a', [-40, -10], aw, 'in'], ['b', [-40, 10], aw, 'in'], ['gt', [0, -10], 1, 'out'], ['eq', [0, 0], 1, 'out'], ['lt', [0, 10], 1, 'out']]);
      return { facing: 'east', ports, make: (env) => makeComparator(env, aw, (c.a.get('mode') ?? 'twosComplement') !== 'unsigned') };
    }
    case 'Negator':
      return { facing: 'east', ports: arith([['a', [-40, 0], aw, 'in'], ['y', [0, 0], aw, 'out']]), make: (env) => makeNegator(env, aw) };
    case 'Shifter': {
      const sw = Math.max(1, Math.ceil(Math.log2(aw)));
      const ports = arith([['a', [-40, -10], aw, 'in'], ['d', [-40, 10], sw, 'in'], ['y', [0, 0], aw, 'out']]);
      return { facing: 'east', ports, make: (env) => makeShifter(env, aw, c.a.get('shift') ?? 'll') };
    }
    case 'Bit Extender': {
      const iw = W(c, 'in_width', 8), ow = W(c, 'out_width', 16), type = c.a.get('type') ?? 'sign';
      const ports: LPort[] = [{ key: 'y', at: [0, 0], w: ow, dir: 'out' }, { key: 'a', at: turn([-40, 0], facing), w: iw, dir: 'in' }];
      if (type === 'input') ports.push({ key: 'x', at: turn([-20, -20], facing), w: 1, dir: 'in' });
      return { facing, ports, make: (env) => makeExtender(env, iw, ow, type) };
    }
    case 'D Flip-Flop': case 'T Flip-Flop': case 'J-K Flip-Flop': case 'S-R Flip-Flop':
      return flipFlop(c, n, classicApp);
    case 'Register': {
      const ports = classicApp
        ? arith([['q', [0, 0], aw, 'out'], ['d', [-30, 0], aw, 'in'], ['clk', [-20, 20], 1, 'in'], ['clr', [-10, 20], 1, 'in'], ['en', [-30, 10], 1, 'in']])
        : arith([['q', [60, 30], aw, 'out'], ['d', [0, 30], aw, 'in'], ['clk', [0, 70], 1, 'in'], ['clr', [30, 90], 1, 'in'], ['en', [0, 50], 1, 'in']]);
      return { facing: 'east', ports, make: (env) => makeRegister(env, aw, c.a.get('trigger') ?? 'rising') };
    }
    case 'Counter': {
      const sw = 150 + Math.trunc((aw - 8) / 5) * 10;
      const ports = classicApp
        ? arith([['q', [0, 0], aw, 'out'], ['d', [-30, 0], aw, 'in'], ['clk', [-20, 20], 1, 'in'], ['clr', [-10, 20], 1, 'in'],
          ['ld', [-30, -10], 1, 'in'], ['ud', [-20, -20], 1, 'in'], ['en', [-30, 10], 1, 'in'], ['carry', [0, 10], 1, 'out']])
        : arith([['q', [sw + 40, aw === 1 ? 120 : 110], aw, 'out'], ['d', [0, aw === 1 ? 120 : 110], aw, 'in'], ['clk', [0, 80], 1, 'in'],
          ['clr', [0, 20], 1, 'in'], ['ld', [0, 30], 1, 'in'], ['ud', [0, 50], 1, 'in'], ['en', [0, 70], 1, 'in'], ['carry', [sw + 40, 50], 1, 'out']]);
      const max = big(c.a.get('max'), 0xffn);
      return { facing: 'east', ports, make: (env) => makeCounter(env, aw, max, c.a.get('ongoal') ?? 'wrap', c.a.get('trigger') ?? 'rising') };
    }
    case 'ROM': return memory(c, orig, classicApp, false);
    case 'RAM': return memory(c, orig, classicApp, true);
    case 'LED':
      return { facing, ports: [{ key: 'a', at: [0, 0], w: 1, dir: 'in' }], make: () => ({ parts: [{ ref: { display: 'led' }, prefix: 'led' }], map: { a: [0, 'a'] }, becomes: 'LED' }) };
    case 'Hex Digit Display': {
      const ports: LPort[] = [{ key: 'a', at: [0, 0], w: 4, dir: 'in' }];
      if (bool(c, 'decimalPoint', true)) ports.push({ key: 'dp', at: [20, 0], w: 1, dir: 'in' });
      return { facing: 'east', ports, make: () => ({ parts: [{ ref: { display: 'hex', width: 4 }, prefix: 'hex' }], map: { a: [0, 'a'] }, becomes: 'hex display (decimal point left out)' }) };
    }
    case '7-Segment Display': {
      if (c.a.get('inputtype') === 'bus') return { facing: 'east', ports: [{ key: 'p', at: [0, 0], w: 0, dir: 'in' }], make: () => ({ parts: [], map: {}, becomes: '', status: 'stub' }) };
      const dp = bool(c, 'decimalPoint', true);
      const pos: Vec[] = [[20, 0], [30, 0], [20, 60], [10, 60], [0, 60], [10, 0], [0, 0], [30, 60]];
      const ports: LPort[] = pos.slice(0, dp ? 8 : 7).map((at, i) => ({ key: `s${i}`, at, w: 1, dir: 'in' }));
      const nb = ports.length;
      const map: Real['map'] = {};
      ports.forEach((q, i) => (map[q.key] = [0, `i${i}`]));
      return {
        facing: 'east', ports,
        make: () => ({ parts: [{ ref: { merge: ones(nb), pitch: 1 }, prefix: 'sg' }, { ref: { display: 'seg7', width: nb }, prefix: 'seg' }], map, links: [[0, 'out', 1, 'a']], becomes: '7-segment display + merger' }),
      };
    }
    case 'Button':
      return { facing, ports: [{ key: 'q', at: [0, 0], w: 1, dir: 'out' }], make: () => ({ parts: [{ ref: { switches: 1 }, prefix: 'btn' }], map: { q: [0, 'q'] }, becomes: 'a switch (toggles: not momentary)' }) };
    case 'DipSwitch': case 'DIP Switch': {
      const nsw = Math.min(32, W(c, 'number', 8));
      const f = dirOf(c.a.get('facing'), 'north');
      const [cx, dx, dy] = f === 'west' ? [0, 0, -10] : f === 'east' ? [0, 0, 10] : f === 'south' ? [-10 * (nsw + 1), 10, 0] : [0, 10, 0];
      const ports: LPort[] = [];
      for (let i = 0; i < nsw; i++) ports.push({ key: `q${i}`, at: [cx + (i + 1) * dx, (i + 1) * dy], w: 1, dir: 'out' });
      const map: Real['map'] = {};
      ports.forEach((q, i) => (map[q.key] = [0, nsw > 1 ? `o${i}` : 'q']));
      return {
        facing: f, ports,
        make: () => nsw > 1
          ? { parts: [{ ref: { split: ones(nsw), pitch: 1 }, prefix: 'dip' }, { ref: { switches: nsw }, prefix: 'sw' }], map, links: [[0, 'in', 1, 'q']], becomes: 'switch bank + splitter' }
          : { parts: [{ ref: { switches: 1 }, prefix: 'sw' }], map, becomes: 'switch bank' },
      };
    }
  }
  return { special: 'unknown', facing, ports: [{ key: 'p', at: [0, 0], w: 0, dir: 'any' }] };
}

const isOutputPin = (c: LComp) => c.a.get('type') === 'output' || c.a.get('output') === 'true';

function splitterPorts(c: LComp, p: Project): LPort[] {
  const f = dirOf(c.a.get('facing'), 'east');
  const fanout = Math.max(1, num(c.a.get('fanout'), 2));
  const incoming = Math.max(1, num(c.a.get('incoming'), 2));
  const appear = c.a.get('appear') ?? (cmpVer(p.ver, [2, 6, 4]) < 0 ? 'legacy' : 'left');
  const justify = appear === 'center' || appear === 'legacy' ? 0 : appear === 'right' ? 1 : -1;
  const gap = Math.max(1, num(c.a.get('spacing'), 1)) * 10;
  let dx0: number, dy0: number, ddx: number, ddy: number;
  if (f === 'north' || f === 'south') {
    const m = f === 'north' ? 1 : -1;
    dx0 = justify === 0 ? gap * (Math.trunc((fanout + 1) / 2) - 1) : m * justify < 0 ? -10 : 10 + gap * (fanout - 1);
    dy0 = -m * 20; ddx = -gap; ddy = 0;
  } else {
    const m = f === 'west' ? -1 : 1;
    dx0 = m * 20; ddx = 0; ddy = gap;
    dy0 = justify === 0 ? -gap * Math.trunc(fanout / 2) : m * justify > 0 ? 10 : -(10 + gap * (fanout - 1));
  }
  const ends = splitterEnds(c, fanout, incoming);
  const ports: LPort[] = [{ key: 'c', at: [0, 0], w: incoming, dir: 'any' }];
  for (let e = 0; e < fanout; e++) {
    const w = ends.filter((x) => x === e).length;
    if (w) ports.push({ key: `e${e}`, at: [dx0 + e * ddx, dy0 + e * ddy], w, dir: 'any' });
  }
  return ports;
}

/** Each bit's end (0-based), -1 for none: `bit<i>` attributes, else bit i on end i, else Logisim's distribution. */
function splitterEnds(c: LComp, fanout: number, bits: number): number[] {
  const dist: number[] = [];
  if (fanout >= bits) for (let i = 0; i < bits; i++) dist.push(i);
  else {
    const per = Math.trunc(bits / fanout);
    let extra = bits % fanout, cur = -1, left = 0;
    for (let i = 0; i < bits; i++) {
      if (left === 0) { cur++; left = per; if (extra > 0) { left++; extra--; } }
      dist.push(cur);
      left--;
    }
  }
  // Logisim writes a bit's end only when it is not the bit's own index (its default).
  return dist.map((d, i) => {
    const v = c.a.get(`bit${i}`);
    if (v === undefined) return i < fanout ? i : d;
    if (v === 'none') return -1;
    const e = parseInt(v, 10);
    return Number.isFinite(e) && e >= 0 && e < fanout ? e : d;
  });
}

function plexer(c: LComp, p: Project, dir: Dir): Kind {
  const n = c.name;
  const sel = Math.min(8, W(c, 'select', 1));
  const width = W(c, 'width', 1);
  const bl = (c.a.get('selloc') ?? 'bl') !== 'tr';
  const selMult = bl ? 1 : -1;
  const N = 1 << sel;
  const enable = c.a.has('enable') ? c.a.get('enable') === 'true'
    : n === 'Decoder' ? cmpVer(p.ver, [2, 6, 4]) >= 0 : cmpVer(p.ver, [3, 6, 1]) <= 0;
  const ports: LPort[] = [];
  const L = (x: number, y: number): Vec => [x, y];
  if (n === 'Multiplexer') {
    const wide = (c.a.get('size') ?? '40') !== '20';
    const vertical = dir !== 'north' && dir !== 'south';
    let s: Vec;
    if (N === 2) {
      const w = wide ? 30 : 20, sd = wide ? 20 : 10;
      const [e0, e1, sl] = dir === 'west' ? [L(w, -10), L(w, 10), L(sd, selMult * 20)]
        : dir === 'north' ? [L(-10, w), L(10, w), L(selMult * -20, sd)]
          : dir === 'south' ? [L(-10, -w), L(10, -w), L(selMult * -20, -sd)]
            : [L(-w, -10), L(-w, 10), L(-sd, selMult * 20)];
      ports.push({ key: 'd0', at: e0, w: width, dir: 'in' }, { key: 'd1', at: e1, w: width, dir: 'in' });
      s = sl;
    } else {
      const w = wide ? 40 : 20, sd = wide ? 20 : 10;
      let dx = -(N / 2) * 10, ddx = 10, dy = -(N / 2) * 10, ddy = 10;
      if (dir === 'west') { dx = w; ddx = 0; s = L(sd, selMult * (dy + 10 * N)); }
      else if (dir === 'north') { dy = w; ddy = 0; s = L(selMult * dx, sd); }
      else if (dir === 'south') { dy = -w; ddy = 0; s = L(selMult * dx, -sd); }
      else { dx = -w; ddx = 0; s = L(-sd, selMult * (dy + 10 * N)); }
      for (let i = 0; i < N; i++) { ports.push({ key: `d${i}`, at: [dx, dy], w: width, dir: 'in' }); dx += ddx; dy += ddy; }
    }
    if (!wide && !vertical && bl && N > 2) s = [s[0] - 10, s[1]];
    else if (!wide && vertical && !bl && N > 2) s = [s[0], s[1] - 10];
    ports.push({ key: 's', at: s, w: sel, dir: 'in' });
    if (enable) ports.push({ key: 'en', at: tr(s, dir, 10), w: 1, dir: 'in' });
    ports.push({ key: 'y', at: [0, 0], w: width, dir: 'out' });
    return { facing: dir, ports, make: (env) => makeMux(env, sel, width, enable) };
  }
  if (n === 'Demultiplexer') {
    let s: Vec;
    if (N === 2) {
      const [e0, e1, sl] = dir === 'west' ? [L(-30, -10), L(-30, 10), L(-20, selMult * 20)]
        : dir === 'north' ? [L(-10, -30), L(10, -30), L(selMult * -20, -20)]
          : dir === 'south' ? [L(-10, 30), L(10, 30), L(selMult * -20, 20)]
            : [L(30, -10), L(30, 10), L(20, selMult * 20)];
      ports.push({ key: 'y0', at: e0, w: width, dir: 'out' }, { key: 'y1', at: e1, w: width, dir: 'out' });
      s = sl;
    } else {
      let dx = -(N / 2) * 10, ddx = 10, dy = dx, ddy = 10;
      if (dir === 'west') { dx = -40; ddx = 0; s = L(-20, selMult * (dy + 10 * N)); }
      else if (dir === 'north') { dy = -40; ddy = 0; s = L(selMult * dx, -20); }
      else if (dir === 'south') { dy = 40; ddy = 0; s = L(selMult * dx, 20); }
      else { dx = 40; ddx = 0; s = L(20, selMult * (dy + 10 * N)); }
      for (let i = 0; i < N; i++) { ports.push({ key: `y${i}`, at: [dx, dy], w: width, dir: 'out' }); dx += ddx; dy += ddy; }
    }
    ports.push({ key: 's', at: s, w: sel, dir: 'in' });
    if (enable) ports.push({ key: 'en', at: tr(s, dir, -10), w: 1, dir: 'in' });
    ports.push({ key: 'x', at: [0, 0], w: width, dir: 'in' });
    return { facing: dir, ports, make: (env) => makeDemux(env, sel, width, enable) };
  }
  // Decoder: the select input at the location, outputs beside it.
  if (N === 2) {
    let e0: Vec, e1: Vec;
    if (dir === 'north' || dir === 'south') {
      const y = dir === 'north' ? -10 : 10;
      [e0, e1] = bl ? [L(10, y), L(30, y)] : [L(-30, y), L(-10, y)];
    } else {
      const x = dir === 'west' ? -10 : 10;
      [e0, e1] = bl ? [L(x, -30), L(x, -10)] : [L(x, 10), L(x, 30)];
    }
    ports.push({ key: 'y0', at: e0, w: 1, dir: 'out' }, { key: 'y1', at: e1, w: 1, dir: 'out' });
  } else {
    let dx: number, ddx: number, dy: number, ddy: number;
    if (dir === 'north' || dir === 'south') { dy = dir === 'north' ? -20 : 20; ddy = 0; dx = bl ? 0 : -10 * N; ddx = 10; }
    else { dx = dir === 'west' ? -20 : 20; ddx = 0; dy = bl ? -10 * N : 0; ddy = 10; }
    for (let i = 0; i < N; i++) { ports.push({ key: `y${i}`, at: [dx, dy], w: 1, dir: 'out' }); dx += ddx; dy += ddy; }
  }
  ports.push({ key: 's', at: [0, 0], w: sel, dir: 'in' });
  if (enable) ports.push({ key: 'en', at: tr([0, 0], dir, -10), w: 1, dir: 'in' });
  return { facing: dir, ports, make: (env) => makeDecoder(env, sel, enable) };
}

function bitSelector(c: LComp, dir: Dir): Kind {
  const width = W(c, 'width', 8), group = Math.min(width, W(c, 'group', 1));
  let groups = Math.trunc((width + group - 1) / group) - 1, selBits = 1;
  if (groups > 0) while (groups !== 1) { groups >>= 1; selBits++; }
  const bl = (c.a.get('selloc') ?? 'bl') !== 'tr';
  const [inPt, selPt]: [Vec, Vec] = dir === 'west' ? [[30, 0], bl ? [10, -10] : [10, 10]]
    : dir === 'north' ? [[0, 30], bl ? [-10, 10] : [10, 10]]
      : dir === 'south' ? [[0, -30], bl ? [-10, -10] : [10, -10]]
        : [[-30, 0], bl ? [-10, 10] : [-10, -10]];
  const ports: LPort[] = [{ key: 'y', at: [0, 0], w: group, dir: 'out' }, { key: 'a', at: inPt, w: width, dir: 'in' }, { key: 's', at: selPt, w: selBits, dir: 'in' }];
  return { facing: dir, ports, make: (env) => makeBitSelector(env, width, group, selBits) };
}

function flipFlop(c: LComp, n: string, classic: boolean): Kind {
  const data = n === 'D Flip-Flop' ? ['d'] : n === 'T Flip-Flop' ? ['t'] : n === 'J-K Flip-Flop' ? ['j', 'k'] : ['s', 'r'];
  const P = (k: string, at: Vec, dir: 'in' | 'out'): LPort => ({ key: k, at, w: 1, dir });
  const ports: LPort[] = [];
  if (classic) {
    if (data.length === 1) ports.push(P(data[0], [-40, 20], 'in'), P('clk', [-40, 0], 'in'));
    else ports.push(P(data[0], [-40, 0], 'in'), P(data[1], [-40, 20], 'in'), P('clk', [-40, 10], 'in'));
    ports.push(P('q', [0, 0], 'out'), P('nq', [0, 20], 'out'), P('rst', [-10, 30], 'in'), P('set', [-30, 30], 'in'));
  } else {
    if (data.length === 1) ports.push(P(data[0], [-10, 10], 'in'), P('clk', [-10, 50], 'in'));
    else ports.push(P(data[0], [-10, 10], 'in'), P(data[1], [-10, 30], 'in'), P('clk', [-10, 50], 'in'));
    ports.push(P('q', [50, 10], 'out'), P('nq', [50, 50], 'out'), P('rst', [20, 60], 'in'), P('set', [20, 0], 'in'));
  }
  return { facing: 'east', ports, make: (env) => makeFlipFlop(env, n, data, c.a.get('trigger') ?? 'rising') };
}

function memory(c: LComp, orig: boolean, classic: boolean, ram: boolean): Kind {
  const k = W(c, 'addrWidth', 8), w = W(c, 'dataWidth', 8);
  const contents = parseContents(c.a.get('contents'));
  const ports: LPort[] = [];
  const P = (key: string, at: Vec, pw: number, dir: 'in' | 'out'): LPort => ({ key, at, w: pw, dir });
  if (!ram) {
    if (orig) ports.push(P('addr', [-140, 0], k, 'in'), P('data', [0, 0], w, 'out'), P('cs', [-90, 40], 1, 'in'));
    else ports.push(P('addr', [0, 10], k, 'in'), P('data', [240, 60 + (!classic && w === 1 ? 10 : 0)], w, 'out'));
    return { facing: 'east', ports, make: (env) => makeRom(env, k, w, contents) };
  }
  // The RAM with Logisim-evolution's defaults: separate data buses, byte enables mode with no byte-enable pins,
  // a rising clock. Other configurations become an empty chip with the same pins.
  const sep = (c.a.get('databus') ?? 'bibus') === 'bibus';
  const enables = c.a.get('enables') ?? 'byte';
  const trig = c.a.get('trigger') ?? 'rising';
  const line = c.a.get('line') ?? 'single';
  const be = c.a.get('byteenables') === 'byteEnables' && w > 8;
  const supported = !orig && sep && enables === 'byte' && (trig === 'rising' || trig === 'falling') && line === 'single' && !be;
  if (orig || !supported) {
    ports.push(P('p', [0, 0], 0, 'in'));
    return { facing: 'east', ports, make: () => ({ parts: [], map: {}, becomes: '', status: 'stub' }) };
  }
  const ctl = 90, y = ctl + (!classic && w === 1 ? 10 : 0);
  ports.push(P('addr', [0, 10], k, 'in'), P('dout', [240, y], w, 'out'), P('din', [0, y], w, 'in'), P('oe', [0, 60], 1, 'in'),
    P('we', [0, 50], 1, 'in'), P('clk', [0, 70], 1, 'in'));
  if (c.a.get('clearpin') === 'true') ports.push(P('clr', [40, 0], 1, 'in'));
  return { facing: 'east', ports, make: (env) => makeRam(env, k, w, contents, trig) };
}

/** Logisim's memory image: "addr/data: 8 8" then hex words, `n*v` for n copies. */
function parseContents(s: string | undefined): number[] {
  if (!s) return [];
  const body = s.replace(/^[^\n]*addr\/data:[^\n]*\n?/, '');
  const out: number[] = [];
  for (const t of body.split(/\s+/)) {
    if (!t) continue;
    const m = /^(\d+)\*([0-9a-f]+)$/i.exec(t);
    if (m) { const v = parseInt(m[2], 16); for (let i = 0; i < +m[1] && out.length < 1 << 16; i++) out.push(v); }
    else if (/^[0-9a-f]+$/i.test(t)) out.push(parseInt(t, 16));
    if (out.length >= 1 << 16) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Subcircuit appearances: where a placed circuit's ports are, relative to its location.

interface IPin { comp: LComp; loc: Vec; facing: Dir; dir: 'in' | 'out'; w: number; label: string; name: string }
interface Iface { id: string; pins: IPin[]; clock: string | null }

function subPorts(ctx: Ctx, name: string, facing: Dir): LPort[] {
  const iface = ctx.ifaces.get(name)!;
  const circ = ctx.proj.circuits.find((c) => c.name === name)!;
  const offs = appearance(ctx, circ, iface);
  return iface.pins.map((p, i) => ({ key: `p${i}`, at: turn(offs[i], facing), w: p.w, dir: p.dir === 'in' ? 'in' : 'out' }));
}

function appearance(ctx: Ctx, circ: LCirc, iface: Iface): Vec[] {
  const pins = iface.pins;
  const style = circ.a.get('appearance') ?? 'classic';
  if (circ.appear && (style === 'custom' || !circ.a.has('appearance'))) {
    const a = circ.appear;
    const got = pins.map((p) => a.ports.find((q) => q.pin[0] === p.loc[0] && q.pin[1] === p.loc[1]));
    if (got.every((g) => g)) return got.map((g) => [g!.at[0] - a.anchor[0], g!.at[1] - a.anchor[1]]);
  }
  const byV = (a: IPin, b: IPin) => a.loc[1] - b.loc[1] || a.loc[0] - b.loc[0];
  const byH = (a: IPin, b: IPin) => a.loc[0] - b.loc[0] || a.loc[1] - b.loc[1];
  const out = new Map<IPin, Vec>();
  if (style === 'classic' || ctx.orig) {
    const edge: Record<Dir, IPin[]> = { north: [], south: [], east: [], west: [] };
    const rev: Record<Dir, Dir> = { east: 'west', west: 'east', north: 'south', south: 'north' };
    for (const p of pins) edge[rev[p.facing]].push(p);
    edge.east.sort(byV); edge.west.sort(byV); edge.north.sort(byH); edge.south.sort(byH);
    const [nN, nS, nE, nW] = [edge.north.length, edge.south.length, edge.east.length, edge.west.length];
    const maxVert = Math.max(nN, nS), maxHorz = Math.max(nE, nW);
    const offset = (nf: number, no: number, maxOthers: number) => {
      const maxThis = Math.max(nf, no);
      const m = maxThis <= 1 ? (maxOthers === 0 ? 15 : 10) : maxThis === 2 ? 10 : maxOthers === 0 ? 5 : 10;
      return m + 10 * Math.trunc((maxThis - nf) / 2);
    };
    const dim = (maxThis: number, maxOthers: number) => (maxThis < 3 ? 30 : maxOthers === 0 ? 10 * maxThis : 10 * maxThis + 10);
    const oN = offset(nN, nS, maxHorz), oS = offset(nS, nN, maxHorz), oE = offset(nE, nW, maxVert), oW = offset(nW, nE, maxVert);
    const width = dim(maxVert, maxHorz), height = dim(maxHorz, maxVert);
    const [ax, ay] = nE > 0 ? [width, oE] : nN > 0 ? [oN, 0] : nW > 0 ? [0, oW] : nS > 0 ? [oS, height] : [0, 0];
    edge.west.forEach((p, i) => out.set(p, [0 - ax, oW + 10 * i - ay]));
    edge.east.forEach((p, i) => out.set(p, [width - ax, oE + 10 * i - ay]));
    edge.north.forEach((p, i) => out.set(p, [oN + 10 * i - ax, 0 - ay]));
    edge.south.forEach((p, i) => out.set(p, [oS + 10 * i - ax, height - ay]));
  } else {
    // Logisim-evolution's box (also used here for the FPGA appearance): inputs west, outputs east, 20 px apart.
    const east = pins.filter((p) => p.dir === 'out').sort(byV), west = pins.filter((p) => p.dir === 'in').sort(byV);
    const lw = (ps: IPin[]) => Math.max(0, ...ps.map((p) => p.label.length * 8));
    const fixed = circ.a.get('circuitnamedboxfixedsize') === 'true';
    const textWidth = fixed ? 25 * 8 : Math.max(lw(west) + lw(east) + 35, circ.name.length * 8 + 15);
    const width = Math.trunc(textWidth / 10) * 10 + 20;
    const [ax, ay] = east.length ? [width, 10] : west.length ? [0, 10] : [0, 0];
    west.forEach((p, i) => out.set(p, [0 - ax, 10 + 20 * i - ay]));
    east.forEach((p, i) => out.set(p, [width - ax, 10 + 20 * i - ay]));
  }
  return pins.map((p) => out.get(p) ?? [0, 0]);
}

// ---------------------------------------------------------------------------------------------
// The import.

interface Ctx {
  proj: Project;
  orig: boolean;
  tally: MappingTally;
  problems: string[];
  taken: Set<string>;
  chips: ChipDoc[];
  defs: Map<string, ComponentDef>;
  helpers: Map<string, string>;
  ifaces: Map<string, Iface>;
  /** Circuits that need the clock threaded in (they hold a Clock, or place a circuit that does). */
  clocked: Map<string, boolean>;
}

const defOfRef = (ctx: Ctx, ref: PartRef): ComponentDef | null => {
  const r = partDef(ref, (id) => ctx.defs.get(id));
  return isError(r) ? null : r;
};

function addChip(ctx: Ctx, doc: ChipDoc): void {
  const c = compileChip(doc, (ref) => partDef(ref, (id) => ctx.defs.get(id)));
  ctx.defs.set(doc.id, c.def);
  ctx.chips.push(doc);
}

function freshId(ctx: Ctx, base: string): string {
  const id = uniqueName(`u_${slug(base)}`, ctx.taken);
  ctx.taken.add(id);
  return id;
}

/** Is `name` a Logisim .circ file (by its name or its root element)? */
export function isLogisimFile(name: string, text: string): boolean {
  if (/\.circ$/i.test(name)) return true;
  const head = text.slice(0, 4000);
  return /<project[\s>]/.test(head) && /<lib\s[^>]*desc="#/.test(head);
}

export function importLogisim(files: SourceFile[], opts: ImportOptions): ImportResult | ImportFailure {
  const file = files.find((f) => isLogisimFile(f.name, f.text));
  if (!file) return { error: 'no Logisim .circ file among the files' };
  const proj = readProject(file.text);
  if ('error' in proj) return proj;
  const ctx: Ctx = {
    proj, orig: cmpVer(proj.ver, [2, 7, 2]) < 0, tally: new MappingTally(), problems: [], taken: new Set(opts.taken),
    chips: [], defs: new Map(), helpers: new Map(), ifaces: new Map(), clocked: new Map(),
  };
  for (const f of files) if (f !== file && /\.circ$/i.test(f.name)) ctx.problems.push(`${f.name}: only one .circ file is read at a time (left out)`);

  // Interfaces first (a placed circuit's ports come from its pins), then chips with their dependencies first.
  for (const c of proj.circuits) ctx.ifaces.set(c.name, ifaceOf(ctx, c));
  const order: LCirc[] = [];
  const state = new Map<string, 'busy' | 'done'>();
  const visit = (c: LCirc) => {
    if (state.get(c.name)) return;
    state.set(c.name, 'busy');
    for (const k of c.comps) {
      if (k.lib !== null) continue;
      const d = proj.circuits.find((x) => x.name === k.name);
      if (!d) continue;
      if (state.get(d.name) === 'busy') { ctx.problems.push(`${c.name} ▸ ${d.name}: a circuit that places itself (left empty)`); continue; }
      visit(d);
    }
    state.set(c.name, 'done');
    order.push(c);
  };
  for (const c of proj.circuits) if (c.name !== proj.main) visit(c);
  visit(proj.circuits.find((c) => c.name === proj.main)!);
  for (const c of order) buildCircuit(ctx, c);

  const top = ctx.ifaces.get(proj.main)!.id;
  const tests = files.filter((f) => f !== file && /\.txt$/i.test(f.name));
  for (const t of tests) {
    const v = logisimVectors(t.text);
    const chip = ctx.chips.find((c) => c.id === top)!;
    if ('error' in v) ctx.problems.push(`${t.name}: ${v.error}`);
    else (chip.tests ??= []).push({ name: t.name.replace(/\.txt$/i, ''), src: v.src });
  }
  // The main circuit last, its helpers and sub-circuits before it.
  const i = ctx.chips.findIndex((c) => c.id === top);
  ctx.chips.push(...ctx.chips.splice(i, 1));
  return { format: 'logisim', chips: ctx.chips, top, mapping: ctx.tally.list(), problems: ctx.problems };
}

function needsClock(ctx: Ctx, name: string, seen = new Set<string>()): boolean {
  const k = ctx.clocked.get(name);
  if (k !== undefined) return k;
  if (seen.has(name)) return false;
  seen.add(name);
  const c = ctx.proj.circuits.find((x) => x.name === name);
  const r = !!c && c.comps.some((k2) => (k2.lib !== null && ctx.proj.libs.has(k2.lib) && k2.name === 'Clock') || (k2.lib === null && needsClock(ctx, k2.name, seen)));
  ctx.clocked.set(name, r);
  return r;
}

function ifaceOf(ctx: Ctx, c: LCirc): Iface {
  const pins: IPin[] = [];
  const names = new Set<string>();
  let nin = 0, nout = 0;
  for (const k of c.comps) {
    if (k.lib === null || k.name !== 'Pin' || !ctx.proj.libs.has(k.lib)) continue;
    const dir = isOutputPin(k) ? 'out' : 'in';
    const label = k.a.get('label') ?? '';
    const base = logisimName(label) || (dir === 'in' ? `in${nin}` : `out${nout}`);
    if (dir === 'in') nin++; else nout++;
    const name = uniqueName(base, names);
    names.add(name);
    pins.push({ comp: k, loc: k.loc, facing: dirOf(k.a.get('facing'), 'east'), dir, w: W(k, 'width', 1), label, name });
  }
  let clock: string | null = null;
  if (needsClock(ctx, c.name)) {
    const clk = c.comps.find((k) => k.name === 'Clock' && k.lib !== null);
    clock = uniqueName(logisimName(clk?.a.get('label') ?? '') || 'clk', names);
  }
  return { id: freshId(ctx, c.name), pins, clock };
}

// ---- union-find over points -----------------------------------------------------------------

class UF {
  private p = new Map<string, string>();
  find(a: string): string {
    let r = a;
    while (this.p.has(r) && this.p.get(r) !== r) r = this.p.get(r)!;
    let x = a;
    while (x !== r) { const n = this.p.get(x)!; this.p.set(x, r); x = n; }
    if (!this.p.has(r)) this.p.set(r, r);
    return r;
  }
  union(a: string, b: string): void {
    const [x, y] = [this.find(a), this.find(b)];
    if (x !== y) this.p.set(x, y);
  }
}

/** One Logisim port of a placed component, where it is and what it connects to on our side. */
interface Term {
  comp: number;
  port: LPort;
  at: Vec;
  end: EndRef | null;
}

function buildCircuit(ctx: Ctx, circ: LCirc): void {
  const iface = ctx.ifaces.get(circ.name)!;
  const proj = ctx.proj;
  const where = (k: LComp) => `${circ.name} ▸ ${k.name}${k.a.get('label') ? ` ${k.a.get('label')}` : ''}`;
  const kinds = circ.comps.map((k) => kindOf(k, proj, ctx));

  // ---- connectivity (Logisim's): wires join at ends and at points on them; ports join at their points ----
  const terms: Term[] = [];
  kinds.forEach((kd, ci) => {
    for (const p of kd.ports) terms.push({ comp: ci, port: p, at: [circ.comps[ci].loc[0] + p.at[0], circ.comps[ci].loc[1] + p.at[1]], end: null });
  });
  const geo = new UF();
  const nodes = new Map<string, Vec>();
  const addNode = (p: Vec) => nodes.set(key(p), p);
  for (const [a, b] of circ.wires) { addNode(a); addNode(b); geo.union(key(a), key(b)); }
  for (const t of terms) addNode(t.at);
  /** Wire index → its nodes (ends and points on it), in order along it. */
  const onWire: Vec[][] = circ.wires.map(([a, b]) => {
    const pts = [...nodes.values()].filter((p) => onSegment(a, b, p));
    for (const p of pts) geo.union(key(p), key(a));
    return pts.sort((p, q) => (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2 - ((q[0] - a[0]) ** 2 + (q[1] - a[1]) ** 2));
  });
  for (const t of terms) geo.find(key(t.at));
  // nets: geometry plus tunnels by label
  const net = new UF();
  for (const k of nodes.keys()) net.union(k, geo.find(k));
  const tunnels = new Map<string, string>();
  terms.forEach((t) => {
    if (kinds[t.comp].special !== 'tunnel') return;
    const name = circ.comps[t.comp].a.get('label') ?? '';
    const first = tunnels.get(name);
    if (first) net.union(first, key(t.at));
    else tunnels.set(name, key(t.at));
  });
  const netOf = (t: Term) => net.find(key(t.at));
  const byNet = new Map<string, Term[]>();
  for (const t of terms) {
    const n = netOf(t);
    (byNet.get(n) ?? byNet.set(n, []).get(n)!).push(t);
  }
  const others = (t: Term) => byNet.get(netOf(t))!.filter((u) => u !== t && kinds[u.comp].special !== 'tunnel' && kinds[u.comp].special !== 'drop');
  const connected = (t: Term) => others(t).length > 0;

  // ---- net widths; a port of unknown width (an unknown component) takes its net's ----
  const netWidth = new Map<string, number>();
  for (const [n, ts] of byNet) {
    const ws = ts.map((t) => t.port.w).filter((w) => w > 0);
    if (ws.length) netWidth.set(n, ws[0]);
    if (new Set(ws).size > 1) ctx.problems.push(`${circ.name}: a net joins ${[...new Set(ws)].sort((a, b) => a - b).join(' / ')}-bit ports (Logisim reports it as an error too); the odd ones are left unconnected`);
  }
  for (const t of terms) if (t.port.w === 0) t.port = { ...t.port, w: netWidth.get(netOf(t)) ?? 1 };

  // ---- which way each splitter goes: from the side that is driven ----
  const driven = new Set<string>();
  const isDriver = (t: Term) => t.port.dir === 'out' && kinds[t.comp].special !== 'splitter' && kinds[t.comp].special !== 'unknown';
  for (const t of terms) if (isDriver(t)) driven.add(netOf(t));
  const splitDir = new Map<number, 'split' | 'merge'>();
  for (let changed = true; changed;) {
    changed = false;
    kinds.forEach((kd, ci) => {
      if (kd.special !== 'splitter' || splitDir.has(ci)) return;
      const ts = terms.filter((t) => t.comp === ci);
      const comb = ts.find((t) => t.port.key === 'c')!;
      const ends = ts.filter((t) => t !== comb && connected(t));
      if (driven.has(netOf(comb)) && !ends.every((t) => driven.has(netOf(t)))) {
        splitDir.set(ci, 'split'); ends.forEach((t) => driven.add(netOf(t))); changed = true;
      } else if (ends.length && ends.every((t) => driven.has(netOf(t)))) {
        splitDir.set(ci, 'merge'); driven.add(netOf(comb)); changed = true;
      }
    });
  }
  // unknown components' ports: outputs where nothing else drives the net
  for (const t of terms) if (t.port.dir === 'any' && kinds[t.comp].special === 'unknown') t.port = { ...t.port, dir: driven.has(netOf(t)) ? 'in' : 'out' };

  // ---- the chip ----
  const doc: ChipDoc = { id: iface.id, name: circ.name, pins: [], parts: [], wires: [], labels: [] };
  const comments: CommentDoc[] = [];
  const partIds = new Set<string>();
  let nw = 0, nl = 0;
  const wire = (a: EndRef, b: EndRef, pts: Vec[] = []): string => {
    const id = `w${++nw}`;
    doc.wires.push({ id, a, b, pts });
    return id;
  };
  const label = (name: string, at: Vec, face: ExitDir): EndRef => {
    const id = `l${++nl}`;
    doc.labels.push({ id, name, at, face } satisfies LabelDoc);
    return { label: id };
  };
  /** A part id: the Logisim label when it is free (named), else the kind's prefix and a number. */
  const partId = (base: string, named = false) => {
    const b = isIdent(base) ? base : 'u';
    const sep = /\d$/.test(b) ? '_' : '';
    let id = b;
    if (!named || partIds.has(b)) for (let i = 1; partIds.has((id = `${b}${sep}${i}`)); i++);
    partIds.add(id);
    return id;
  };
  const defs = new Map<string, ComponentDef>();
  const place = (id: string, ref: PartRef, at: Vec, o: Orient = {}, lbl?: string): PartDoc | null => {
    const d = defOfRef(ctx, ref);
    if (!d) return null;
    defs.set(id, d);
    const p: PartDoc = { id, ref, at, ...(o.flip ? { flip: true } : {}), ...(o.rot ? { rot: o.rot } : {}), ...(lbl ? { label: lbl } : {}) };
    doc.parts.push(p);
    return p;
  };
  const portAt = (p: PartDoc, port: string) => instPort(defs.get(p.id)!, p.at, p.flip, port, p.rot);
  const tie = (p: PartDoc, port: string, w: number, v: number) => {
    const g = portAt(p, port);
    const e = EXIT[g.exit];
    const k = place(partId('k'), { const: { width: w, value: v } }, [0, 0]);
    if (!k) return;
    const kg = instPort(defs.get(k.id)!, [0, 0], false, 'y');
    k.at = [g.pos[0] + 3 * e[0] - kg.pos[0], g.pos[1] + 3 * e[1] - kg.pos[1]];
    wire({ part: k.id, port: 'y' }, { part: p.id, port });
  };

  // pins (the circuit's interface), the threaded clock
  for (const p of iface.pins) {
    const top = circ.name === proj.main;
    doc.pins.push({
      id: p.name, name: p.name, dir: p.dir, width: p.w, at: unit(p.loc), face: FACE[p.facing],
      ...(p.dir === 'in' && top ? { kind: 'toggle' as const } : {}),
    });
  }
  if (iface.clock) {
    const first = circ.comps.find((k) => k.name === 'Clock' && k.lib !== null);
    const minX = Math.min(...circ.comps.map((k) => k.loc[0]), 100), minY = Math.min(...circ.comps.map((k) => k.loc[1]), 100);
    const at: Vec = first ? [first.loc[0] / 10 - 6, first.loc[1] / 10 + 3] : [minX / 10 - 8, minY / 10 - 4];
    doc.pins.push({ id: iface.clock, name: iface.clock, dir: 'in', width: 1, at, face: 'right', kind: 'clock' });
    wire({ pin: iface.clock }, label(iface.clock, [at[0] + 2, at[1]], 'right'));
  }

  // ---- each component ----
  const tunnelName = (k: LComp) => (k.a.get('label') ?? '').trim() || 'tunnel';
  kinds.forEach((kd, ci) => {
    const c = circ.comps[ci];
    const ts = terms.filter((t) => t.comp === ci);
    const lbl = (c.a.get('label') ?? '').trim();
    switch (kd.special) {
      case 'pin': {
        const p = iface.pins.find((q) => q.comp === c)!;
        ts[0].end = { pin: p.name };
        ctx.tally.add('Pin', p.dir === 'in' ? 'input pin' : 'output pin');
        return;
      }
      case 'clock':
        ts[0].end = label(iface.clock!, unit(c.loc), FACE[kd.facing]);
        ctx.tally.add('Clock', 'the chip\'s clock pin (pointers)');
        return;
      case 'tunnel':
        ts[0].end = label(tunnelName(c), unit(c.loc), FACE[{ east: 'west', west: 'east', north: 'south', south: 'north' }[kd.facing] as Dir]);
        ctx.tally.add('Tunnel', 'pointers');
        return;
      case 'text': {
        const text = (c.a.get('text') ?? '').trim();
        if (text) comments.push({ id: `t${comments.length + 1}`, at: [c.loc[0] / 10 - text.length * 0.33, c.loc[1] / 10 - 1], text });
        ctx.tally.add('Text', 'comment');
        return;
      }
      case 'drop':
        ctx.tally.add(c.name, c.name === 'Pull Resistor' ? 'left out (an open input reads X)' : 'left out', 'dropped');
        if (c.name === 'Pull Resistor') ctx.problems.push(`${where(c)}: left out; what it pulled now floats`);
        return;
      case 'const': {
        const w = ts[0].port.w;
        if (w > 53) { stub(ctx, c, kd, ts, where(c), 'wider than 53 bits'); placeStub(ctx, c, kd, ts, place, partId); return; }
        const v = c.name === 'Power' ? allOnes(w) : c.name === 'Ground' ? 0 : Number(BigInt.asUintN(w, big(c.a.get('value'), 1n)));
        const p = alignPlace(ctx, kd, ts, { const: { width: w, value: v } }, partId('k'), ['y'], place, c.loc);
        if (p) ts[0].end = { part: p.id, port: 'y' };
        ctx.tally.add(c.name, 'constant');
        return;
      }
      case 'splitter': {
        realizeSplitter(ctx, c, kd, ts, splitDir.get(ci) ?? 'split', place, partId, where(c));
        return;
      }
      case 'sub': {
        const sub = ctx.ifaces.get(c.name)!;
        if (!ctx.defs.has(sub.id)) { stub(ctx, c, kd, ts, where(c), 'not available'); placeStub(ctx, c, kd, ts, place, partId); return; }
        const p = alignPlace(ctx, kd, ts, { chip: sub.id }, partId(logisimName(lbl) || slug(c.name), !!logisimName(lbl)), sub.pins.map((q) => q.name), place, c.loc, lbl || undefined);
        if (p) {
          ts.forEach((t, i) => (t.end = { part: p.id, port: sub.pins[i].name }));
          if (sub.clock) {
            const g = portAt(p, sub.clock);
            const e = EXIT[g.exit];
            wire({ part: p.id, port: sub.clock }, label(iface.clock!, [g.pos[0] + 2 * e[0], g.pos[1] + 2 * e[1]], g.exit));
          }
        }
        ctx.tally.add('subcircuit', 'your chip');
        return;
      }
      case 'unknown': {
        stub(ctx, c, kd, ts, where(c), 'no equivalent here; the pins are guessed from the wires at its location');
        placeStub(ctx, c, kd, ts, place, partId);
        return;
      }
    }
    const conn = new Set(ts.filter(connected).map((t) => t.port.key));
    const env: Env = { ctx, orig: ctx.orig, ver: proj.ver, hc: proj.hc, conn, where: where(c) };
    const r = kd.make!(env);
    if ('drop' in r) {
      ctx.tally.add(c.name, r.drop, 'dropped');
      if (r.problem) ctx.problems.push(`${where(c)}: ${r.problem}`);
      return;
    }
    if (r.status === 'stub' || !r.parts.length) {
      stub(ctx, c, kd, ts, where(c), r.problem ?? 'no equivalent here');
      placeStub(ctx, c, kd, ts, place, partId);
      return;
    }
    ctx.tally.add(c.name, r.becomes);
    if (r.problem) ctx.problems.push(`${where(c)}: ${r.problem}`);
    const main = r.parts[0];
    const mapped = ts.filter((t) => r.map[t.port.key]?.[0] === 0);
    const p0 = alignPlace(ctx, kd, mapped, main.ref, partId(logisimName(lbl) || main.prefix, !!logisimName(lbl)), mapped.map((t) => r.map[t.port.key][1]), place, c.loc, lbl || main.label);
    if (!p0) { ctx.problems.push(`${where(c)}: could not be built`); return; }
    const placed: PartDoc[] = [p0];
    // the other parts, beside the port of the part they link to
    r.parts.slice(1).forEach((rp, j) => {
      const link = r.links?.find((l) => l[2] === j + 1 && placed[l[0]]);
      const p = place(partId(rp.prefix), rp.ref, [0, 0], {}, rp.label);
      if (!p) return;
      placed[j + 1] = p;
      if (link) {
        const g = portAt(placed[link[0]], link[1]);
        const e = EXIT[g.exit];
        const mine = instPort(defs.get(p.id)!, [0, 0], false, link[3]);
        p.at = [g.pos[0] + 4 * e[0] - mine.pos[0], g.pos[1] + 4 * e[1] - mine.pos[1]];
      } else p.at = [p0.at[0], p0.at[1] - 6];
    });
    for (const [i, a, j, b] of r.links ?? []) if (placed[i] && placed[j]) wire({ part: placed[i].id, port: a }, { part: placed[j].id, port: b });
    for (const [i, port, w, v] of r.ties ?? []) if (placed[i]) tie(placed[i], port, w, v);
    for (const t of ts) {
      const m = r.map[t.port.key];
      if (m && placed[m[0]]) t.end = { part: placed[m[0]].id, port: m[1] };
    }
  });

  // ---- wires: per geometric group, a tree from the first terminal along Logisim's own segments ----
  const adj = new Map<string, string[]>();
  const link = (a: Vec, b: Vec) => {
    const [ka, kb] = [key(a), key(b)];
    if (ka === kb) return;
    (adj.get(ka) ?? adj.set(ka, []).get(ka)!).push(kb);
    (adj.get(kb) ?? adj.set(kb, []).get(kb)!).push(ka);
  };
  for (const pts of onWire) for (let i = 1; i < pts.length; i++) link(pts[i - 1], pts[i]);
  const groups = new Map<string, Term[]>();
  for (const t of terms) {
    if (!t.end) continue;
    const w = netWidth.get(netOf(t));
    if (w !== undefined && t.port.w !== w) continue;
    const g = geo.find(key(t.at));
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(t);
  }
  for (const ts of groups.values()) {
    if (ts.length < 2) continue;
    const root = ts[0];
    const rk = key(root.at);
    const parent = new Map<string, string | null>([[rk, null]]);
    const queue = [rk];
    while (queue.length) {
      const k = queue.shift()!;
      for (const n of adj.get(k) ?? []) if (!parent.has(n)) { parent.set(n, k); queue.push(n); }
    }
    const covered = new Map<string, string>();
    for (const t of ts.slice(1)) {
      let k: string | null = key(t.at);
      if (!parent.has(k)) continue;
      const path: string[] = [];
      while (k !== null && !covered.has(k) && !(k === rk && !covered.size)) { path.push(k); k = parent.get(k)!; }
      let id: string;
      if (k !== null && covered.has(k)) {
        id = wire(t.end!, { wire: covered.get(k)!, at: unit(nodes.get(k)!) }, path.map((q) => unit(nodes.get(q)!)));
      } else {
        path.push(rk);
        id = wire(t.end!, root.end!, path.map((q) => unit(nodes.get(q)!)));
      }
      for (const q of path) if (!covered.has(q)) covered.set(q, id);
    }
  }
  if (comments.length) doc.comments = comments;
  addChip(ctx, doc);
}

type Orient = { flip?: boolean; rot?: 1 | 2 | 3 };
type Placer = (id: string, ref: PartRef, at: Vec, o?: Orient, lbl?: string) => PartDoc | null;
const ORIENTS: Orient[] = [{}, { flip: true }, { rot: 1 }, { rot: 3 }, { rot: 2 }, { flip: true, rot: 1 }, { flip: true, rot: 3 }, { flip: true, rot: 2 }];
const PREFER: Record<Dir, Orient> = { east: {}, west: { flip: true }, north: { rot: 3 }, south: { rot: 1 } };

/**
 * Place a part so its ports land as close as they can to the Logisim ports they stand for: every quarter turn
 * and mirror image is tried, the part's facing first, and the one with the least squared distance wins.
 */
function alignPlace(ctx: Ctx, kd: Kind, ts: Term[], ref: PartRef, id: string, ports: string[], place: Placer, at0: Vec, lbl?: string): PartDoc | null {
  const d = defOfRef(ctx, ref);
  if (!d) return null;
  const targets = ts.map((t) => unit(t.at));
  const pref = PREFER[kd.facing];
  if (!targets.length) return place(id, ref, unit(at0), pref, lbl);
  const order = [pref, ...ORIENTS.filter((o) => !!o.flip !== !!pref.flip || o.rot !== pref.rot)];
  let best: { o: Orient; at: Vec; err: number } | null = null;
  for (const o of order) {
    const loc = ports.map((p) => instPort(d, [0, 0], o.flip, p, o.rot).pos);
    const off: Vec = [0, 1].map((ax) => Math.round(targets.reduce((s, t, i) => s + t[ax] - loc[i][ax], 0) / targets.length)) as Vec;
    const err = targets.reduce((s, t, i) => s + (t[0] - loc[i][0] - off[0]) ** 2 + (t[1] - loc[i][1] - off[1]) ** 2, 0);
    if (!best || err < best.err - 1e-9) best = { o, at: off, err };
  }
  return place(id, ref, best!.at, best!.o, lbl);
}

/** Record a stub: an empty chip with a pin per Logisim port, so the wires to it survive. */
function stub(ctx: Ctx, c: LComp, kd: Kind, ts: Term[], where: string, why: string): void {
  ctx.tally.add(c.name, 'empty chip, same pins', 'stub');
  ctx.problems.push(`${where}: ${why}; an empty chip with its ${ts.length} pin${ts.length === 1 ? '' : 's'} stands in`);
  void kd;
}

function placeStub(ctx: Ctx, c: LComp, kd: Kind, ts: Term[], place: Placer,
  partId: (b: string, named?: boolean) => string): void {
  const names = ts.map((t, i) => logisimName(t.port.key) || `p${i}`);
  const pins = ts.map((t, i) => ({ name: names[i], dir: t.port.dir === 'out' ? 'out' as const : 'in' as const, w: t.port.w }));
  const keyS = `stub:${c.name}:${pins.map((p) => `${p.name}${p.dir}${p.w}`).join(',')}`;
  const id = helper(ctx, keyS, `${c.name} (not imported)`, (k) => { for (const p of pins) (p.dir === 'in' ? k.in(p.name, p.w) : k.out(p.name, p.w)); });
  const lbl = (c.a.get('label') ?? '').trim();
  const p = alignPlace(ctx, kd, ts, { chip: id }, partId(logisimName(lbl) || 'x', !!logisimName(lbl)), names, place, c.loc, lbl || c.name);
  if (p) ts.forEach((t, i) => (t.end = { part: p.id, port: names[i] }));
}

function realizeSplitter(ctx: Ctx, c: LComp, kd: Kind, ts: Term[], dir: 'split' | 'merge', place: Placer,
  partId: (b: string, named?: boolean) => string, where: string): void {
  const fanout = Math.max(1, num(c.a.get('fanout'), 2));
  const incoming = Math.max(1, num(c.a.get('incoming'), 2));
  const ends = splitterEnds(c, fanout, incoming);
  // runs of consecutive bits on one end
  const runs: { end: number; w: number }[] = [];
  for (const e of ends) {
    const last = runs[runs.length - 1];
    if (last && last.end === e) last.w++;
    else runs.push({ end: e, w: 1 });
  }
  const used = runs.filter((r) => r.end >= 0).map((r) => r.end);
  const simple = new Set(used).size === used.length && (dir === 'split' || runs.every((r) => r.end >= 0));
  const comb = ts.find((t) => t.port.key === 'c')!;
  if (simple) {
    const widths = runs.map((r) => r.w);
    const ends2 = ts.filter((t) => t !== comb);
    const portOf = (t: Term) => {
      const e = +t.port.key.slice(1);
      return `${dir === 'split' ? 'o' : 'i'}${runs.findIndex((r) => r.end === e)}`;
    };
    const inOrder = runs.every((r, i) => r.end === i);
    const pitch = inOrder ? Math.max(1, num(c.a.get('spacing'), 1)) : 2;
    const ref: PartRef = dir === 'split' ? { split: widths, ...(pitch !== 2 ? { pitch } : {}) } : { merge: widths, ...(pitch !== 2 ? { pitch } : {}) };
    const all = [comb, ...ends2];
    const p = alignPlace(ctx, kd, all, ref, partId('sp'), [dir === 'split' ? 'in' : 'out', ...ends2.map(portOf)], place, c.loc);
    if (p) {
      comb.end = { part: p.id, port: dir === 'split' ? 'in' : 'out' };
      for (const t of ends2) t.end = { part: p.id, port: portOf(t) };
    }
    ctx.tally.add('Splitter', dir === 'split' ? 'splitter' : 'merger');
    return;
  }
  // bits in another order: a chip that splits to single bits and gathers them per end
  const endW = (e: number) => ends.filter((x) => x === e).length;
  const key2 = `splitter:${dir}:${ends.join(',')}`;
  const id = helper(ctx, key2, `Splitter ${incoming} ↔ ${[...new Set(used)].map(endW).join('+')}`, (k) => {
    const bitNet = (b: number) => `b${b}`;
    if (dir === 'split') k.in('c', incoming); else k.out('c', incoming);
    for (let e = 0; e < fanout; e++) if (endW(e)) (dir === 'split' ? k.out(`e${e}`, endW(e)) : k.in(`e${e}`, endW(e)));
    k.bits('c', incoming, ends.map((_, b) => bitNet(b)), dir === 'split' ? 'split' : 'merge');
    for (let e = 0; e < fanout; e++) {
      const bs = ends.map((x, b) => (x === e ? b : -1)).filter((b) => b >= 0);
      if (bs.length) k.bits(`e${e}`, bs.length, bs.map(bitNet), dir === 'split' ? 'merge' : 'split');
    }
  });
  const names = ts.map((t) => t.port.key);
  const p = alignPlace(ctx, kd, ts, { chip: id }, partId('sp'), names, place, c.loc);
  if (p) ts.forEach((t) => (t.end = { part: p.id, port: t.port.key }));
  ctx.tally.add('Splitter', dir === 'split' ? 'splitter chip (bits reordered)' : 'merger chip (bits reordered)');
  if (dir === 'merge' && runs.some((r) => r.end < 0)) ctx.problems.push(`${where}: bits left unconnected on a splitter used as a merger read X`);
}

// ---------------------------------------------------------------------------------------------
// Helper chips: drawn with pointers (each port taps a pointer named after its net), laid out in columns.

class Kit {
  pins: { name: string; dir: 'in' | 'out'; w: number; net: string; clock?: boolean }[] = [];
  parts: { id: string; ref: PartRef; conns: [string, string][] }[] = [];
  private n = 0;
  in(name: string, w = 1, net = name, clock = false): void { this.pins.push({ name, dir: 'in', w, net, clock }); }
  out(name: string, w = 1, net = name): void { this.pins.push({ name, dir: 'out', w, net }); }
  part(ref: PartRef, conns: Record<string, string>, prefix = 'u'): string {
    const id = `${prefix}${++this.n}`;
    this.parts.push({ id, ref, conns: Object.entries(conns) });
    return id;
  }
  /** A fresh net name. */
  net(): string { return `_n${++this.n}`; }
  /** A constant on a fresh net. */
  k(w: number, v: number): string {
    const n = this.net();
    this.part({ const: { width: w, value: v } }, { y: n }, 'k');
    return n;
  }
  gate(op: string, a: string, b?: string): string {
    const y = this.net();
    this.part({ lib: op }, b === undefined ? { a, y } : { a, b, y }, 'g');
    return y;
  }
  /** A bus net and its bits: split (the bus drives the bits) or merge (the bits drive the bus). */
  bits(bus: string, w: number, bits: string[], how: 'split' | 'merge'): void {
    if (w === 1) { this.part({ split: [1] }, how === 'split' ? { in: bus, o0: bits[0] } : { in: bits[0], o0: bus }, 's'); return; }
    const conns: Record<string, string> = { [how === 'split' ? 'in' : 'out']: bus };
    bits.forEach((b, i) => (conns[`${how === 'split' ? 'o' : 'i'}${i}`] = b));
    this.part(how === 'split' ? { split: ones(w), pitch: 1 } : { merge: ones(w), pitch: 1 }, conns, 's');
  }
  split(bus: string, w: number): string[] {
    if (w === 1) return [bus];
    const bs = Array.from({ length: w }, () => this.net());
    this.bits(bus, w, bs, 'split');
    return bs;
  }
  merge(bits: string[], bus = this.net()): string {
    this.bits(bus, bits.length, bits, 'merge');
    return bus;
  }

  doc(ctx: Ctx, id: string, name: string): ChipDoc {
    const pins: PinDoc[] = [], parts: PartDoc[] = [], wires: WireDoc[] = [], labels: LabelDoc[] = [];
    let nl = 0, nw = 0;
    const tap = (end: EndRef, pos: Vec, exit: ExitDir, net: string) => {
      const e = EXIT[exit];
      const l = `l${++nl}`;
      labels.push({ id: l, name: net, at: [pos[0] + 2 * e[0], pos[1] + 2 * e[1]], face: exit });
      wires.push({ id: `w${++nw}`, a: end, b: { label: l }, pts: [] });
    };
    // columns of parts, at most ~48 units tall
    let x = 8, y = 0, colW = 0;
    for (const p of this.parts) {
      const d = defOfRef(ctx, p.ref);
      if (!d) continue;
      const g = symbolGeom(d);
      if (y > 0 && y + g.h > 48) { x += colW + 10; y = 0; colW = 0; }
      const at: Vec = [x, y + 2];
      parts.push({ id: p.id, ref: p.ref, at });
      for (const [port, net] of p.conns) {
        const ip = instPort(d, at, false, port);
        tap({ part: p.id, port }, ip.pos, ip.exit, net);
      }
      y += g.h + 5;
      colW = Math.max(colW, g.w);
    }
    const right = x + colW + 10;
    let yi = 2, yo = 2;
    for (const p of this.pins) {
      const at: Vec = p.dir === 'in' ? [0, yi] : [right, yo];
      if (p.dir === 'in') yi += 4; else yo += 4;
      pins.push({ id: p.name, name: p.name, dir: p.dir, width: p.w, at, ...(p.clock ? { kind: 'clock' as const } : {}) });
      tap({ pin: p.name }, at, p.dir === 'in' ? 'right' : 'left', p.net);
    }
    return { id, name, pins, parts, wires, labels };
  }
}

function helper(ctx: Ctx, key2: string, name: string, build: (k: Kit) => void): string {
  const hit = ctx.helpers.get(key2);
  if (hit) return hit;
  const k = new Kit();
  build(k);
  const id = freshId(ctx, `lg_${name}`);
  addChip(ctx, k.doc(ctx, id, name));
  ctx.helpers.set(key2, id);
  return id;
}

/** A Real that is one helper chip whose pins are the Logisim port keys (ties: open inputs held at Logisim's value). */
function viaHelper(env: Env, key2: string, name: string, keys: string[], build: (k: Kit) => void, becomes: string,
  ties: Record<string, [number, number]> = {}, problem?: string): Real {
  const id = helper(env.ctx, key2, name, build);
  const map: Real['map'] = {};
  for (const k of keys) map[k] = [0, k];
  return {
    parts: [{ ref: { chip: id }, prefix: 'u' }], map, becomes, problem,
    ties: Object.entries(ties).filter(([k]) => !env.conn.has(k)).map(([k, [w, v]]) => [0, k, w, v]),
  };
}

// ---- gates ----------------------------------------------------------------------------------

const LIB2: Record<string, string> = {
  'AND Gate': 'and', 'OR Gate': 'or', 'NAND Gate': 'nand', 'NOR Gate': 'nor', 'XOR Gate': 'xor', 'XNOR Gate': 'xnor', 'Odd Parity': 'xor', 'Even Parity': 'xnor',
};

function makeGate(env: Env, n: string, op: { base: 'and' | 'or' | 'xor'; inv: boolean }, inputs: number, w: number, neg: (i: number) => boolean, xorOne: boolean): Real | { drop: string; problem?: string } {
  // Logisim ignores inputs left open.
  const used = Array.from({ length: inputs }, (_, i) => i).filter((i) => env.conn.has(`i${i}`));
  if (!used.length) return { drop: 'left out (no input connected)', problem: 'no input connected: left out' };
  const negs = used.map(neg);
  if (used.length === 2 && w === 1 && !negs.some((x) => x)) {
    return { parts: [{ ref: { lib: LIB2[n] }, prefix: 'g' }], map: { [`i${used[0]}`]: [0, 'a'], [`i${used[1]}`]: [0, 'b'], y: [0, 'y'] }, becomes: `${LIB2[n].toUpperCase()} gate` };
  }
  if (used.length === 1 && w === 1 && !negs[0] && op.inv) {
    return { parts: [{ ref: { lib: 'not' }, prefix: 'g' }], map: { [`i${used[0]}`]: [0, 'a'], y: [0, 'y'] }, becomes: 'NOT gate (one input connected)' };
  }
  const one = op.base === 'xor' && xorOne && used.length > 2;
  const k2 = `gate:${n}:${used.length}:${w}:${negs.map(Number).join('')}:${one ? 1 : 0}`;
  const label = `${n.replace(' Gate', '')} ×${used.length}${w > 1 ? ` (${w}-bit)` : ''}${negs.some((x) => x) ? ' ¬' : ''}`;
  const id = helper(env.ctx, k2, label, (k) => {
    used.forEach((_, j) => k.in(`i${j}`, w));
    k.out('y', w);
    const ins = used.map((_, j) => k.split(`i${j}`, w));
    const outs: string[] = [];
    for (let b = 0; b < w; b++) {
      const xs = ins.map((bits, j) => (negs[j] ? k.gate('not', bits[b]) : bits[b]));
      let y: string;
      if (one) {
        // exactly one input high: any of them, and no two
        const any = tree(k, 'or', xs);
        const pairs: string[] = [];
        for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) pairs.push(k.gate('and', xs[i], xs[j]));
        y = k.gate('and', any, k.gate('not', tree(k, 'or', pairs)));
      } else {
        y = tree(k, op.base, xs);
      }
      if (op.inv) y = k.gate('not', y);
      outs.push(y);
    }
    if (w === 1) k.part({ split: [1] }, { in: outs[0], o0: 'y' }, 's');
    else k.merge(outs, 'y');
  });
  const map: Real['map'] = { y: [0, 'y'] };
  used.forEach((i, j) => (map[`i${i}`] = [0, `i${j}`]));
  return { parts: [{ ref: { chip: id }, prefix: 'g' }], map, becomes: 'gate chip (inputs / width / negations)' };
}

/** A balanced tree of 2-input gates (one input: the wire itself). */
function tree(k: Kit, op: string, xs: string[]): string {
  let level = xs;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) next.push(k.gate(op, level[i], level[i + 1]));
    if (level.length % 2) next.push(level[level.length - 1]);
    level = next;
  }
  return level[0];
}

function makeNot(env: Env, invert: boolean, w: number): Real {
  if (invert && w === 1) return { parts: [{ ref: { lib: 'not' }, prefix: 'g' }], map: { a: [0, 'a'], y: [0, 'y'] }, becomes: 'NOT gate' };
  return viaHelper(env, `not:${invert}:${w}`, `${invert ? 'NOT' : 'Buffer'}${w > 1 ? ` (${w}-bit)` : ''}`, ['a', 'y'], (k) => {
    k.in('a', w); k.out('y', w);
    if (!invert) { k.part({ split: [w] }, { in: 'a', o0: 'y' }, 's'); return; }
    k.merge(k.split('a', w).map((b) => k.gate('not', b)), 'y');
  }, invert ? 'NOT chip (bus)' : 'wire (a buffer only delays)');
}

// ---- plexers --------------------------------------------------------------------------------

const muxId = (sel: number, w: number) => (sel === 1 ? `mux2tree${w}` : `mux${1 << sel}x${w}`);

function makeMux(env: Env, sel: number, w: number, enable: boolean): Real {
  const N = 1 << sel;
  const map: Real['map'] = { s: [0, 's'], y: [0, 'y'] };
  for (let i = 0; i < N; i++) map[`d${i}`] = [0, `d${i}`];
  if (!enable || !env.conn.has('en')) return { parts: [{ ref: { lib: muxId(sel, w) }, prefix: 'mux' }], map, becomes: 'multiplexer' };
  return viaHelper(env, `mux:${sel}:${w}:en`, `Mux ${N}×${w} with enable`, [...Object.keys(map), 'en'], (k) => {
    const conns: Record<string, string> = { s: 's', y: k.net() };
    for (let i = 0; i < N; i++) { k.in(`d${i}`, w); conns[`d${i}`] = `d${i}`; }
    k.in('s', sel); k.in('en'); k.out('y', w);
    k.part({ lib: muxId(sel, w) }, conns, 'm');
    const ys = k.split(conns.y, w).map((b) => k.gate('and', b, 'en'));
    if (w === 1) k.part({ split: [1] }, { in: ys[0], o0: 'y' }, 's'); else k.merge(ys, 'y');
  }, 'multiplexer with enable (0 when disabled)');
}

function makeDemux(env: Env, sel: number, w: number, enable: boolean): Real {
  const N = 1 << sel;
  const en = enable && env.conn.has('en');
  const keys = ['x', 's', ...Array.from({ length: N }, (_, i) => `y${i}`), ...(en ? ['en'] : [])];
  return viaHelper(env, `demux:${sel}:${w}:${en}`, `Demux ${N}×${w}${en ? ' with enable' : ''}`, keys, (k) => {
    k.in('x', w); k.in('s', sel); if (en) k.in('en');
    const dec: Record<string, string> = { a: 's' };
    if (en) dec.en = 'en';
    const lines = Array.from({ length: N }, () => k.net());
    lines.forEach((l, i) => (dec[`y${i}`] = l));
    k.part({ lib: `dec${sel}${en ? 'e' : ''}` }, dec, 'dec');
    const xs = k.split('x', w);
    lines.forEach((l, i) => {
      k.out(`y${i}`, w);
      const ys = xs.map((b) => k.gate('and', b, l));
      if (w === 1) k.part({ split: [1] }, { in: ys[0], o0: `y${i}` }, 's'); else k.merge(ys, `y${i}`);
    });
  }, 'demultiplexer chip (decoder + AND)');
}

function makeDecoder(env: Env, sel: number, enable: boolean): Real {
  const N = 1 << sel;
  const map: Real['map'] = { s: [0, 'a'] };
  for (let i = 0; i < N; i++) map[`y${i}`] = [0, `y${i}`];
  if (enable) map.en = [0, 'en'];
  if (sel > 9) return { parts: [], map: {}, becomes: '', status: 'stub', problem: 'more than 9 select bits' };
  return {
    parts: [{ ref: { lib: `dec${sel}${enable ? 'e' : ''}` }, prefix: 'dec' }], map, becomes: 'decoder',
    ties: enable && !env.conn.has('en') ? [[0, 'en', 1, 1]] : [],
  };
}

function makeBitSelector(env: Env, width: number, group: number, selBits: number): Real {
  const N = 1 << selBits;
  return viaHelper(env, `bitsel:${width}:${group}`, `Bit selector ${width}→${group}`, ['a', 's', 'y'], (k) => {
    k.in('a', width); k.in('s', selBits); k.out('y', group);
    // the input in groups of `group` bits, the last one padded with zeros, unused inputs 0
    const groups = Math.ceil(width / group);
    const widths: number[] = [];
    for (let g = 0; g < groups; g++) widths.push(Math.min(group, width - g * group));
    const parts = widths.map(() => k.net());
    if (groups === 1) k.part({ split: [width] }, { in: 'a', o0: parts[0] }, 's');
    else {
      const conns: Record<string, string> = { in: 'a' };
      parts.forEach((p, i) => (conns[`o${i}`] = p));
      k.part({ split: widths }, conns, 's');
    }
    const full = parts.map((p, g) => {
      if (widths[g] === group) return p;
      const m = k.net();
      k.part({ merge: [widths[g], group - widths[g]] }, { i0: p, i1: k.k(group - widths[g], 0), out: m }, 's');
      return m;
    });
    const conns: Record<string, string> = { s: 's', y: 'y' };
    for (let i = 0; i < N; i++) conns[`d${i}`] = full[i] ?? k.k(group, 0);
    k.part({ lib: muxId(selBits, group) }, conns, 'm');
  }, 'bit selector chip (multiplexer)');
}

// ---- arithmetic -----------------------------------------------------------------------------

function makeArith(env: Env, n: string, w: number, mode: string): Real {
  if (w > 53) return { parts: [], map: {}, becomes: '', status: 'stub', problem: 'wider than 53 bits' };
  if (n === 'Adder') {
    return {
      parts: [{ ref: { lib: `rca${w}` }, prefix: 'add' }], map: { a: [0, 'a'], b: [0, 'b'], y: [0, 's'], ci: [0, 'cin'], co: [0, 'cout'] },
      becomes: 'ripple-carry adder', ties: env.conn.has('ci') ? [] : [[0, 'cin', 1, 0]],
    };
  }
  if (n === 'Subtractor') {
    return viaHelper(env, `sub:${w}`, `Subtractor ${w}-bit`, ['a', 'b', 'y', 'ci', 'co'], (k) => {
      k.in('a', w); k.in('b', w); k.in('ci'); k.out('y', w); k.out('co');
      const nb = k.net(), cout = k.net();
      k.part({ lib: `xorx${w}` }, { a: 'b', b: k.k(w, allOnes(w)), y: nb }, 'x');
      k.part({ lib: `rca${w}` }, { a: 'a', b: nb, cin: k.gate('not', 'ci'), s: 'y', cout }, 'add');
      k.part({ lib: 'not' }, { a: cout, y: 'co' }, 'g');
    }, 'subtractor chip (adder, inverted b)', { ci: [1, 0] });
  }
  // Multiplier: the library's tree multipliers, low half out, high half on the carry out.
  const signed = mode === 'twosComplement';
  if (![4, 8, 16].includes(w) || mode === 'signedUnsigned' || env.conn.has('ci')) {
    return { parts: [], map: {}, becomes: '', status: 'stub', problem: 'only 4-, 8- and 16-bit multipliers without a carry in are imported' };
  }
  return viaHelper(env, `mul:${w}:${signed}`, `Multiplier ${w}-bit${signed ? ' signed' : ''}`, ['a', 'b', 'y', 'ci', 'co'], (k) => {
    k.in('a', w); k.in('b', w); k.in('ci', w); k.out('y', w); k.out('co', w);
    const p = k.net();
    k.part({ lib: `wmul${w}${signed ? 's' : ''}` }, { a: 'a', b: 'b', p }, 'mul');
    k.part({ split: [w, w] }, { in: p, o0: 'y', o1: 'co' }, 's');
  }, 'Wallace-tree multiplier chip');
}

function makeComparator(env: Env, w: number, signed: boolean): Real {
  if (w > 53) return { parts: [], map: {}, becomes: '', status: 'stub', problem: 'wider than 53 bits' };
  return viaHelper(env, `cmp:${w}:${signed}`, `Comparator ${w}-bit${signed ? ' signed' : ''}`, ['a', 'b', 'gt', 'eq', 'lt'], (k) => {
    k.in('a', w); k.in('b', w); k.out('gt'); k.out('eq'); k.out('lt');
    const s = k.net(), co = k.net(), v = k.net(), neg = k.net();
    k.part({ lib: `addsub${w}` }, { a: 'a', b: 'b', sub: k.k(1, 1), s, cout: co, v, n: neg }, 'sub');
    k.part({ lib: `zero${w}` }, { a: s, z: 'eq' }, 'z');
    if (signed) k.part({ lib: 'xor' }, { a: neg, b: v, y: 'lt' }, 'g');
    else k.part({ lib: 'not' }, { a: co, y: 'lt' }, 'g');
    k.part({ lib: 'nor' }, { a: 'lt', b: 'eq', y: 'gt' }, 'g');
  }, `comparator chip (subtractor${signed ? ', signed' : ''})`);
}

function makeNegator(env: Env, w: number): Real {
  if (w > 53) return { parts: [], map: {}, becomes: '', status: 'stub', problem: 'wider than 53 bits' };
  return viaHelper(env, `neg:${w}`, `Negator ${w}-bit`, ['a', 'y'], (k) => {
    k.in('a', w); k.out('y', w);
    k.part({ lib: `addsub${w}` }, { a: k.k(w, 0), b: 'a', sub: k.k(1, 1), s: 'y' }, 'sub');
  }, 'negator chip (0 − a)');
}

function makeShifter(env: Env, w: number, shift: string): Real {
  void env;
  if (w < 2 || (w & (w - 1)) || !['ll', 'lr', 'ar'].includes(shift)) {
    return { parts: [], map: {}, becomes: '', status: 'stub', problem: 'only logical / arithmetic shifts of 2^n-bit words are imported' };
  }
  return {
    parts: [{ ref: { lib: `shift${w}` }, prefix: 'sh' }], map: { a: [0, 'a'], d: [0, 'sh'], y: [0, 'y'] }, becomes: 'barrel shifter',
    ties: [[0, 'left', 1, shift === 'll' ? 1 : 0], [0, 'arith', 1, shift === 'ar' ? 1 : 0]],
  };
}

function makeExtender(env: Env, iw: number, ow: number, type: string): Real {
  const keys = ['a', 'y', ...(type === 'input' ? ['x'] : [])];
  return viaHelper(env, `ext:${iw}:${ow}:${type}`, `Extend ${iw}→${ow} (${type})`, keys, (k) => {
    k.in('a', iw); if (type === 'input') k.in('x'); k.out('y', ow);
    if (ow <= iw) {
      if (ow === iw) k.part({ split: [iw] }, { in: 'a', o0: 'y' }, 's');
      else k.part({ split: [ow, iw - ow] }, { in: 'a', o0: 'y' }, 's');
      return;
    }
    const bits = k.split('a', iw);
    const fill = type === 'zero' ? k.k(1, 0) : type === 'one' ? k.k(1, 1) : type === 'input' ? 'x' : bits[iw - 1];
    k.merge([...bits, ...Array.from({ length: ow - iw }, () => fill)], 'y');
  }, `bit extender chip (${type})`);
}

// ---- memory ---------------------------------------------------------------------------------

/** The clock a storage element reacts to: rising as wired, falling through an inverter. */
const clockNet = (k: Kit, trig: string) => (trig === 'falling' ? k.gate('not', 'clk') : 'clk');

function makeFlipFlop(env: Env, n: string, data: string[], trig: string): Real {
  const rst = env.conn.has('rst'), set = env.conn.has('set');
  const keys = [...data, 'clk', 'q', 'nq', 'rst', 'set'];
  const latch = trig === 'high' || trig === 'low';
  if (latch && (n !== 'D Flip-Flop' || rst || set)) return { parts: [], map: {}, becomes: '', status: 'stub', problem: 'level-triggered flip-flops other than a plain D latch are not imported' };
  const preset = set && !rst && n === 'D Flip-Flop';
  const problem = set && !preset ? 'its preset input is not imported (left open)' : undefined;
  return viaHelper(env, `ff:${n}:${trig}:${rst}:${preset}`, `${n.replace(' Flip-Flop', '')} flip-flop${latch ? ' (latch)' : ''}${rst ? ' + reset' : ''}${preset ? ' + preset' : ''}`, keys, (k) => {
    for (const d of data) k.in(d);
    k.in('clk', 1, 'clk', true); k.in('rst'); k.in('set');
    k.out('q'); k.out('nq');
    const q = k.net();
    if (latch) {
      k.part({ lib: 'd_latch' }, { d: 'd', e: trig === 'low' ? k.gate('not', 'clk') : 'clk', q }, 'ff');
    } else {
      const clk = clockNet(k, trig);
      const rstN = rst ? k.gate('not', 'rst') : k.k(1, 1);
      if (n === 'D Flip-Flop' && preset) {
        // a preset is a reset of the inverted value
        const s = k.net();
        k.part({ lib: 'dff_r' }, { d: k.gate('not', 'd'), clk, rst_n: k.gate('not', 'set'), q: s }, 'ff');
        k.part({ lib: 'not' }, { a: s, y: q }, 'g');
      } else if (n === 'D Flip-Flop') k.part({ lib: 'dff_r' }, { d: 'd', clk, rst_n: rstN, q }, 'ff');
      else if (n === 'T Flip-Flop') k.part({ lib: 'tff' }, { t: 't', clk, rst_n: rstN, q }, 'ff');
      else k.part({ lib: 'jkff' }, { j: data[0], k: data[1], clk, rst_n: rstN, q }, 'ff');
    }
    k.part({ split: [1] }, { in: q, o0: 'q' }, 's');
    k.part({ lib: 'not' }, { a: q, y: 'nq' }, 'g');
  }, `${n.replace(' Flip-Flop', '')} flip-flop chip`, { rst: [1, 0], set: [1, 0] }, problem);
}

function makeRegister(env: Env, w: number, trig: string): Real {
  if (trig === 'high' || trig === 'low') return { parts: [], map: {}, becomes: '', status: 'stub', problem: 'level-triggered registers are not imported' };
  if (!env.conn.has('clr') && trig === 'rising') {
    return {
      parts: [{ ref: { lib: `reg${w}` }, prefix: 'reg' }], map: { d: [0, 'd'], q: [0, 'q'], clk: [0, 'clk'], en: [0, 'en'] }, becomes: 'register',
      ties: env.conn.has('en') ? [] : [[0, 'en', 1, 1]],
    };
  }
  return viaHelper(env, `reg:${w}:${trig}`, `Register ${w}-bit with clear${trig === 'falling' ? ' (falling edge)' : ''}`, ['d', 'q', 'clk', 'clr', 'en'], (k) => {
    k.in('d', w); k.in('en'); k.in('clk', 1, 'clk', true); k.in('clr'); k.out('q', w);
    const clk = clockNet(k, trig), rstN = k.gate('not', 'clr');
    const ds = k.split('d', w);
    const qs = ds.map(() => k.net());
    ds.forEach((d, i) => {
      const m = k.net();
      k.part({ lib: 'mux2tree1' }, { d0: qs[i], d1: d, s: 'en', y: m }, 'm');
      k.part({ lib: 'dff_r' }, { d: m, clk, rst_n: rstN, q: qs[i] }, 'ff');
    });
    if (w === 1) k.part({ split: [1] }, { in: qs[0], o0: 'q' }, 's'); else k.merge(qs, 'q');
  }, 'register chip (clear, enable)', { en: [1, 1], clr: [1, 0] });
}

function makeCounter(env: Env, w: number, max0: bigint, goal: string, trig: string): Real {
  if (w > 53 || trig === 'high' || trig === 'low') return { parts: [], map: {}, becomes: '', status: 'stub', problem: 'counters wider than 53 bits or level-triggered are not imported' };
  const max = Number(BigInt.asUintN(w, max0 & ((1n << BigInt(w)) - 1n)) || BigInt(allOnes(w)));
  const keys = ['q', 'd', 'clk', 'clr', 'ld', 'ud', 'en', 'carry'];
  return viaHelper(env, `cnt:${w}:${max}:${goal}:${trig}`, `Counter ${w}-bit to ${max} (${goal})`, keys, (k) => {
    k.in('d', w); k.in('clk', 1, 'clk', true); k.in('clr'); k.in('ld'); k.in('ud'); k.in('en');
    k.out('q', w); k.out('carry');
    const clk = clockNet(k, trig), rstN = k.gate('not', 'clr');
    const mux = (s: string, d0: string, d1: string, mw = w) => {
      const y = k.net();
      k.part({ lib: `mux2tree${mw}` }, { d0, d1, s, y }, 'm');
      return y;
    };
    const up = k.net(), down = k.net(), x = k.net(), atMax = k.net(), atZero = k.net();
    k.part({ lib: `inc${w}` }, { a: 'q', y: up }, 'inc');
    k.part({ lib: `rca${w}` }, { a: 'q', b: k.k(w, allOnes(w)), cin: k.k(1, 0), s: down }, 'dec');
    k.part({ lib: `xorx${w}` }, { a: 'q', b: k.k(w, max), y: x }, 'x');
    k.part({ lib: `zero${w}` }, { a: x, z: atMax }, 'z');
    k.part({ lib: `zero${w}` }, { a: 'q', z: atZero }, 'z');
    const hit = mux('ud', atZero, atMax, 1);
    const step = mux('ud', down, up);
    let inm = 'd';
    if (max !== allOnes(w)) { inm = k.net(); k.part({ lib: `andx${w}` }, { a: 'd', b: k.k(w, max), y: inm }, 'x'); }
    const goalV = goal === 'stay' ? 'q' : goal === 'load' ? inm : goal === 'continue' ? step : mux('ud', k.k(w, max), k.k(w, 0));
    const cnt = mux(hit, step, goalV);
    const kept = mux('en', 'q', cnt);
    const next = mux('ld', kept, inm);
    const ns = k.split(next, w);
    const qs = ns.map(() => k.net());
    ns.forEach((d, i) => k.part({ lib: 'dff_r' }, { d, clk, rst_n: rstN, q: qs[i] }, 'ff'));
    if (w === 1) k.part({ split: [1] }, { in: qs[0], o0: 'q' }, 's'); else k.merge(qs, 'q');
    k.part({ split: [1] }, { in: hit, o0: 'carry' }, 's');
  }, 'counter chip (load, up / down, enable, clear)', { ld: [1, 0], ud: [1, 1], en: [1, 1], clr: [1, 0], d: [w, 0] });
}

const romWidth = (w: number): 8 | 16 | 32 | 0 => (w <= 8 ? 8 : w <= 16 ? 16 : w <= 32 ? 32 : 0);

function hexImage(words: number[], w: number): string {
  let n = words.length;
  while (n > 0 && !words[n - 1]) n--;
  const digits = Math.ceil(w / 4);
  const lines: string[] = [];
  for (let i = 0; i < n; i += 8) lines.push(words.slice(i, Math.min(n, i + 8)).map((v) => (v >>> 0).toString(16).padStart(digits, '0')).join(' '));
  return lines.join('\n');
}

function makeRom(env: Env, k: number, w: number, contents: number[]): Real {
  const rw = romWidth(w);
  if (!rw || k > 16) return { parts: [], map: {}, becomes: '', status: 'stub', problem: 'ROMs wider than 32 bits or larger than 64K words are not imported' };
  const mask = w >= 32 ? 0xffffffff : allOnes(w);
  const ref: PartRef = { rom: { k, w: rw, addr: 'word', lang: 'hex', src: hexImage(contents.slice(0, 1 << k).map((v) => (v & mask) >>> 0), rw) } };
  const problem = env.conn.has('cs') ? 'its chip select is not imported (always selected)' : undefined;
  if (rw === w) return { parts: [{ ref, prefix: 'rom' }], map: { addr: [0, 'addr'], data: [0, 'data'] }, becomes: 'ROM (contents kept)', problem };
  return {
    parts: [{ ref, prefix: 'rom' }, { ref: { split: [w, rw - w] }, prefix: 'sp' }],
    map: { addr: [0, 'addr'], data: [1, 'o0'] }, links: [[0, 'data', 1, 'in']], becomes: 'ROM (contents kept) + splitter', problem,
  };
}

function makeRam(env: Env, k: number, w: number, contents: number[], trig: string): Real {
  if (k > 16 || w > 32) return { parts: [], map: {}, becomes: '', status: 'stub', problem: 'RAMs wider than 32 bits or larger than 64K words are not imported' };
  const init = contents.slice(0, 1 << k);
  const ref: PartRef = { ram: init.some((x) => x) ? { k, w, init } : { k, w } };
  const notes = [env.conn.has('oe') ? 'its output enable is not imported (always driving)' : '', env.conn.has('clr') ? 'its clear input is not imported' : '',
    trig === 'falling' ? 'it writes on the rising edge here' : ''].filter(Boolean);
  return {
    parts: [{ ref, prefix: 'ram' }], map: { addr: [0, 'addr'], din: [0, 'din'], dout: [0, 'dout'], we: [0, 'we'], clk: [0, 'clk'] },
    becomes: 'RAM (contents kept)', problem: notes.length ? notes.join('; ') : undefined,
    ties: env.conn.has('we') ? [] : [[0, 'we', 1, 0]],
  };
}

// ---------------------------------------------------------------------------------------------
// Test vectors: Logisim-evolution's format → Digital's test syntax (testtable.ts).

/**
 * A Logisim test-vector file in Digital's test syntax. Logisim: a header of names (`Sum[4]` for a bus), rows of
 * values (binary when the digits fill the width, else decimal; `0x` / `0o` / `0b` prefixes; `x` digits for don't
 * cares; `<DC>`, `<float>`), `#` comments, optional `<set>` / `<seq>` columns. Digital: plain names, values as
 * decimal, 0x… or 0b…, X for don't care, Z for floating. Names are made identifiers as the pins are on import.
 */
export function logisimVectors(text: string): { src: string } | { error: string } {
  const lines = text.split(/\r?\n/).map((l, i) => ({ n: i + 1, toks: l.replace(/#.*/, '').trim().split(/\s+/).filter(Boolean) })).filter((l) => l.toks.length);
  if (!lines.length) return { error: 'empty test vector file' };
  const head = lines[0].toks;
  let setCol = -1, seqCol = -1;
  const cols: { name: string; w: number }[] = [];
  for (let i = 0; i < head.length; i++) {
    const t = head[i];
    const u = t.toUpperCase();
    if (u === '<SET>') { setCol = i; continue; }
    if (u === '<SEQ>') { seqCol = i; continue; }
    const m = /^([^[\]]+)(?:\[(\d+)\])?$/.exec(t);
    if (!m) return { error: `line ${lines[0].n}: bad column "${t}"` };
    const w = m[2] ? +m[2] : 1;
    if (w < 1 || w > 64) return { error: `line ${lines[0].n}: bad width in "${t}"` };
    cols.push({ name: logisimName(m[1]) || `c${cols.length}`, w });
  }
  const out: string[] = [cols.map((c) => c.name).join(' ')];
  const notes = new Set<string>();
  let lastSet = 0;
  for (const l of lines.slice(1)) {
    const vals: string[] = [];
    let set = 0;
    let ci = 0;
    for (let i = 0; i < l.toks.length; i++) {
      const t = l.toks[i];
      if (i === setCol) { set = parseInt(t, 10) || 0; continue; }
      if (i === seqCol) continue;
      const c = cols[ci++];
      if (!c) return { error: `line ${l.n}: too many values` };
      const v = vectorValue(t, c.w);
      if ('error' in v) return { error: `line ${l.n}: ${v.error}` };
      if (v.partial) notes.add(`partial don't cares (${t}) are checked as X here`);
      vals.push(v.v);
    }
    if (ci < cols.length) return { error: `line ${l.n}: not enough values` };
    if (setCol >= 0 && set !== lastSet) { out.push(`# set ${set}`); lastSet = set; }
    out.push(vals.join(' '));
  }
  if (setCol >= 0) notes.add('Logisim resets the circuit between sets; here the rows run in one sequence');
  const header = [...notes].map((n) => `# ${n}`);
  return { src: [...header, ...out].join('\n') + '\n' };
}

function vectorValue(t0: string, w: number): { v: string; partial?: boolean } | { error: string } {
  const t = t0.replace(/_/g, '');
  const u = t.toUpperCase();
  if (u === '<DC>') return { v: 'X' };
  if (u === '<FLOAT>') return { v: 'Z' };
  const radix = /^0x/i.test(t) ? 16 : /^0o/i.test(t) ? 8 : /^0b/i.test(t) ? 2 : t.length === w ? 2 : 10;
  const digits = radix !== 10 && /^0[xob]/i.test(t) ? t.slice(2) : t;
  if (!digits) return { error: `expected digits in "${t0}"` };
  if (radix !== 10 && /x/i.test(digits)) {
    if (/^x+$/i.test(digits)) return { v: 'X' };
    return { v: 'X', partial: true };
  }
  const neg = radix === 10 && digits.startsWith('-');
  const body = neg ? digits.slice(1) : digits;
  const re = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : radix === 2 ? /^[01]+$/ : /^\d+$/;
  if (!re.test(body)) return { error: `"${t0}" is not a value` };
  let v = 0n;
  for (const ch of body.toLowerCase()) v = v * BigInt(radix) + BigInt(parseInt(ch, 16));
  if (neg) v = -v;
  v = BigInt.asUintN(w, v);
  if (w === 1) return { v: v.toString() };
  if (radix === 2) return { v: `0b${v.toString(2).padStart(w, '0')}` };
  if (radix === 16) return { v: `0x${v.toString(16)}` };
  return { v: v.toString() };
}
