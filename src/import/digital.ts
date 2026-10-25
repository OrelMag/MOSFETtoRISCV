// Digital (hneemann/Digital) .dig files → sandbox chips. One chip per circuit file, drawn where Digital drew it:
// every element at its position (Digital's 20 px grid step = 2 of our units), every wire as drawn, tunnels as
// pointers, text as comments, test cases as the chip's test tables. Elements become library parts where one
// behaves the same (gates, flip-flops, adders, multiplexers, ROM, RAM); where none does, a small chip of library
// parts is generated once per shape (a 3-input 4-bit NAND, a counter with clear, a subtractor) and placed.
//
// Connectivity follows Digital's rules (draw/elements/WireConsistencyChecker, model/NetList): collinear wires that
// touch merge, a wire is split where another wire's end lies on it, and a net joins the wires that share an end
// point, the pins at those points (a pin on a wire's middle is not connected) and pins that overlap. Our parts are
// not Digital's shapes, so a wire that ended on a Digital pin ends on our part's port with the Digital point kept
// as a corner: the drawing moves a little, the nets never do.
//
// DOM-free: tests/import-digital.test.ts compiles and simulates what this makes.

import { type ChipDoc, type CommentDoc, type EndRef, type ExitDir, isIdent, type LabelDoc, type PartDoc, type PartRef, type PinDoc,
  slug, uniqueName, type Vec, type WireDoc } from '../editor/model';
import { compileChip } from '../editor/compile';
import { isError, partDef } from '../editor/parts';
import { instPort, symbolGeom } from '../sim/geometry';
import type { ComponentDef } from '../sim/types';
import { type ImportFailure, type ImportOptions, type ImportResult, MappingTally, type SourceFile } from './report';
import { child, childrenNamed, deref, parseXml, type XNode } from './xml';

const SIZE = 20;
/** Digital px → our grid units. */
const S = (p: DPt): Vec => [p[0] / 10, p[1] / 10];
type DPt = [number, number];
const key = (p: DPt) => `${p[0]},${p[1]}`;

export function isDigitalFile(name: string, text: string): boolean {
  if (/\.dig$/i.test(name)) return true;
  const head = text.slice(0, 4000);
  return /<circuit>/.test(head) && /<visualElements/.test(head);
}

// ---- reading the file -------------------------------------------------------------------------

interface DElem {
  name: string;
  attrs: Map<string, XNode>;
  pos: DPt;
  rot: number;
  mirror: boolean;
}

interface DCircuit {
  file: string;
  /** Lowercase base name with .dig: how other circuits place it. */
  base: string;
  name: string;
  elems: DElem[];
  wires: [DPt, DPt][];
  /** Box width of its default shape when placed (attribute Width, grid steps). */
  width: number;
  /** In / Clock labels, then Out labels, in file order: the placed box's pins. */
  ins: string[];
  outs: string[];
  description?: string;
}

const baseOf = (path: string) => path.replace(/\\/g, '/').split('/').pop()!.toLowerCase();

function readAttrs(n: XNode | undefined): Map<string, XNode> {
  const m = new Map<string, XNode>();
  for (const e of childrenNamed(n, 'entry')) {
    const [k, v] = e.children;
    const kk = k && deref(k);
    const vv = v && deref(v);
    if (kk && vv) m.set(kk.text, vv);
  }
  return m;
}

function aNum(a: Map<string, XNode>, k: string, def: number): number {
  const v = a.get(k);
  if (!v) return def;
  if (v.name === 'rotation') return +(v.attrs.rotation ?? 0) || 0;
  const t = v.text.trim();
  const n = /^-?0x[0-9a-f]+$/i.test(t) ? (t[0] === '-' ? -parseInt(t.slice(3), 16) : parseInt(t, 16)) : Number(t);
  return Number.isFinite(n) ? n : def;
}
const aBig = (a: Map<string, XNode>, k: string): bigint | null => {
  const t = a.get(k)?.text.trim();
  if (!t) return null;
  try { return BigInt(t); } catch { return null; }
};
const aStr = (a: Map<string, XNode>, k: string, def = ''): string => a.get(k)?.text ?? def;
const aBool = (a: Map<string, XNode>, k: string, def: boolean): boolean => {
  const v = a.get(k);
  return v ? v.text.trim() === 'true' : def;
};

function readCircuit(f: SourceFile): DCircuit | string {
  let root: XNode;
  try {
    root = parseXml(f.text);
  } catch (e) {
    return `${f.name}: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (root.name !== 'circuit') return `${f.name}: not a Digital circuit (root <${root.name}>)`;
  const version = +(child(root, 'version')?.text.trim() ?? '0') || 0;
  const k = version < 1 ? 2 : 1; // version 0 files are on a 10 px grid
  const pt = (n: XNode | undefined): DPt | null => {
    const d = n && deref(n);
    if (!d || d.attrs.x === undefined || d.attrs.y === undefined) return null;
    const x = Math.round(+d.attrs.x * k), y = Math.round(+d.attrs.y * k);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  };
  const elems: DElem[] = [];
  for (const ve of childrenNamed(child(root, 'visualElements'), 'visualElement')) {
    const v = deref(ve);
    const name = v && child(v, 'elementName')?.text.trim();
    const pos = v && pt(child(v, 'pos'));
    if (!v || !name || !pos) continue;
    const attrs = readAttrs(child(v, 'elementAttributes'));
    elems.push({ name, attrs, pos, rot: ((aNum(attrs, 'rotation', 0) % 4) + 4) % 4, mirror: aBool(attrs, 'mirror', false) });
  }
  const wires: [DPt, DPt][] = [];
  for (const w of childrenNamed(child(root, 'wires'), 'wire')) {
    const d = deref(w);
    const a = d && pt(child(d, 'p1')), b = d && pt(child(d, 'p2'));
    if (a && b) wires.push([a, b]);
  }
  const attrs = readAttrs(child(root, 'attributes'));
  const label = (e: DElem) => aStr(e.attrs, 'Label').trim();
  const name = f.name.replace(/\\/g, '/').split('/').pop()!.replace(/\.dig$/i, '');
  return {
    file: f.name, base: baseOf(f.name), name, elems, wires,
    width: aNum(attrs, 'Width', 3),
    ins: elems.filter((e) => e.name === 'In' || e.name === 'Clock').map(label),
    outs: elems.filter((e) => e.name === 'Out').map(label),
    description: aStr(attrs, 'Description').trim() || undefined,
  };
}

// ---- Digital's shapes: where each element's pins are ------------------------------------------

interface DPin { name: string; dir: 'in' | 'out'; at: DPt }

/** Local pin position → absolute (Digital: mirror in y, then rotate `rot` quarter turns counter-clockwise, then move). */
function place(e: DElem, l: DPt): DPt {
  const x = l[0], y = e.mirror ? -l[1] : l[1];
  const [c, s] = [[1, 0], [0, 1], [-1, 0], [0, -1]][e.rot];
  return [x * c + y * s + e.pos[0], -x * s + y * c + e.pos[1]];
}
/** The inverse of place (for inferring a stub's pins from the wires around it). */
function local(e: DElem, p: DPt): DPt {
  const dx = p[0] - e.pos[0], dy = p[1] - e.pos[1];
  const [c, s] = [[1, 0], [0, 1], [-1, 0], [0, -1]][e.rot];
  const x = dx * c - dy * s, y = dx * s + dy * c;
  return [x, e.mirror ? -y : y];
}
const DIRS: ExitDir[] = ['right', 'up', 'left', 'down'];
/** A direction drawn in the element's own frame (right = +x), as it shows on the sheet. */
function dirOf(e: DElem, d: ExitDir): ExitDir {
  const v = e.mirror && (d === 'up' || d === 'down') ? (d === 'up' ? 'down' : 'up') : d;
  return DIRS[(DIRS.indexOf(v) + e.rot) % 4];
}

/** Digital's GenericShape: inputs down the left (a gap in the middle of an even count when symmetric), outputs at x = width. */
function genericPins(ins: string[], outs: string[], width: number, invert: boolean, negated: Set<string>): { name: string; dir: 'in' | 'out'; l: DPt }[] {
  const sym = outs.length === 1;
  const offs = sym ? Math.floor(ins.length / 2) * SIZE : 0;
  const r: { name: string; dir: 'in' | 'out'; l: DPt }[] = ins.map((name, i) => ({
    name, dir: 'in', l: [negated.has(name) ? -SIZE : 0, i * SIZE + (sym && ins.length % 2 === 0 && i >= ins.length / 2 ? SIZE : 0)],
  }));
  outs.forEach((name, i) => r.push({ name, dir: 'out', l: [SIZE * (invert ? width + 1 : width), i * SIZE + offs] }));
  return r;
}

const GATES: Record<string, { op: 'and' | 'or' | 'xor'; inv: boolean }> = {
  And: { op: 'and', inv: false }, NAnd: { op: 'and', inv: true }, Or: { op: 'or', inv: false }, NOr: { op: 'or', inv: true },
  XOr: { op: 'xor', inv: false }, XNOr: { op: 'xor', inv: true },
};

/** Splitter definition ("4,4", "8", "4*2", "0-3,4-7") → ports as (first bit, width). */
function splitPorts(def: string): { pos: number; bits: number }[] | null {
  const out: { pos: number; bits: number }[] = [];
  let bits = 0;
  for (const raw of def.split(',')) {
    const t = raw.trim();
    if (!t) continue;
    let m: RegExpExecArray | null;
    if ((m = /^(\d+)\s*\*\s*(\d+)$/.exec(t))) {
      for (let i = 0; i < +m[2]; i++) { out.push({ pos: bits, bits: +m[1] }); bits += +m[1]; }
    } else if ((m = /^(\d+)\s*-\s*(\d+)$/.exec(t))) {
      const [a, b] = [Math.min(+m[1], +m[2]), Math.max(+m[1], +m[2])];
      out.push({ pos: a, bits: b - a + 1 });
      bits = Math.max(bits, b + 1);
    } else if (/^\d+$/.test(t)) {
      out.push({ pos: bits, bits: +t });
      bits += +t;
    } else return null;
  }
  if (!out.length) out.push({ pos: 0, bits: 1 });
  return out.some((p) => p.bits < 1) ? null : out;
}

/** The pins of an element Digital draws, or null for one this importer does not know the shape of. */
function shapeOf(e: DElem, sub: (base: string) => DCircuit | undefined): DPin[] | null {
  const a = e.attrs;
  const negated = new Set(childrenNamed(a.get('inverterConfig'), 'string').map((s) => s.text.trim()));
  const width = aNum(a, 'Width', 3);
  const gen = (ins: string[], outs: string[], w = width, inv = false) => genericPins(ins, outs, w, inv, negated);
  let l: { name: string; dir: 'in' | 'out'; l: DPt }[];
  const g = GATES[e.name];
  if (g) {
    const n = Math.max(1, aNum(a, 'Inputs', 2));
    l = gen(Array.from({ length: n }, (_, i) => `In_${i + 1}`), ['out'], aBool(a, 'wideShape', false) ? 4 : 3, g.inv);
  } else if (e.name.toLowerCase().endsWith('.dig')) {
    const c = sub(baseOf(e.name));
    if (!c) return null;
    l = genericPins(c.ins, c.outs, c.width, false, new Set());
  } else {
    switch (e.name) {
      case 'Not': l = gen(['in'], ['out'], aBool(a, 'wideShape', false) ? 2 : 1, true); break;
      case 'In': case 'Clock': case 'Button': case 'Const': case 'Ground': case 'VDD': case 'DipSwitch':
        l = [{ name: 'out', dir: 'out', l: [0, 0] }]; break;
      case 'Out': case 'LED': case 'Probe': case 'Tunnel': l = [{ name: 'in', dir: 'in', l: [0, 0] }]; break;
      case 'D_FF': l = gen(['D', 'C'], ['Q', '~Q']); break;
      case 'JK_FF': l = gen(['J', 'C', 'K'], ['Q', '~Q']); break;
      case 'RS_FF': l = gen(['S', 'C', 'R'], ['Q', '~Q']); break;
      case 'T_FF': l = gen(aBool(a, 'withEnable', true) ? ['T', 'C'] : ['C'], ['Q', '~Q']); break;
      case 'Register': l = gen(['D', 'C', 'en'], ['Q']); break;
      case 'Counter': l = gen(['en', 'C', 'clr'], ['out', 'ovf']); break;
      case 'Add': case 'Sub': l = gen(['a', 'b', 'c_i'], ['s', 'c_o']); break;
      case 'Comparator': l = gen(['a', 'b'], ['>', '=', '<']); break;
      case 'Neg': case 'BitExtender': l = gen(['in'], ['out']); break;
      case 'ROM': l = gen(['A', 'sel'], ['D']); break;
      case 'RAMDualPort': l = gen(['A', 'Din', 'str', 'C', 'ld'], ['D'], 3); break;
      case 'Multiplexer': {
        const n = 1 << aNum(a, 'Selector Bits', 1), flip = aBool(a, 'flipSelPos', false);
        l = [{ name: 'sel', dir: 'in', l: [SIZE, flip ? 0 : n * SIZE] }];
        for (let i = 0; i < n; i++) l.push({ name: `in_${i}`, dir: 'in', l: [0, n === 2 ? i * 2 * SIZE : i * SIZE] });
        l.push({ name: 'out', dir: 'out', l: [SIZE * 2, Math.floor(n / 2) * SIZE] });
        break;
      }
      case 'Demultiplexer': case 'Decoder': {
        const n = 1 << aNum(a, 'Selector Bits', 1), flip = aBool(a, 'flipSelPos', false), hasIn = e.name === 'Demultiplexer';
        const h = hasIn || n <= 2 ? n * SIZE : (n - 1) * SIZE;
        l = [{ name: 'sel', dir: 'in', l: [SIZE, flip ? 0 : h] }];
        for (let i = 0; i < n; i++) l.push({ name: `out_${i}`, dir: 'out', l: [SIZE * 2, n === 2 ? i * 2 * SIZE : i * SIZE] });
        if (hasIn) l.push({ name: 'in', dir: 'in', l: [0, Math.floor(n / 2) * SIZE] });
        break;
      }
      case 'Splitter': {
        const sp = Math.max(1, aNum(a, 'splitterSpreading', 1));
        const ins = splitPorts(aStr(a, 'Input Splitting', '4,4')), outs = splitPorts(aStr(a, 'Output Splitting', '8'));
        if (!ins || !outs) return null;
        l = [...ins.map((_, i) => ({ name: `in${i}`, dir: 'in' as const, l: [0, i * sp * SIZE] as DPt })),
          ...outs.map((_, i) => ({ name: `out${i}`, dir: 'out' as const, l: [SIZE, i * sp * SIZE] as DPt }))];
        break;
      }
      case 'Seven-Seg': {
        const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'];
        l = names.map((name, i) => ({ name, dir: 'in' as const, l: [SIZE * (i % 4), i < 4 ? 0 : SIZE * 7] as DPt }));
        if (aBool(a, 'commonConnection', false)) l.push({ name: 'common', dir: 'in', l: [SIZE * 4, SIZE * 7] });
        break;
      }
      case 'Seven-Seg-Hex': l = [{ name: 'd', dir: 'in', l: [SIZE * 2, SIZE * 7] }, { name: 'dp', dir: 'in', l: [SIZE * 3, SIZE * 7] }]; break;
      default: return null;
    }
  }
  return l.map((p) => ({ name: p.name, dir: p.dir, at: place(e, p.l) }));
}

// ---- the importer -----------------------------------------------------------------------------

/** Pin names Digital allows ("~Q", "C out") → identifiers, unique in their chip. */
function identOf(name: string, taken: Set<string>, fallback: string): string {
  let s = name.trim().replace(/~/g, 'n').replace(/[^A-Za-z0-9_]+/g, '_');
  if (!/[A-Za-z0-9]/.test(s)) s = fallback;
  if (/^\d/.test(s)) s = `_${s}`;
  const u = uniqueName(s, taken);
  taken.add(u);
  return u;
}

type GateOp = 'and' | 'or' | 'xor';

class Importer {
  readonly tally = new MappingTally();
  readonly problems: string[] = [];
  readonly chips: ChipDoc[] = [];
  private readonly ids: Set<string>;
  private readonly defs = new Map<string, ComponentDef>();
  private readonly helpers = new Map<string, string>();
  /** Per imported circuit: its chip id and Digital pin name → our pin name. */
  readonly made = new Map<string, { id: string; pins: Map<string, string> }>();
  private readonly stubs = new Map<string, string>();

  constructor(taken: ReadonlySet<string>) {
    this.ids = new Set(taken);
  }

  chipId(name: string, prefix = 'u_'): string {
    const id = uniqueName(`${prefix}${slug(name)}`, this.ids);
    this.ids.add(id);
    return id;
  }

  defOf(ref: PartRef): ComponentDef | null {
    const r = partDef(ref, (id) => this.defs.get(id));
    return isError(r) ? null : r;
  }

  /** Adds a finished chip (after the chips it places) and compiles it so its parents can place it. */
  add(doc: ChipDoc): void {
    this.chips.push(doc);
    const c = compileChip(doc, (ref) => partDef(ref, (id) => this.defs.get(id)));
    this.defs.set(doc.id, c.def);
  }

  // ---- generated chips: one per shape, shared by every place that needs it ----

  private helper(k: string, name: string, build: (m: Mini) => void): string {
    const hit = this.helpers.get(k);
    if (hit) return hit;
    const m = new Mini(this, this.chipId(k, 'u_dig_'), name);
    build(m);
    const id = m.done();
    this.helpers.set(k, id);
    return id;
  }

  /** NOT of a w-bit bus: a library inverter for one bit, else a chip (in → out). */
  notRef(w: number): { ref: PartRef; a: string; y: string } {
    if (w === 1) return { ref: { lib: 'not' }, a: 'a', y: 'y' };
    const id = this.helper(`not${w}`, `NOT ×${w}`, (m) => {
      const i = m.pin('in', 'in', w), o = m.pin('out', 'out', w);
      const sp = m.part({ split: Array(w).fill(1) }), mg = m.part({ merge: Array(w).fill(1) });
      m.net([i, { part: sp, port: 'in' }]);
      for (let b = 0; b < w; b++) {
        const n = m.part({ lib: 'not' });
        m.net([{ part: sp, port: `o${b}` }, { part: n, port: 'a' }]);
        m.net([{ part: n, port: 'y' }, { part: mg, port: `i${b}` }]);
      }
      m.net([{ part: mg, port: 'out' }, o]);
    });
    return { ref: { chip: id }, a: 'in', y: 'out' };
  }

  /** A gate of n inputs on w-bit buses: a library part where one exists, else a chip of 2-input gates (In_1… → out). */
  gateRef(op: GateOp, inv: boolean, n: number, w: number): { ref: PartRef; ins: string[]; y: string; how: string } {
    const libName = inv ? { and: 'nand', or: 'nor', xor: 'xnor' }[op] : op;
    if (w === 1 && n === 2) return { ref: { lib: libName }, ins: ['a', 'b'], y: 'y', how: `${libName.toUpperCase()} gate` };
    if (!inv && w === 1 && (op === 'and' || (op === 'or' && [3, 4, 8, 16, 32].includes(n)))) {
      return { ref: { lib: `${op}${n}` }, ins: Array.from({ length: n }, (_, i) => `i${i}`), y: 'y', how: `${n}-input ${op.toUpperCase()}` };
    }
    if (!inv && n === 2) return { ref: { lib: `${op}x${w}` }, ins: ['a', 'b'], y: 'y', how: `bitwise ${op.toUpperCase()}` };
    const id = this.helper(`${libName}${n}x${w}`, `${libName.toUpperCase()} ${n}×${w}`, (m) => {
      let srcs: EndRef[] = Array.from({ length: n }, (_, i) => m.pin(`In_${i + 1}`, 'in', w));
      const out = m.pin('out', 'out', w);
      const two: PartRef = w === 1 ? { lib: op } : { lib: `${op}x${w}` };
      while (srcs.length > 1) {
        const next: EndRef[] = [];
        for (let i = 0; i + 1 < srcs.length; i += 2) {
          const g = m.part(two);
          m.net([srcs[i], { part: g, port: 'a' }]);
          m.net([srcs[i + 1], { part: g, port: 'b' }]);
          next.push({ part: g, port: 'y' });
        }
        if (srcs.length % 2) next.push(srcs[srcs.length - 1]);
        srcs = next;
      }
      if (inv) {
        const nr = this.notRef(w), g = m.part(nr.ref);
        m.net([srcs[0], { part: g, port: nr.a }]);
        srcs = [{ part: g, port: nr.y }];
      }
      m.net([srcs[0], out]);
    });
    return { ref: { chip: id }, ins: Array.from({ length: n }, (_, i) => `In_${i + 1}`), y: 'out', how: 'chip of 2-input gates' };
  }

  counterRef(n: number): string {
    return this.helper(`counter${n}`, `Counter ${n} (Digital)`, (m) => {
      const en = m.pin('en', 'in', 1), c = m.pin('C', 'in', 1), clr = m.pin('clr', 'in', 1);
      const out = m.pin('out', 'out', n), ovf = m.pin('ovf', 'out', 1);
      const reg = m.part({ lib: `reg${n}` }), inc = m.part({ lib: `inc${n}` }), mux = m.part({ lib: `mux2x${n}` });
      const zero = m.part({ const: { width: n, value: 0 } }), or = m.part({ lib: 'or' }), and = m.part({ lib: 'and' });
      m.net([c, { part: reg, port: 'clk' }]);
      m.net([{ part: reg, port: 'q' }, { part: inc, port: 'a' }, out]);
      m.net([{ part: inc, port: 'y' }, { part: mux, port: 'a' }]);
      m.net([{ part: zero, port: 'y' }, { part: mux, port: 'b' }]);
      m.net([clr, { part: mux, port: 's' }, { part: or, port: 'b' }]);
      m.net([en, { part: or, port: 'a' }, { part: and, port: 'a' }]);
      m.net([{ part: or, port: 'y' }, { part: reg, port: 'en' }]);
      m.net([{ part: mux, port: 'y' }, { part: reg, port: 'd' }]);
      m.net([{ part: inc, port: 'cout' }, { part: and, port: 'b' }]);
      m.net([{ part: and, port: 'y' }, ovf]);
    });
  }

  subRef(n: number): string {
    return this.helper(`sub${n}`, `Subtract ${n} (Digital)`, (m) => {
      const a = m.pin('a', 'in', n), b = m.pin('b', 'in', n), ci = m.pin('c_i', 'in', 1);
      const s = m.pin('s', 'out', n), co = m.pin('c_o', 'out', 1);
      const nb = this.notRef(n), add = m.part({ lib: `rca${n}` }), ib = m.part(nb.ref), ic = m.part({ lib: 'not' }), oc = m.part({ lib: 'not' });
      m.net([a, { part: add, port: 'a' }]);
      m.net([b, { part: ib, port: nb.a }]);
      m.net([{ part: ib, port: nb.y }, { part: add, port: 'b' }]);
      m.net([ci, { part: ic, port: 'a' }]);
      m.net([{ part: ic, port: 'y' }, { part: add, port: 'cin' }]);
      m.net([{ part: add, port: 's' }, s]);
      m.net([{ part: add, port: 'cout' }, { part: oc, port: 'a' }]);
      m.net([{ part: oc, port: 'y' }, co]);
    });
  }

  negRef(n: number): string {
    return this.helper(`neg${n}`, `Negate ${n} (Digital)`, (m) => {
      const i = m.pin('in', 'in', n), o = m.pin('out', 'out', n);
      const nr = this.notRef(n), inv = m.part(nr.ref), add = m.part({ lib: `rca${n}` });
      const zero = m.part({ const: { width: n, value: 0 } }), one = m.part({ const: { width: 1, value: 1 } });
      m.net([i, { part: inv, port: nr.a }]);
      m.net([{ part: inv, port: nr.y }, { part: add, port: 'a' }]);
      m.net([{ part: zero, port: 'y' }, { part: add, port: 'b' }]);
      m.net([{ part: one, port: 'y' }, { part: add, port: 'cin' }]);
      m.net([{ part: add, port: 's' }, o]);
    });
  }

  /** a, b → gt, eq, lt: the library comparator of the next width up, inputs zero- or sign-extended. Null past 32 bits. */
  cmpRef(n: number, signed: boolean): string | null {
    const W = [2, 4, 8, 16, 32].find((x) => x >= n);
    if (!W) return null;
    return this.helper(`cmp${n}${signed ? 's' : ''}`, `Compare ${n}${signed ? ' signed' : ''} (Digital)`, (m) => {
      const a = m.pin('a', 'in', n), b = m.pin('b', 'in', n);
      const gt = m.pin('gt', 'out', 1), eq = m.pin('eq', 'out', 1), lt = m.pin('lt', 'out', 1);
      const cmp = m.part({ lib: `cmp${W}${signed ? 's' : ''}` });
      const zero = W > n && !signed ? m.part({ const: { width: 1, value: 0 } }) : null;
      for (const [pin, port] of [[a, 'a'], [b, 'b']] as const) {
        if (W === n) { m.net([pin, { part: cmp, port }]); continue; }
        const mg = m.part({ merge: [n, ...Array(W - n).fill(1)] });
        const fill: EndRef[] = Array.from({ length: W - n }, (_, i) => ({ part: mg, port: `i${i + 1}` }));
        if (signed && n > 1) {
          const sp = m.part({ split: [n - 1, 1] });
          m.net([pin, { part: sp, port: 'in' }, { part: mg, port: 'i0' }]);
          m.net([{ part: sp, port: 'o1' }, ...fill]);
        } else if (signed) {
          m.net([pin, { part: mg, port: 'i0' }, ...fill]);
        } else {
          m.net([pin, { part: mg, port: 'i0' }]);
          m.net([{ part: zero!, port: 'y' }, ...fill]);
        }
        m.net([{ part: mg, port: 'out' }, { part: cmp, port }]);
      }
      m.net([{ part: cmp, port: 'gt' }, gt]);
      m.net([{ part: cmp, port: 'eq' }, eq]);
      m.net([{ part: cmp, port: 'lt' }, lt]);
    });
  }

  extRef(inB: number, outB: number): string {
    return this.helper(`sext${inB}_${outB}`, `Sign-extend ${inB}→${outB}`, (m) => {
      const i = m.pin('in', 'in', inB), o = m.pin('out', 'out', outB);
      if (outB === inB) { m.net([i, o]); return; }
      if (outB < inB) {
        const sp = m.part({ split: [outB, inB - outB] });
        m.net([i, { part: sp, port: 'in' }]);
        m.net([{ part: sp, port: 'o0' }, o]);
        return;
      }
      const mg = m.part({ merge: [inB, ...Array(outB - inB).fill(1)] });
      const fill: EndRef[] = Array.from({ length: outB - inB }, (_, k) => ({ part: mg, port: `i${k + 1}` }));
      if (inB > 1) {
        const sp = m.part({ split: [inB - 1, 1] });
        m.net([i, { part: sp, port: 'in' }, { part: mg, port: 'i0' }]);
        m.net([{ part: sp, port: 'o1' }, ...fill]);
      } else m.net([i, { part: mg, port: 'i0' }, ...fill]);
      m.net([{ part: mg, port: 'out' }, o]);
    });
  }

  demuxRef(k: number, w: number): string {
    return this.helper(`demux${k}x${w}`, `Demultiplexer ${1 << k}×${w} (Digital)`, (m) => {
      const sel = m.pin('sel', 'in', k), x = m.pin('in', 'in', w);
      const dec = m.part({ lib: `dec${k}` }), zero = m.part({ const: { width: w, value: 0 } });
      m.net([sel, { part: dec, port: 'a' }]);
      const bs: EndRef[] = [x], zs: EndRef[] = [{ part: zero, port: 'y' }];
      for (let i = 0; i < 1 << k; i++) {
        const o = m.pin(`out_${i}`, 'out', w), mx = m.part({ lib: `mux2x${w}` });
        zs.push({ part: mx, port: 'a' });
        bs.push({ part: mx, port: 'b' });
        m.net([{ part: dec, port: `y${i}` }, { part: mx, port: 's' }]);
        m.net([{ part: mx, port: 'y' }, o]);
      }
      m.net(bs);
      m.net(zs);
    });
  }

  rsRef(): string {
    return this.helper('rsff', 'RS flip-flop (Digital)', (m) => {
      const s = m.pin('S', 'in', 1), c = m.pin('C', 'in', 1), r = m.pin('R', 'in', 1);
      const q = m.pin('Q', 'out', 1), nq = m.pin('nQ', 'out', 1);
      const ff = m.part({ lib: 'dffe' }), or = m.part({ lib: 'or' }), n = m.part({ lib: 'not' });
      m.net([s, { part: ff, port: 'd' }, { part: or, port: 'a' }]);
      m.net([r, { part: or, port: 'b' }]);
      m.net([{ part: or, port: 'y' }, { part: ff, port: 'en' }]);
      m.net([c, { part: ff, port: 'clk' }]);
      m.net([{ part: ff, port: 'q' }, { part: n, port: 'a' }, q]);
      m.net([{ part: n, port: 'y' }, nq]);
    });
  }

  /** An empty chip with these pins (an element or a file this importer cannot draw): wires still connect. */
  stubChip(name: string, pins: { name: string; dir: 'in' | 'out'; width: number }[]): string {
    const k = `${name}|${pins.map((p) => `${p.dir}:${p.name}:${p.width}`).join(',')}`;
    const hit = this.stubs.get(k);
    if (hit) return hit;
    const doc: ChipDoc = { id: this.chipId(name), name, notes: 'Imported from Digital as an empty chip: its inside was not imported.', pins: [], parts: [], wires: [], labels: [] };
    let yi = 0, yo = 0;
    for (const p of pins) {
      const y = 2 + 2 * (p.dir === 'in' ? yi++ : yo++);
      doc.pins.push({ id: `pin${doc.pins.length + 1}`, name: p.name, dir: p.dir, width: p.width, at: [p.dir === 'in' ? 0 : 20, y] });
    }
    this.add(doc);
    this.stubs.set(k, doc.id);
    return doc.id;
  }
}

/** A generated chip drawn simply: parts in columns, every connection a pair of pointers named for its net. */
class Mini {
  private doc: ChipDoc;
  private ins = 0;
  private outs: PinDoc[] = [];
  private x = 8;
  private y = 0;
  private colW = 0;
  private maxX = 8;
  private nets = 0;

  constructor(private imp: Importer, id: string, name: string) {
    this.doc = { id, name, notes: 'Generated by the Digital import: what one Digital element does, from library parts.', pins: [], parts: [], wires: [], labels: [] };
  }

  pin(name: string, dir: 'in' | 'out', width: number): EndRef {
    const p: PinDoc = { id: `pin${this.doc.pins.length + 1}`, name, dir, width, at: dir === 'in' ? [0, 2 + 4 * this.ins++] : [0, 0] };
    this.doc.pins.push(p);
    if (dir === 'out') this.outs.push(p);
    return { pin: p.id };
  }

  part(ref: PartRef): string {
    const def = this.imp.defOf(ref);
    const g = def ? symbolGeom(def) : { w: 6, h: 4 };
    if (this.y > 0 && this.y + g.h > 48) { this.x += this.colW + 10; this.y = 0; this.colW = 0; }
    const id = `p${this.doc.parts.length + 1}`;
    this.doc.parts.push({ id, ref, at: [this.x, this.y + 2] });
    this.y += g.h + 6;
    this.colW = Math.max(this.colW, g.w);
    this.maxX = Math.max(this.maxX, this.x + g.w);
    return id;
  }

  /** Joins the ends: each gets a short wire to a pointer of the net's name. */
  net(ends: EndRef[]): void {
    const name = `n${++this.nets}`;
    for (const e of ends) {
      const id = `l${this.doc.labels.length + 1}`;
      this.doc.labels.push({ id, name, at: [0, 0] });
      this.doc.wires.push({ id: `w${this.doc.wires.length + 1}`, a: e, b: { label: id }, pts: [] });
    }
  }

  done(): string {
    this.outs.forEach((p, i) => (p.at = [this.maxX + 12, 2 + 4 * i]));
    // pointers beside what they label, flags pointing away
    for (const w of this.doc.wires) {
      const l = this.doc.labels.find((q) => 'label' in w.b && q.id === w.b.label)!;
      let pos: Vec = [0, 0], dir: ExitDir = 'right';
      if ('pin' in w.a) {
        const p = this.doc.pins.find((q) => 'pin' in w.a && q.id === w.a.pin)!;
        pos = p.at;
        dir = p.dir === 'in' ? 'right' : 'left';
      } else if ('part' in w.a) {
        const e = w.a;
        const p = this.doc.parts.find((q) => q.id === e.part)!;
        const def = this.imp.defOf(p.ref);
        if (def) ({ pos, exit: dir } = instPort(def, p.at, false, e.port));
      }
      const d = { right: [1, 0], left: [-1, 0], up: [0, -1], down: [0, 1] }[dir];
      l.at = [pos[0] + 2 * d[0], pos[1] + 2 * d[1]];
      l.face = dir;
    }
    this.imp.add(this.doc);
    return this.doc.id;
  }
}

// ---- one circuit → one chip -------------------------------------------------------------------

interface Item { end: EndRef; part: boolean }
interface Align { part: string; port: string; at?: Vec; rel?: { part: string; port: string; dx: number; dy: number } }

class Sheet {
  readonly doc: ChipDoc;
  private items = new Map<string, Item[]>();
  private pts = new Map<string, DPt>();
  private aligns: Align[] = [];
  private partIds = new Set<string>();
  private pinNames = new Set<string>();
  private tunnels: { name: string; at: DPt }[] = [];
  /** Pins whose width comes from the net (Digital's Out takes its input's width). */
  private widthFromNet: { pin: PinDoc; at: DPt }[] = [];
  private cur: DElem | null = null;
  /** Points a stub's guessed pins took (two stubs side by side do not share one). */
  private claimed = new Set<string>();
  /** Notes that matter only when Digital wired that pin (a ROM's sel, a RAM's ld). */
  private ifWired: { e: DElem; at: DPt; msg: string }[] = [];
  private pending: { e: DElem; pins: DPin[] | null; title: string; label: string }[] = [];
  readonly pinMap = new Map<string, string>();

  constructor(private imp: Importer, private c: DCircuit, id: string, private sub: (base: string) => DCircuit | undefined, private known: (base: string) => boolean) {
    this.doc = { id, name: c.name, pins: [], parts: [], wires: [], labels: [] };
    if (c.description) this.doc.notes = c.description;
    for (const [a, b] of normalizeWires(c.wires)) this.used.add(key(a)).add(key(b));
    const count = new Map<string, number>();
    for (const e of c.elems) for (const p of shapeOf(e, sub) ?? []) count.set(key(p.at), (count.get(key(p.at)) ?? 0) + 1);
    for (const [k, n] of count) if (n > 1) this.used.add(k);
  }

  /** Points where Digital connects something: wire ends and pins that overlap. */
  private used = new Set<string>();

  private problem(e: DElem, msg: string) {
    const l = aStr(e.attrs, 'Label').trim();
    this.imp.problems.push(`${this.c.name} ▸ ${e.name}${l ? ` ${l}` : ''}: ${msg}`);
  }

  private item(p: DPt, end: EndRef) {
    const k = key(p);
    this.pts.set(k, p);
    const l = this.items.get(k) ?? [];
    l.push({ end, part: 'part' in end });
    this.items.set(k, l);
  }

  private nextPartId(prefix: string): string {
    for (let i = 1; ; i++) if (!this.partIds.has(`${prefix}${i}`)) return `${prefix}${i}`;
  }

  /** Adds a part; its `port` will sit on the Digital point `at` (or `rel` to another part's port). */
  addPart(ref: PartRef, prefix: string, align: { port: string; at?: DPt; rel?: Align['rel'] }, label?: string): string {
    const id = label && isIdent(label) && !this.partIds.has(label) ? label : this.nextPartId(prefix);
    this.partIds.add(id);
    const p: PartDoc = { id, ref, at: [0, 0], ...(this.cur ? Sheet.orient(this.cur) : {}) };
    if (label && label !== id) p.label = label;
    this.doc.parts.push(p);
    this.aligns.push({ part: id, port: align.port, at: align.at ? S(align.at) : undefined, rel: align.rel });
    return id;
  }

  /** A wire between two of our parts that Digital did not draw (inside one element's mapping). */
  link(a: EndRef, b: EndRef) {
    this.doc.wires.push({ id: `w${this.doc.wires.length + 1}`, a, b, pts: [] });
  }

  private tie(target: { part: string; port: string }, value: 0 | 1, dy = 0) {
    const c = this.addPart({ const: { width: 1, value } }, 'k', { port: 'y', rel: { ...target, dx: -3, dy } });
    this.link({ part: c, port: 'y' }, target);
  }

  // ---- elements ----

  element(e: DElem): void {
    this.cur = e;
    const a = e.attrs;
    const label = aStr(a, 'Label').trim();
    const bits = Math.max(1, aNum(a, 'Bits', 1));
    const t = this.imp.tally;
    const pins = shapeOf(e, this.sub);
    const at = (name: string): DPt => pins!.find((p) => p.name === name)!.at;
    const negated = new Set(childrenNamed(a.get('inverterConfig'), 'string').map((s) => s.text.trim()));
    /** Digital pin → our port, through an inverter when Digital negates that input. */
    const input = (name: string, end: { part: string; port: string }, width: number) => {
      if (!negated.has(name)) { this.item(at(name), end); return; }
      const nr = this.imp.notRef(width);
      const n = this.addPart(nr.ref, 'inv', { port: nr.a, at: at(name) });
      this.item(at(name), { part: n, port: nr.a });
      this.link({ part: n, port: nr.y }, end);
    };
    const out = (name: string, end: EndRef) => this.item(at(name), end);
    const g = GATES[e.name];

    if (e.name === 'Text') {
      const text = aStr(a, 'Description').trim();
      if (text) (this.doc.comments ??= []).push({ id: `c${(this.doc.comments?.length ?? 0) + 1}`, at: S(e.pos), text: text.slice(0, 2000) } as CommentDoc);
      t.add('Text', 'comment');
      return;
    }
    if (e.name === 'Testcase') {
      const src = child(a.get('Testdata'), 'dataString')?.text ?? '';
      if (src.trim()) (this.doc.tests ??= []).push({ name: label || 'test', src });
      t.add('Testcase', 'test table');
      return;
    }
    if (e.name === 'Rectangle' || e.name === 'Probe' || e.name === 'Data' || e.name === 'NotConnected' || e.name === 'Break' || e.name === 'ScopeTrigger') {
      t.add(e.name, 'left out (a view or a note)', 'dropped');
      return;
    }
    if (!pins) {
      const isSub = e.name.toLowerCase().endsWith('.dig');
      this.pending.push({ e, pins: null, title: isSub ? e.name.replace(/\.dig$/i, '') : `${e.name} (stub)`, label });
      return;
    }

    if (g) {
      const n = Math.max(1, aNum(a, 'Inputs', 2));
      const gr = this.imp.gateRef(g.op, g.inv, n, bits);
      const id = this.addPart(gr.ref, 'g', { port: gr.ins[0], at: at('In_1') }, label || undefined);
      gr.ins.forEach((p, i) => input(`In_${i + 1}`, { part: id, port: p }, bits));
      out('out', { part: id, port: gr.y });
      t.add(e.name, gr.how);
      return;
    }
    switch (e.name) {
      case 'Not': {
        const nr = this.imp.notRef(bits);
        const id = this.addPart(nr.ref, 'g', { port: nr.a, at: at('in') }, label || undefined);
        this.item(at('in'), { part: id, port: nr.a });
        out('out', { part: id, port: nr.y });
        t.add('Not', bits === 1 ? 'NOT gate' : 'chip of NOT gates');
        return;
      }
      case 'In': case 'Clock': case 'Button': case 'DipSwitch': case 'Out': {
        const dir = e.name === 'Out' ? 'out' : 'in';
        const name = identOf(label, this.pinNames, dir === 'in' ? 'in' : 'out');
        if (label && name !== label) this.problem(e, `pin renamed '${name}' (not an identifier)`);
        if (label) this.pinMap.set(label, name);
        const p: PinDoc = {
          id: `pin${this.doc.pins.length + 1}`, name, dir, width: e.name === 'In' || e.name === 'Out' ? bits : 1, at: S(e.pos),
          face: dirOf(e, dir === 'in' ? 'right' : 'left'),
        };
        if (e.name === 'Clock') p.kind = 'clock';
        if (e.name === 'Button') p.kind = 'button';
        if (e.name === 'In') {
          const v = a.get('InDefault');
          const dv = v ? (v.attrs.z === 'true' ? 0 : +(v.attrs.v ?? 0)) : aNum(a, 'Default', 0);
          if (Number.isSafeInteger(dv) && dv > 0 && dv < 2 ** bits) p.value = dv;
        }
        if (e.name === 'Out' && !a.has('Bits')) this.widthFromNet.push({ pin: p, at: e.pos });
        this.doc.pins.push(p);
        this.item(e.pos, { pin: p.id });
        t.add(e.name, e.name === 'Clock' ? 'clock pin' : e.name === 'Button' ? 'button pin' : `${dir === 'in' ? 'input' : 'output'} pin`);
        return;
      }
      case 'Const': case 'Ground': case 'VDD': {
        if (bits > 53) break;
        const v = e.name === 'Ground' ? 0n : e.name === 'VDD' ? (1n << BigInt(bits)) - 1n : (aBig(a, 'Value') ?? 1n);
        const value = Number(((v % (1n << BigInt(bits))) + (1n << BigInt(bits))) % (1n << BigInt(bits)));
        const id = this.addPart({ const: { width: bits, value } }, 'k', { port: 'y', at: e.pos });
        out('out', { part: id, port: 'y' });
        t.add(e.name, 'constant');
        return;
      }
      case 'Tunnel': {
        const name = aStr(a, 'NetName').trim();
        if (!name) { t.add('Tunnel', 'left out (no net name)', 'dropped'); return; }
        const l: LabelDoc = { id: `l${this.doc.labels.length + 1}`, name, at: S(e.pos), face: dirOf(e, 'right') };
        this.doc.labels.push(l);
        this.tunnels.push({ name, at: e.pos });
        this.item(e.pos, { label: l.id });
        t.add('Tunnel', 'pointer');
        return;
      }
      case 'LED': {
        const id = this.addPart({ display: 'led' }, 'led', { port: 'a', at: e.pos }, label || undefined);
        this.item(e.pos, { part: id, port: 'a' });
        t.add('LED', 'LED');
        return;
      }
      case 'Seven-Seg': {
        const mg = this.addPart({ merge: Array(8).fill(1) }, 'm', { port: 'i0', at: at('a') });
        const d = this.addPart({ display: 'seg7', width: 8 }, 'seg', { port: 'a', rel: { part: mg, port: 'out', dx: 3, dy: 0 } }, label || undefined);
        ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'].forEach((s, i) => this.item(at(s), { part: mg, port: `i${i}` }));
        this.link({ part: mg, port: 'out' }, { part: d, port: 'a' });
        t.add('Seven-Seg', '7-segment display (segments merged into a bus)');
        return;
      }
      case 'Seven-Seg-Hex': {
        const id = this.addPart({ display: 'hex', width: 4 }, 'hex', { port: 'a', at: at('d') }, label || undefined);
        this.item(at('d'), { part: id, port: 'a' });
        t.add('Seven-Seg-Hex', 'hex digit (decimal point left out)');
        return;
      }
      case 'D_FF': {
        const ref: PartRef = bits === 1 ? { lib: 'dff' } : { lib: `reg${bits}` };
        const id = this.addPart(ref, 'ff', { port: 'd', at: at('D') }, label || undefined);
        input('D', { part: id, port: 'd' }, bits);
        input('C', { part: id, port: 'clk' }, 1);
        if (bits > 1) this.tie({ part: id, port: 'en' }, 1);
        out('Q', { part: id, port: 'q' });
        this.notQ(id, at('~Q'), bits);
        this.initial(e, bits);
        t.add('D_FF', bits === 1 ? 'D flip-flop' : 'register');
        return;
      }
      case 'JK_FF': case 'T_FF': {
        const jk = e.name === 'JK_FF';
        const withT = jk || aBool(a, 'withEnable', true);
        const id = this.addPart({ lib: jk ? 'jkff' : 'tff' }, 'ff', { port: 'clk', at: at('C') }, label || undefined);
        if (jk) { input('J', { part: id, port: 'j' }, 1); input('K', { part: id, port: 'k' }, 1); }
        else if (withT) input('T', { part: id, port: 't' }, 1);
        else this.tie({ part: id, port: 't' }, 1);
        input('C', { part: id, port: 'clk' }, 1);
        this.tie({ part: id, port: 'rst_n' }, 1, 2);
        out('Q', { part: id, port: 'q' });
        this.notQ(id, at('~Q'), 1);
        this.initial(e, 1);
        t.add(e.name, jk ? 'JK flip-flop' : 'T flip-flop');
        return;
      }
      case 'RS_FF': {
        const id = this.addPart({ chip: this.imp.rsRef() }, 'ff', { port: 'S', at: at('S') }, label || undefined);
        input('S', { part: id, port: 'S' }, 1);
        input('C', { part: id, port: 'C' }, 1);
        input('R', { part: id, port: 'R' }, 1);
        out('Q', { part: id, port: 'Q' });
        out('~Q', { part: id, port: 'nQ' });
        this.initial(e, 1);
        t.add('RS_FF', 'chip: D flip-flop with enable');
        return;
      }
      case 'Register': {
        const id = this.addPart({ lib: `reg${bits}` }, 'r', { port: 'd', at: at('D') }, label || undefined);
        input('D', { part: id, port: 'd' }, bits);
        input('C', { part: id, port: 'clk' }, 1);
        input('en', { part: id, port: 'en' }, 1);
        out('Q', { part: id, port: 'q' });
        t.add('Register', 'register');
        return;
      }
      case 'Counter': {
        const id = this.addPart({ chip: this.imp.counterRef(bits) }, 'cnt', { port: 'en', at: at('en') }, label || undefined);
        for (const p of ['en', 'C', 'clr']) input(p, { part: id, port: p }, 1);
        out('out', { part: id, port: 'out' });
        out('ovf', { part: id, port: 'ovf' });
        t.add('Counter', 'chip: register + incrementer');
        return;
      }
      case 'Add': {
        const id = this.addPart({ lib: `rca${bits}` }, 'add', { port: 'a', at: at('a') }, label || undefined);
        input('a', { part: id, port: 'a' }, bits);
        input('b', { part: id, port: 'b' }, bits);
        input('c_i', { part: id, port: 'cin' }, 1);
        out('s', { part: id, port: 's' });
        out('c_o', { part: id, port: 'cout' });
        t.add('Add', 'ripple-carry adder');
        return;
      }
      case 'Sub': {
        const id = this.addPart({ chip: this.imp.subRef(bits) }, 'sub', { port: 'a', at: at('a') }, label || undefined);
        for (const p of ['a', 'b']) input(p, { part: id, port: p }, bits);
        input('c_i', { part: id, port: 'c_i' }, 1);
        out('s', { part: id, port: 's' });
        out('c_o', { part: id, port: 'c_o' });
        t.add('Sub', 'chip: adder on the inverted operand');
        return;
      }
      case 'Comparator': {
        const ref = this.imp.cmpRef(bits, aBool(a, 'Signed', false));
        if (!ref) break;
        const id = this.addPart({ chip: ref }, 'cmp', { port: 'a', at: at('a') }, label || undefined);
        input('a', { part: id, port: 'a' }, bits);
        input('b', { part: id, port: 'b' }, bits);
        out('>', { part: id, port: 'gt' });
        out('=', { part: id, port: 'eq' });
        out('<', { part: id, port: 'lt' });
        t.add('Comparator', 'chip: magnitude comparator');
        return;
      }
      case 'Neg': {
        const id = this.addPart({ chip: this.imp.negRef(bits) }, 'neg', { port: 'in', at: at('in') }, label || undefined);
        input('in', { part: id, port: 'in' }, bits);
        out('out', { part: id, port: 'out' });
        t.add('Neg', 'chip: invert and add 1');
        return;
      }
      case 'BitExtender': {
        const inB = Math.max(1, aNum(a, 'inputBits', 8)), outB = Math.max(1, aNum(a, 'outputBits', 16));
        const id = this.addPart({ chip: this.imp.extRef(inB, outB) }, 'ext', { port: 'in', at: at('in') }, label || undefined);
        input('in', { part: id, port: 'in' }, inB);
        out('out', { part: id, port: 'out' });
        t.add('BitExtender', 'chip: sign extension (wiring)');
        return;
      }
      case 'Multiplexer': {
        const k = Math.max(1, aNum(a, 'Selector Bits', 1));
        if (k > 6) break;
        const ref: PartRef = k === 1 ? { lib: `mux2x${bits}` } : { lib: `mux${1 << k}x${bits}` };
        const ins = k === 1 ? ['a', 'b'] : Array.from({ length: 1 << k }, (_, i) => `d${i}`);
        const id = this.addPart(ref, 'mux', { port: ins[0], at: at('in_0') }, label || undefined);
        ins.forEach((p, i) => input(`in_${i}`, { part: id, port: p }, bits));
        input('sel', { part: id, port: 's' }, k);
        out('out', { part: id, port: 'y' });
        t.add('Multiplexer', 'multiplexer');
        return;
      }
      case 'Demultiplexer': {
        const k = Math.max(1, aNum(a, 'Selector Bits', 1));
        if (k > 5) break;
        const id = this.addPart({ chip: this.imp.demuxRef(k, bits) }, 'dmx', { port: 'sel', at: at('sel') }, label || undefined);
        input('sel', { part: id, port: 'sel' }, k);
        input('in', { part: id, port: 'in' }, bits);
        for (let i = 0; i < 1 << k; i++) out(`out_${i}`, { part: id, port: `out_${i}` });
        if (aNum(a, 'Default', 0)) this.problem(e, 'outputs not selected are 0 here (Default ignored)');
        t.add('Demultiplexer', 'chip: decoder + multiplexers');
        return;
      }
      case 'Decoder': {
        const k = Math.max(1, aNum(a, 'Selector Bits', 1));
        if (k > 9) break;
        const id = this.addPart({ lib: `dec${k}` }, 'dec', { port: 'a', at: at('sel') }, label || undefined);
        input('sel', { part: id, port: 'a' }, k);
        for (let i = 0; i < 1 << k; i++) out(`out_${i}`, { part: id, port: `y${i}` });
        t.add('Decoder', 'decoder');
        return;
      }
      case 'Splitter': {
        this.splitter(e, pins);
        t.add('Splitter', 'splitter / merger');
        return;
      }
      case 'ROM': {
        const k = aNum(a, 'AddrBits', 2);
        if (k < 1 || k > 16 || bits > 32) break;
        const w = bits <= 8 ? 8 : bits <= 16 ? 16 : 32;
        const words = readData(aStr(a, 'Data'), 1 << k).map((x) => Number(x & ((1n << BigInt(bits)) - 1n)));
        while (words.length && !words[words.length - 1]) words.pop();
        const src = words.length ? chunks(words.map((x) => x.toString(16)), 8).map((l) => l.join(' ')).join('\n') + '\n' : '';
        const id = this.addPart({ rom: { k, w, addr: 'word', lang: 'hex', src } }, 'rom', { port: 'addr', at: at('A') }, label || undefined);
        input('A', { part: id, port: 'addr' }, k);
        if (w === bits) out('D', { part: id, port: 'data' });
        else {
          const sp = this.addPart({ split: [bits, w - bits] }, 'sp', { port: 'in', at: at('D') });
          this.link({ part: id, port: 'data' }, { part: sp, port: 'in' });
          out('D', { part: sp, port: 'o0' });
        }
        this.ifWired.push({ e, at: at('sel'), msg: 'sel is ignored: the ROM always drives D' });
        t.add('ROM', 'ROM (hex contents)');
        return;
      }
      case 'RAMDualPort': {
        const k = aNum(a, 'AddrBits', 2);
        if (k < 1 || k > 16 || bits > 32) break;
        const id = this.addPart({ ram: { k, w: bits } }, 'ram', { port: 'addr', at: at('A') }, label || undefined);
        input('A', { part: id, port: 'addr' }, k);
        input('Din', { part: id, port: 'din' }, bits);
        input('str', { part: id, port: 'we' }, 1);
        input('C', { part: id, port: 'clk' }, 1);
        out('D', { part: id, port: 'dout' });
        this.ifWired.push({ e, at: at('ld'), msg: 'ld is ignored: the RAM always drives D' });
        t.add('RAMDualPort', 'RAM');
        return;
      }
      default: {
        if (e.name.toLowerCase().endsWith('.dig')) {
          const made = this.imp.made.get(baseOf(e.name));
          const sc = this.sub(baseOf(e.name))!;
          if (!made) break;
          const first = pins[0];
          const id = this.addPart({ chip: made.id }, 'u', { port: made.pins.get(first?.name ?? '') ?? '', at: first?.at ?? e.pos }, label || undefined);
          for (const p of pins) {
            const port = made.pins.get(p.name);
            if (port) this.item(p.at, { part: id, port });
          }
          t.add(e.name, `chip ${sc.name}`);
          return;
        }
      }
    }
    this.pending.push({ e, pins, title: `${e.name} (stub)`, label });
  }

  private notQ(ff: string, at: DPt, bits: number) {
    if (!this.used.has(key(at))) return; // ~Q unused: no inverter
    const nr = this.imp.notRef(bits);
    const n = this.addPart(nr.ref, 'inv', { port: nr.a, rel: { part: ff, port: 'q', dx: 2, dy: 3 } });
    this.link({ part: ff, port: 'q' }, { part: n, port: nr.a });
    this.item(at, { part: n, port: nr.y });
  }

  private initial(e: DElem, bits: number) {
    const d = aNum(e.attrs, 'Default', 0);
    if (d) this.problem(e, `starts at 0 here (Default ${d} ignored, ${bits} bit${bits > 1 ? 's' : ''})`);
  }

  private splitter(e: DElem, pins: DPin[]) {
    const ins = splitPorts(aStr(e.attrs, 'Input Splitting', '4,4'))!, outs = splitPorts(aStr(e.attrs, 'Output Splitting', '8'))!;
    const total = Math.max(...ins.map((p) => p.pos + p.bits), ...outs.map((p) => p.pos + p.bits));
    const at = (n: string) => pins.find((p) => p.name === n)!.at;
    const inOrder = (ps: { pos: number; bits: number }[]) => ps.every((p, i) => p.pos === (i ? ps[i - 1].pos + ps[i - 1].bits : 0)) && ps[ps.length - 1].pos + ps[ps.length - 1].bits === total;
    // the whole bus: one input as it is, or the inputs merged (sorted by bit position)
    let bus: EndRef;
    if (ins.length === 1 && ins[0].pos === 0 && ins[0].bits === total) {
      bus = { part: '', port: '' };
    } else {
      const order = ins.map((p, i) => ({ ...p, i })).sort((x, y) => x.pos - y.pos);
      const mg = this.addPart({ merge: order.map((p) => p.bits) }, 'm', { port: `i${order.findIndex((p) => p.i === 0)}`, at: at('in0') });
      order.forEach((p, j) => this.item(at(`in${p.i}`), { part: mg, port: `i${j}` }));
      bus = { part: mg, port: 'out' };
    }
    const direct = 'part' in bus && bus.part === '';
    const feed = (sink: { part: string; port: string }) => (direct ? this.item(at('in0'), sink) : this.link(bus, sink));
    if (outs.length === 1 && outs[0].pos === 0 && outs[0].bits === total) {
      if (direct) {
        // one bus in, the same bus out: a merge of one field joins them
        const mg = this.addPart({ merge: [total] }, 'm', { port: 'i0', at: at('in0') });
        this.item(at('in0'), { part: mg, port: 'i0' });
        this.item(at('out0'), { part: mg, port: 'out' });
      } else this.item(at('out0'), bus);
      return;
    }
    if (inOrder(outs)) {
      const sp = this.addPart({ split: outs.map((p) => p.bits) }, 'sp', { port: 'o0', at: at('out0') });
      feed({ part: sp, port: 'in' });
      outs.forEach((_, i) => this.item(at(`out${i}`), { part: sp, port: `o${i}` }));
      return;
    }
    // overlapping or reordered outputs: every bit apart, each output merged from its bits
    const sp = this.addPart({ split: Array(total).fill(1) }, 'sp', { port: 'in', at: at('in0') });
    feed({ part: sp, port: 'in' });
    outs.forEach((p, i) => {
      if (p.bits === 1) { this.item(at(`out${i}`), { part: sp, port: `o${p.pos}` }); return; }
      const mg = this.addPart({ merge: Array(p.bits).fill(1) }, 'm', { port: 'out', at: at(`out${i}`) });
      for (let b = 0; b < p.bits; b++) this.link({ part: sp, port: `o${p.pos + b}` }, { part: mg, port: `i${b}` });
      this.item(at(`out${i}`), { part: mg, port: 'out' });
    });
  }

  // ---- after every element: nets, stubs, wires, placement ----

  finish(): ChipDoc {
    const wires = normalizeWires(this.c.wires);
    const uf = new UF();
    for (const [a, b] of wires) { uf.union(key(a), key(b)); this.pts.set(key(a), a); this.pts.set(key(b), b); }
    const byName = new Map<string, string>();
    for (const t of this.tunnels) {
      const f = byName.get(t.name);
      if (f) uf.union(f, key(t.at));
      else byName.set(t.name, key(t.at));
    }
    const ends = new Set(wires.flatMap(([a, b]) => [key(a), key(b)]));
    const live = (k: string) => ends.has(k) || (this.items.get(k)?.length ?? 0) > 1;

    // widths known on each net (from our parts' ports)
    const netWidth = new Map<string, number>();
    const fromNet = new Set(this.widthFromNet.map((w) => w.pin.id));
    const widthOf = (it: Item): number | undefined => {
      if ('pin' in it.end) {
        const id = it.end.pin;
        return fromNet.has(id) ? undefined : this.doc.pins.find((p) => p.id === id)?.width;
      }
      if (!('part' in it.end)) return undefined;
      const e = it.end;
      const p = this.doc.parts.find((q) => q.id === e.part);
      const d = p && this.imp.defOf(p.ref);
      return d?.ports.find((q) => q.name === e.port)?.width;
    };
    for (const [k, its] of this.items) {
      if (!live(k)) continue;
      for (const it of its) {
        const w = widthOf(it);
        if (w !== undefined && !netWidth.has(uf.find(k))) netWidth.set(uf.find(k), w);
      }
    }
    for (const { pin, at } of this.widthFromNet) {
      const w = live(key(at)) ? netWidth.get(uf.find(key(at))) : undefined;
      if (w) pin.width = w;
    }

    for (const n of this.ifWired) if (live(key(n.at))) this.problem(n.e, n.msg);
    // stubs: pins as Digital draws them, or inferred from the wire ends around the element
    for (const s of this.pending) {
      this.cur = s.e;
      this.stub(s, (k) => netWidth.get(uf.find(k)));
    }

    this.emitWires(wires, live);
    this.placeParts();
    return this.doc;
  }

  private stub(s: Sheet['pending'][number], width: (k: string) => number | undefined) {
    const { e } = s;
    let pins = s.pins;
    const inferred = !pins;
    if (!pins) {
      pins = [];
      // Digital's default box: inputs at x = 0 from the top, outputs at x = 3 steps, rows at most two steps apart
      const cand = [...this.pts.entries()].filter(([k]) => !this.claimed.has(k)).map(([, p]) => ({ p, l: local(e, p) }));
      const column = (x: number, firstMax: number, last: number) => {
        const cs = cand.filter((c) => c.l[0] === x && c.l[1] >= 0 && c.l[1] % SIZE === 0).sort((p, q) => p.l[1] - q.l[1]);
        const out: typeof cs = [];
        for (const c of cs) {
          const prev = out[out.length - 1];
          if (prev ? c.l[1] - prev.l[1] > 2 * SIZE : c.l[1] > firstMax) break;
          if (c.l[1] > last) break;
          out.push(c);
        }
        return out;
      };
      const ins = column(0, SIZE, 32 * SIZE);
      const outs = column(3 * SIZE, Math.max(SIZE, ...ins.map((c) => c.l[1])), Math.max(SIZE, ...ins.map((c) => c.l[1])) + 2 * SIZE);
      for (const c of [...ins, ...outs]) this.claimed.add(key(c.p));
      ins.forEach((c, i) => pins!.push({ name: `in${i}`, dir: 'in', at: c.p }));
      outs.forEach((c, i) => pins!.push({ name: `out${i}`, dir: 'out', at: c.p }));
    }
    const taken = new Set<string>();
    const ours = pins.map((p) => ({ ...p, port: identOf(p.name, taken, p.dir), width: width(key(p.at)) ?? 1 }));
    const id = this.imp.stubChip(s.title.replace(/[^\w .()-]+/g, '_'), ours.map((p) => ({ name: p.port, dir: p.dir, width: p.width })));
    const part = this.addPart({ chip: id }, 'x', { port: ours[0]?.port ?? '', at: ours[0]?.at ?? e.pos }, s.label || undefined);
    for (const p of ours) this.item(p.at, { part, port: p.port });
    const isSub = e.name.toLowerCase().endsWith('.dig');
    this.imp.tally.add(e.name, 'empty chip, same pins', 'stub');
    this.problem(e, isSub
      ? `${e.name} ${this.known(baseOf(e.name)) ? 'places a circuit that places it (a cycle)' : 'was not among the files'}: an empty chip with ${ours.length} pin${ours.length === 1 ? '' : 's'}${inferred ? ' guessed from the wires' : ''}`
      : `not imported: an empty chip with ${ours.length} pin${ours.length === 1 ? '' : 's'}${inferred ? ' guessed from the wires' : ''}`);
  }

  /** Wires along Digital's: each net's wire graph cut into paths that end on pins, ports and pointers or branch off earlier paths. */
  private emitWires(segs: [DPt, DPt][], live: (k: string) => boolean) {
    const itemsAt = (k: string) => (live(k) ? this.items.get(k) ?? [] : []);
    const terminal = (k: string) => itemsAt(k).length > 0;
    // pins / pointers first: their position is exactly the Digital point
    const first = (k: string): Item => [...itemsAt(k)].sort((a, b) => +a.part - +b.part)[0];
    const adj = new Map<string, { to: string; i: number }[]>();
    segs.forEach(([a, b], i) => {
      for (const [x, y] of [[a, b], [b, a]]) {
        const l = adj.get(key(x)) ?? [];
        l.push({ to: key(y), i });
        adj.set(key(x), l);
      }
    });
    const dead = new Set<number>();
    const degree = (k: string) => (adj.get(k) ?? []).filter((e) => !dead.has(e.i)).length;
    // prune dangling wire ends (nothing there)
    for (let changed = true; changed;) {
      changed = false;
      for (const [k, es] of adj) {
        if (terminal(k) || degree(k) !== 1) continue;
        for (const e of es) if (!dead.has(e.i)) dead.add(e.i);
        changed = true;
      }
    }
    const owner = new Map<string, string>();
    const usedSeg = new Set<number>();
    const visited = new Set<string>();
    const endRef = (k: string): EndRef => (terminal(k) ? first(k).end : { wire: owner.get(k)!, at: S(this.pts.get(k)!) });
    const emit = (path: string[]) => {
      const id = `w${this.doc.wires.length + 1}`;
      const P = path.map((k) => this.pts.get(k)!);
      const a = endRef(path[0]), b = endRef(path[path.length - 1]);
      const pts: Vec[] = P.slice(1, -1).map(S);
      if (terminal(path[0]) && 'part' in a) pts.unshift(S(P[0]));
      if (terminal(path[path.length - 1]) && 'part' in b) pts.push(S(P[P.length - 1]));
      const w: WireDoc = { id, a, b, pts };
      if (P.some((p, i) => i > 0 && p[0] !== P[i - 1][0] && p[1] !== P[i - 1][1])) w.straight = true;
      this.doc.wires.push(w);
      return id;
    };
    for (const [root] of adj) {
      if (!terminal(root) || visited.has(root) || !degree(root)) continue;
      // spanning tree of this component, from a terminal
      const kids = new Map<string, string[]>();
      const extra: number[] = [];
      visited.add(root);
      const queue = [root];
      while (queue.length) {
        const k = queue.shift()!;
        for (const e of adj.get(k) ?? []) {
          if (dead.has(e.i) || usedSeg.has(e.i)) continue;
          usedSeg.add(e.i);
          if (visited.has(e.to)) { extra.push(e.i); continue; }
          visited.add(e.to);
          (kids.get(k) ?? kids.set(k, []).get(k)!).push(e.to);
          queue.push(e.to);
        }
      }
      const starts: [string, string][] = (kids.get(root) ?? []).map((c) => [root, c]);
      while (starts.length) {
        const [s, c] = starts.shift()!;
        const path = [s];
        let cur = c;
        for (;;) {
          path.push(cur);
          const ks = kids.get(cur) ?? [];
          if (terminal(cur) || !ks.length) { for (const k of ks) starts.push([cur, k]); break; }
          for (const k of ks.slice(1)) starts.push([cur, k]);
          cur = ks[0];
        }
        const id = emit(path);
        for (const k of path.slice(1, -1)) if (!terminal(k)) owner.set(k, id);
      }
      for (const i of extra) {
        const [a, b] = segs[i];
        if ((terminal(key(a)) || owner.has(key(a))) && (terminal(key(b)) || owner.has(key(b)))) emit([key(a), key(b)]);
      }
    }
    // several pins / ports / pointers on one point: tie them to the first
    for (const [k, its] of this.items) {
      if (its.length < 2) continue;
      const f = first(k);
      for (const it of its) {
        if (it === f) continue;
        this.doc.wires.push({ id: `w${this.doc.wires.length + 1}`, a: f.end, b: it.end, pts: f.part || it.part ? [S(this.pts.get(k)!)] : [] });
      }
    }
  }

  private placeParts() {
    for (const al of this.aligns) {
      const p = this.doc.parts.find((q) => q.id === al.part)!;
      const def = this.imp.defOf(p.ref);
      if (!def) continue;
      const g = def.ports.some((q) => q.name === al.port) ? instPort(def, [0, 0], p.flip, al.port, p.rot).pos : [0, 0];
      let target = al.at ?? [0, 0];
      if (al.rel) {
        const r = this.doc.parts.find((q) => q.id === al.rel!.part);
        const rd = r && this.imp.defOf(r.ref);
        if (r && rd && rd.ports.some((q) => q.name === al.rel!.port)) {
          const rp = instPort(rd, r.at, r.flip, al.rel.port, r.rot).pos;
          target = [rp[0] + al.rel.dx, rp[1] + al.rel.dy];
        }
      }
      p.at = [target[0] - g[0], target[1] - g[1]];
    }
  }

  /** Our part orientation for a Digital element's rotation / mirror. */
  static orient(e: DElem): { flip?: true; rot?: 1 | 2 | 3 } {
    const r = e.mirror ? (6 - e.rot) % 4 : (4 - e.rot) % 4;
    return { ...(e.mirror ? { flip: true as const } : {}), ...(r ? { rot: r as 1 | 2 | 3 } : {}) };
  }
}

// ---- helpers ----------------------------------------------------------------------------------

function chunks<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

/** Digital's DataField text: hex words separated by commas, `count*word` for a run. */
function readData(s: string, max: number): bigint[] {
  const out: bigint[] = [];
  for (const raw of s.split(/[,\s]+/)) {
    const t = raw.trim();
    if (!t) continue;
    const m = /^(\d+)\*([0-9a-fA-F]+)$/.exec(t);
    try {
      if (m) for (let i = 0; i < +m[1] && out.length < max; i++) out.push(BigInt(`0x${m[2]}`));
      else if (/^[0-9a-fA-F]+$/.test(t)) out.push(BigInt(`0x${t}`));
    } catch { /* skip */ }
    if (out.length >= max) break;
  }
  return out;
}

class UF {
  private p = new Map<string, string>();
  find(x: string): string {
    let r = x;
    while (this.p.has(r) && this.p.get(r) !== r) r = this.p.get(r)!;
    let c = x;
    while (c !== r) { const n = this.p.get(c)!; this.p.set(c, r); c = n; }
    return r;
  }
  union(a: string, b: string) {
    const [x, y] = [this.find(a), this.find(b)];
    if (x !== y) this.p.set(x, y);
  }
}

/**
 * Digital's WireConsistencyChecker: horizontal (vertical) wires on one line that overlap or touch become one, then
 * each is split where a vertical (horizontal) or diagonal wire ends on its inside. Diagonals stay as drawn.
 */
export function normalizeWires(ws: [DPt, DPt][]): [DPt, DPt][] {
  const hori = new Map<number, [number, number][]>(), vert = new Map<number, [number, number][]>();
  const diag: [DPt, DPt][] = [];
  const hp: DPt[] = [], vp: DPt[] = [], dp: DPt[] = [];
  const addTo = (m: Map<number, [number, number][]>, line: number, a: number, b: number) => (m.get(line) ?? m.set(line, []).get(line)!).push([Math.min(a, b), Math.max(a, b)]);
  for (const [a, b] of ws) {
    if (a[0] === b[0] && a[1] === b[1]) continue;
    if (a[1] === b[1]) { addTo(hori, a[1], a[0], b[0]); hp.push(a, b); }
    else if (a[0] === b[0]) { addTo(vert, a[0], a[1], b[1]); vp.push(a, b); }
    else {
      if (!diag.some(([c, d]) => (key(c) === key(a) && key(d) === key(b)) || (key(c) === key(b) && key(d) === key(a)))) diag.push([a, b]);
      dp.push(a, b);
    }
  }
  const merge = (m: Map<number, [number, number][]>) => {
    for (const [line, iv] of m) {
      iv.sort((x, y) => x[0] - y[0]);
      const out: [number, number][] = [];
      for (const s of iv) {
        const l = out[out.length - 1];
        if (l && s[0] <= l[1]) l[1] = Math.max(l[1], s[1]);
        else out.push([s[0], s[1]]);
      }
      m.set(line, out);
    }
  };
  merge(hori);
  merge(vert);
  const protect = (m: Map<number, [number, number][]>, pts: DPt[], lineOf: (p: DPt) => number, sOf: (p: DPt) => number) => {
    for (const p of pts) {
      const iv = m.get(lineOf(p));
      if (!iv) continue;
      const s = sOf(p);
      for (let i = 0; i < iv.length; i++) {
        if (iv[i][0] < s && s < iv[i][1]) { iv.push([s, iv[i][1]]); iv[i] = [iv[i][0], s]; }
      }
    }
  };
  protect(hori, [...dp, ...vp], (p) => p[1], (p) => p[0]);
  protect(vert, [...dp, ...hp], (p) => p[0], (p) => p[1]);
  const out: [DPt, DPt][] = [];
  for (const [y, iv] of hori) for (const [a, b] of iv) out.push([[a, y], [b, y]]);
  for (const [x, iv] of vert) for (const [a, b] of iv) out.push([[x, a], [x, b]]);
  return [...out, ...diag];
}

// ---- entry point ------------------------------------------------------------------------------

export function importDigital(files: SourceFile[], opts: ImportOptions): ImportResult | ImportFailure {
  const circuits: DCircuit[] = [];
  const problems: string[] = [];
  for (const f of files) {
    const c = readCircuit(f);
    if (typeof c === 'string') problems.push(c);
    else if (!circuits.some((d) => d.base === c.base)) circuits.push(c);
  }
  if (!circuits.length) return { error: problems[0] ?? 'no Digital circuit in the files' };
  const byBase = new Map(circuits.map((c) => [c.base, c]));
  const placed = new Set(circuits.flatMap((c) => c.elems.filter((e) => /\.dig$/i.test(e.name)).map((e) => baseOf(e.name))));
  const top = circuits.find((c) => !placed.has(c.base)) ?? circuits[0];

  const imp = new Importer(opts.taken);
  imp.problems.push(...problems);
  const state = new Map<string, 'busy' | 'done'>();
  const build = (c: DCircuit): void => {
    if (state.get(c.base)) return;
    state.set(c.base, 'busy');
    // the circuits it places first (a cycle: the inner placement becomes an empty chip)
    for (const e of c.elems) {
      const b = /\.dig$/i.test(e.name) ? byBase.get(baseOf(e.name)) : undefined;
      if (b && !state.get(b.base)) build(b);
    }
    const sub = (base: string) => (state.get(base) === 'done' ? byBase.get(base) : undefined);
    const sheet = new Sheet(imp, c, imp.chipId(c.name), sub, (b) => byBase.has(b));
    for (const e of c.elems) sheet.element(e);
    const doc = sheet.finish();
    // our pin names for the Digital names its parents place
    const pins = new Map<string, string>();
    for (const n of [...c.ins, ...c.outs]) pins.set(n, sheet.pinMap.get(n) ?? n);
    imp.add(doc);
    imp.made.set(c.base, { id: doc.id, pins });
    state.set(c.base, 'done');
  };
  build(top);
  for (const c of circuits) build(c);

  return { format: 'digital', chips: imp.chips, top: imp.made.get(top.base)!.id, mapping: imp.tally.list(), problems: imp.problems };
}
