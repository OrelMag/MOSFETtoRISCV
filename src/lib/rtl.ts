// A small register-transfer kit for the Communication chapters' state machines. A design is written as gates on 1-bit
// signals in nested scopes; build() turns each scope into a ComponentDef of its own (a box in its parent) and
// wires the signals that cross a boundary through ports of the same name, so a signal used three levels away from its
// driver is one named port on every box between. Everything is NAND gates (through the library's gates), the library's
// D flip-flop and tie cells: the result is an ordinary netlist, simulated, counted, drawn and opened like any other.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { layered } from './layered';
import { define, merger, ones, splitter } from './define';
import { AND, MUX2, NOR, NOT, OR, XNOR, XOR } from './gates';
import { DFF } from './sequential';
import { DFF_R } from './seqparts';
import { NAND, TIE0, TIE1 } from './transistors';

export type Sig = number;

/** Every design built with Rtl, top level first: tests walk them (equivalence across drawing changes, the drawing checks). */
export const RTL_TOPS: ComponentDef[] = [];

interface Driver { scope: number; inst: string; port: string }
interface Gate { scope: number; name: string; def: ComponentDef; ins: Sig[]; out: Sig[]; label?: string }
interface Pin { name: string; width: number; sigs: Sig[] }
interface Scope {
  id: number; name: string; label: string; parent: number; kids: number[];
  /** A block made by split(): its id carries the parent's name, and its ports are ordered register by register. */
  idName?: string; role?: 'next' | 'state' | 'out';
  /** A scope whose gates went into next / state / out blocks: drawn as those three in a row. */
  split?: boolean;
}

/** Every block drawn as next state / state / outputs (drawSplit), for the drawing checks. */
export const RTL_SPLITS: ComponentDef[] = [];

/** The gates split() moves into next state / outputs; any other part (a CRC unit, a counter) stays a box where it was. */
const PLAIN = new Set<ComponentDef>([NAND, NOT, AND, OR, NOR, XOR, XNOR, MUX2, TIE0, TIE1]);

/** A block with at least this many gates of its own, flip-flops among them, is drawn as next state, state register and outputs. */
export const SPLIT_MIN = 40;

const OUT_PORTS = (d: ComponentDef) => d.ports.filter((p) => p.dir === 'out').map((p) => p.name);
const IN_PORTS = (d: ComponentDef) => d.ports.filter((p) => p.dir === 'in').map((p) => p.name);

export interface RtlOptions {
  id: string;
  name: string;
  category: ComponentDef['category'];
  summary: string;
  label?: string;
  notes?: string;
  /** Draw a block of many gates as is, not as next state / state register / outputs (split()). */
  noSplit?: boolean;
  /** Wrap a column of the drawing after this many grid units. */
  columnHeight?: number;
  /** Width of the top box in grid units (default: from its label). */
  boxW?: number;
}

export class Rtl {
  private scopes: Scope[] = [{ id: 0, name: '', label: '', parent: -1, kids: [] }];
  private cur = 0;
  private drivers: Driver[] = [];
  private names: string[] = [];
  private alias: number[] = [];
  private gates: Gate[] = [];
  private ins: Pin[] = [];
  private outs: Pin[] = [];
  private clocks = new Set<string>();
  private pending = new Map<Sig, Gate>();
  private used = new Set<string>();

  constructor(private opt: RtlOptions) {}

  // ---- scopes ------------------------------------------------------------------------------------------------------

  /** Everything made inside fn belongs to a box of its own, `name` (a short identifier) drawn with `label`. */
  scope<T>(name: string, label: string, fn: () => T): T {
    // a scope of the same name in the same parent is entered again: registers can be made at the top and still live in their block
    let s = this.scopes[this.cur].kids.map((k) => this.scopes[k]).find((k) => k.name === name);
    if (!s) {
      s = { id: this.scopes.length, name, label, parent: this.cur, kids: [] };
      this.scopes.push(s);
      this.scopes[this.cur].kids.push(s.id);
    }
    const was = this.cur;
    this.cur = s.id;
    try { return fn(); } finally { this.cur = was; }
  }

  /** scope() in the root, wherever the design is now. */
  rootScope<T>(name: string, label: string, fn: () => T): T {
    const was = this.cur;
    this.cur = 0;
    try { return this.scope(name, label, fn); } finally { this.cur = was; }
  }
  /** What follows goes in this box of the root, until the next within(): a long sequence of signals that would otherwise need passing out of a callback. */
  within(name: string, label: string): void {
    this.cur = 0;
    this.scope(name, label, () => { this.cur = this.scopes[this.cur].id; this.stay = this.cur; });
    this.cur = this.stay;
  }
  private stay = 0;

  // ---- signals -----------------------------------------------------------------------------------------------------

  private fresh(inst: string, port: string, name?: string): Sig {
    const id = this.drivers.length;
    this.drivers.push({ scope: this.cur, inst, port });
    let nm = name ?? `n${id}`;
    while (this.used.has(nm)) nm = `${nm}_${id}`;
    this.used.add(nm);
    this.names.push(nm);
    this.alias.push(id);
    return id;
  }
  private root(s: Sig): Sig { while (this.alias[s] !== s) s = this.alias[s] = this.alias[this.alias[s]]; return s; }

  /** Name a signal (its net and port label); the last name given wins. Names must be unique: a clash gets the signal's number. */
  name(s: Sig, name: string): Sig {
    s = this.root(s);
    let nm = name;
    while (this.used.has(nm)) nm = `${nm}_${s}`;
    this.names[s] = nm;
    this.used.add(nm);
    return s;
  }

  input(name: string, opts: { clock?: boolean } = {}): Sig {
    const s = this.fresh('', name, name);
    this.ins.push({ name, width: 1, sigs: [s] });
    if (opts.clock) this.clocks.add(name);
    return s;
  }
  /** A bus pin of w bits, LSB first. */
  inputBus(name: string, w: number): Sig[] {
    const sp = `sp_${name}`;
    this.used.add(name); // the bus pin itself; its bits are ${name}0, ${name}1 …
    const sigs = Array.from({ length: w }, (_, i) => this.fresh(sp, `o${i}`, `${name}${i}`));
    this.ins.push({ name, width: w, sigs });
    return sigs;
  }
  output(name: string, s: Sig): void { this.outs.push({ name, width: 1, sigs: [s] }); }
  outputBus(name: string, sigs: Sig[]): void { this.outs.push({ name, width: sigs.length, sigs }); }

  // ---- gates -------------------------------------------------------------------------------------------------------

  private parts(def: ComponentDef, ins: Sig[], label?: string, inst?: string): Sig[] {
    const name = inst ?? `g${this.gates.length}`;
    const out = OUT_PORTS(def).map((p) => this.fresh(name, p));
    this.gates.push({ scope: this.cur, name, def, ins, out, label });
    return out;
  }
  private gate(def: ComponentDef, ins: Sig[], label?: string): Sig { return this.parts(def, ins, label)[0]; }
  /** Any library part: inputs in port order, every output returned. Buses go through bus() / unbus(). */
  part(def: ComponentDef, ins: Sig[], label?: string, inst?: string): Sig[] { return this.parts(def, ins, label, inst); }
  /** w bits (LSB first) into one w-bit bus, and back. */
  bus(sigs: Sig[]): Sig { return this.gate(merger(ones(sigs.length)), sigs); }
  unbus(s: Sig, w: number): Sig[] { return this.parts(splitter(ones(w)), [s]); }
  /** A w-bit constant word as one part (lib/alu.ts constWord: its ties and merger inside), not w tie outputs merged here. */
  constBus(v: number, w: number): Sig { return this.gate(constWord(w, v), []); }
  nand(a: Sig, b: Sig): Sig { return this.gate(NAND, [a, b]); }
  not(a: Sig): Sig { return this.gate(NOT, [a]); }
  and(a: Sig, b: Sig): Sig { return this.gate(AND, [a, b]); }
  or(a: Sig, b: Sig): Sig { return this.gate(OR, [a, b]); }
  nor(a: Sig, b: Sig): Sig { return this.gate(NOR, [a, b]); }
  xor(a: Sig, b: Sig): Sig { return this.gate(XOR, [a, b]); }
  xnor(a: Sig, b: Sig): Sig { return this.gate(XNOR, [a, b]); }
  /** s ? b : a */
  mux(s: Sig, a: Sig, b: Sig): Sig { return this.gate(MUX2, [a, b, s]); }
  /** The constant 0 / 1: one tie cell per scope that needs it. */
  const(v: 0 | 1): Sig {
    const key = `${this.cur}:${v}`;
    const hit = this.consts.get(key);
    if (hit !== undefined) return hit;
    const s = this.gate(v ? TIE1 : TIE0, []);
    this.consts.set(key, s);
    return s;
  }
  private consts = new Map<string, Sig>();
  andN(xs: Sig[]): Sig { return this.tree(xs, (a, b) => this.and(a, b)); }
  orN(xs: Sig[]): Sig { return this.tree(xs, (a, b) => this.or(a, b)); }
  private tree(xs: Sig[], f: (a: Sig, b: Sig) => Sig): Sig {
    let cur = xs;
    while (cur.length > 1) {
      const next: Sig[] = [];
      for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? f(cur[i], cur[i + 1]) : cur[i]);
      cur = next;
    }
    return cur[0];
  }
  /** a == a constant (bits LSB first). */
  eqConst(bits: Sig[], v: number): Sig {
    return this.andN(bits.map((b, i) => ((v >> i) & 1 ? b : this.not(b))));
  }
  /** Bitwise a == b. */
  eq(a: Sig[], b: Sig[]): Sig { return this.andN(a.map((x, i) => this.xnor(x, b[i]))); }
  /** a + 1 as half adders (carry-in 1), the carry out dropped. */
  inc(a: Sig[]): Sig[] {
    const out: Sig[] = [];
    let c: Sig | null = null;
    a.forEach((x, i) => {
      if (i === 0) { out.push(this.not(x)); c = x; } else { out.push(this.xor(x, c!)); if (i < a.length - 1) c = this.and(x, c!); }
    });
    return out;
  }

  /** A signal to be driven later (a loop through parts built after it): drive() joins it to the real one. */
  fwd(name?: string): Sig { return this.fresh('', '', name); }
  drive(f: Sig, to: Sig): void { this.alias[f] = this.root(to); }
  /** A D flip-flop on clk; its d comes later (setD), so a register can feed its own next state. */
  reg(clk: Sig, name?: string, home?: [string, string]): Sig {
    const make = () => {
      const q = this.gate(DFF, [-1, clk]);
      if (name) this.name(q, name);
      this.pending.set(q, this.gates[this.gates.length - 1]);
      return q;
    };
    return home ? this.scope(home[0], home[1], make) : make();
  }
  /** A flip-flop with an asynchronous active-low reset. */
  regR(clk: Sig, rstn: Sig, name?: string, home?: [string, string]): Sig {
    const make = () => {
      const q = this.gate(DFF_R, [-1, clk, rstn]);
      if (name) this.name(q, name);
      this.pending.set(q, this.gates[this.gates.length - 1]);
      return q;
    };
    return home ? this.scope(home[0], home[1], make) : make();
  }
  setD(q: Sig, d: Sig): void {
    const g = this.pending.get(q);
    if (!g) throw new Error('setD: not a pending register');
    g.ins[0] = d;
    this.pending.delete(q);
  }

  // ---- build -------------------------------------------------------------------------------------------------------

  /** Each scope: the signals it imports (driven outside) and exports (used outside), in a stable order. */
  private plumbing() {
    const n = this.scopes.length;
    const imp: Set<Sig>[] = this.scopes.map(() => new Set());
    const exp: Set<Sig>[] = this.scopes.map(() => new Set());
    const chain = (s: number) => { const c = [s]; while (this.scopes[c[c.length - 1]].parent >= 0) c.push(this.scopes[c[c.length - 1]].parent); return c; };
    const use = (sig: Sig, at: number) => {
      const d = this.drivers[sig].scope;
      if (d === at) return;
      const up = chain(d), down = chain(at);
      const common = up.find((s) => down.includes(s))!;
      for (const s of up) { if (s === common) break; exp[s].add(sig); }
      for (const s of down) { if (s === common) break; imp[s].add(sig); }
    };
    for (const g of this.gates) g.ins.forEach((s, i) => { if (s < 0) throw new Error(`${this.opt.id}: gate ${g.name} input ${i} is unconnected`); use(this.root(s), g.scope); });
    for (const o of this.outs) o.sigs.forEach((s) => use(this.root(s), 0));
    void n;
    return { imp, exp };
  }

  /** d and q of each register of a split block, by register: ports of the three blocks line up in this order. */
  private regRank = new Map<Sig, number>();

  /**
   * A large block of a state machine as three: the flip-flops (state), the gates whose outputs reach a flip-flop's d
   * (next state), and the rest (outputs). Only the gates' boxes change; every gate keeps its inputs, so the netlist
   * flattens to the same leaves on the same nets (tests/redrawclear-fsm.test.ts holds every design's outputs to it).
   */
  private split(sc: Scope): void {
    if (sc.role) return; // blocks it already has (a ROM, a counter) stay, drawn first
    const mine = this.gates.filter((g) => g.scope === sc.id);
    const isReg = (g: Gate) => g.def === DFF || g.def === DFF_R;
    const isPart = (g: Gate) => !PLAIN.has(g.def) && g.def.prim !== 'alias' && g.def !== DFF && g.def !== DFF_R;
    const partIns = new Set<Sig>(), partOuts = new Set<Sig>();
    for (const g of mine) if (isPart(g)) { g.ins.forEach((x) => partIns.add(this.root(x))); g.out.forEach((x) => partOuts.add(this.root(x))); }
    const plain = (g: Gate) => PLAIN.has(g.def) || (g.def.prim === 'alias' && !g.out.some((x) => partIns.has(this.root(x))) && !g.ins.some((x) => partOuts.has(this.root(x))));
    const regs = mine.filter(isReg);
    if (mine.length < SPLIT_MIN || !regs.length || regs.length === mine.length) return;
    const byOut = new Map<Sig, Gate>();
    for (const g of mine) for (const o of g.out) byOut.set(this.root(o), g);
    const next = new Set<Gate>();
    const walk = (sig: Sig) => {
      const g = byOut.get(this.root(sig));
      if (!g || !plain(g) || next.has(g)) return;
      next.add(g);
      g.ins.forEach(walk);
    };
    for (const r of regs) walk(r.ins[0]);
    const make = (role: 'next' | 'state' | 'out', name: string, label: string, gates: Gate[]) => {
      if (!gates.length) return;
      // a name its parent does not use yet (a block may already have a 'state' of its own)
      const taken = new Set(sc.kids.map((k) => this.scopes[k].name));
      let nm = name;
      for (let i = 2; taken.has(nm); i++) nm = `${name}${i}`;
      const k: Scope = { id: this.scopes.length, name: nm, label, parent: sc.id, kids: [], idName: sc.id === 0 ? nm : `${sc.idName ?? sc.name}_${nm}`, role };
      this.scopes.push(k);
      sc.kids.push(k.id);
      for (const g of gates) { g.scope = k.id; for (const o of g.out) this.drivers[this.root(o)].scope = k.id; }
    };
    // one or two output gates are not worth a box of their own (its label would not fit it): they join the logic
    const outs = mine.filter((g) => plain(g) && !next.has(g)), few = outs.length > 0 && outs.length <= 2;
    make('next', 'next', few ? 'next state, outputs' : 'next state', mine.filter((g) => next.has(g) || (few && outs.includes(g))));
    make('state', 'state', 'state', regs);
    if (!few) make('out', 'out', 'outputs', outs);
    sc.split = true;
    regs.forEach((r, i) => { this.regRank.set(this.root(r.ins[0]), i); this.regRank.set(this.root(r.out[0]), i); });
  }

  /**
   * A split block's own drawing: its inputs at the left, next state, state and outputs in a row, its outputs at the right.
   * Each block is lined up on the first signal it takes from the one before, so a register's d runs straight from next
   * state into the state block and its q on into the outputs; a signal that runs backwards (q into next state), skips a
   * block, or comes from a pin is a pointer.
   */
  private drawSplit(sc: Scope, id: string, importList: Sig[], exportList: Sig[], built: Map<number, ComponentDef>, exp: Set<Sig>[], imp: Set<Sig>[]): ComponentDef {
    const rootOf = (s: Sig) => this.root(s);
    const netName = (s: Sig) => this.names[rootOf(s)];
    const L = Math.max(4, ...this.names.filter((_, i) => this.alias[i] === i).map((nm) => nm.length));
    const gapW = Math.ceil(L + 7);
    // a block: a sub-scope (ports named after its signals) or a part left at this level (its own port names)
    interface Block { name: string; def: ComponentDef; label?: string; ins: [string, Sig][]; outs: [string, Sig][]; col: number }
    let col = 0;
    const fromScope = (k: Scope): Block => ({ name: k.name, def: built.get(k.id)!, label: k.label, ins: [...imp[k.id]].map((x) => [netName(x), rootOf(x)]), outs: [...exp[k.id]].map((x) => [netName(x), rootOf(x)]), col: col++ });
    const kidScopes = sc.kids.map((k) => this.scopes[k]);
    const left = kidScopes.filter((k) => !k.role).map(fromScope);
    // the parts left at this level (with the mergers and splitters of their buses) share one column
    const own = this.gates.filter((g) => g.scope === sc.id);
    const partCol = own.length ? col++ : -1;
    const parts = own.map((g): Block => ({ name: g.name, def: g.def, label: g.label, ins: IN_PORTS(g.def).map((p, i) => [p, rootOf(g.ins[i])]), outs: OUT_PORTS(g.def).map((p, i) => [p, rootOf(g.out[i])]), col: partCol }));
    const blocks: Block[] = [...left, ...parts, ...kidScopes.filter((k) => k.role).map(fromScope)];
    const instances: InstanceDef[] = [];
    let x = gapW;
    for (let c = 0; c < col; c++) {
      const here = blocks.filter((bl) => bl.col === c);
      let y = 2, w = 0;
      here.forEach((bl, j) => {
        const g = symbolGeom(bl.def);
        if (here.length === 1 && c > 0) {
          // a block alone in its column lines up on the first signal it takes from the column before
          const before = blocks.filter((p) => p.col === c - 1).at(-1)!, bAt = instances[blocks.indexOf(before)].at!, bg = symbolGeom(before.def);
          const from = new Map(before.outs.map(([p, s]) => [s, p]));
          const shared = bl.ins.find(([, s]) => from.has(s));
          y = shared ? bAt[1] + bg.ports[from.get(shared[1])!].pos[1] - g.ports[shared[0]].pos[1] : bAt[1];
        }
        instances.push({ name: bl.name, def: bl.def, at: [x, y], label: bl.label });
        y += g.h + 4 * (j < here.length - 1 ? 1 : 0);
        w = Math.max(w, g.w);
      });
      x += w + 2 * gapW; // room for a pointer on each side of the gap
    }
    const top = Math.min(...instances.map((i) => i.at![1]));
    if (top < 2) for (const i of instances) i.at = [i.at![0], i.at![1] + 2 - top];
    const R = x - gapW;
    const ports: PortDef[] = [];
    const pins: Record<string, [number, number]> = {};
    importList.forEach((s, i) => { ports.push({ name: netName(s), width: 1, dir: 'in', ...(this.clocks.has(netName(s)) ? { side: 'bottom' as const, clock: true } : {}) }); pins[netName(s)] = [0, 2 + 2 * i]; });
    exportList.forEach((s, i) => { ports.push({ name: netName(s), width: 1, dir: 'out' }); pins[netName(s)] = [R, 2 + 2 * i]; });
    const drv = new Map<Sig, { end: string; col: number }>();
    for (const s of importList) drv.set(s, { end: netName(s), col: -1 });
    for (const bl of blocks) for (const [p, s] of bl.outs) drv.set(s, { end: `${bl.name}.${p}`, col: bl.col });
    const sinks = new Map<Sig, { end: string; col: number }[]>();
    const add = (s: Sig, end: string, c: number) => { const r = rootOf(s); if (!sinks.has(r)) sinks.set(r, []); sinks.get(r)!.push({ end, col: c }); };
    for (const bl of blocks) for (const [p, s] of bl.ins) add(s, `${bl.name}.${p}`, bl.col);
    for (const s of exportList) add(s, netName(s), col);
    const nets: NetDef[] = [];
    for (const [s, ends] of sinks) {
      const d = drv.get(s);
      if (!d) throw new Error(`${id}: no driver for ${netName(s)}`);
      // a wire only into the block right after the driver's, or from the last block out to a pin; the rest are pointers
      const tags = ends.filter((e) => d.col < 0 || e.col !== d.col + 1).map((e) => e.end);
      const net: NetDef = { name: netName(s), ends: [d.end, ...ends.map((e) => e.end)] };
      if (tags.length === ends.length) net.tags = true;
      else if (tags.length) net.tags = tags;
      nets.push(net);
    }
    const def = define({
      id,
      name: `${this.opt.name}: ${sc.label}`,
      category: this.opt.category,
      summary: `${sc.label} (a block of ${this.opt.name}): its next-state logic, its state register and its outputs.`,
      ports,
      symbol: { kind: 'box', label: sc.label },
      netlist: () => ({ pins, instances, nets }),
    });
    if (!RTL_SPLITS.includes(def)) RTL_SPLITS.push(def);
    return def;
  }

  private defs: ComponentDef[] = [];
  build(): ComponentDef {
    if (this.pending.size) throw new Error(`${this.opt.id}: a register has no d`);
    if (!this.opt.noSplit) for (const sc of [...this.scopes]) this.split(sc);
    const { imp, exp } = this.plumbing();
    const built = new Map<number, ComponentDef>();
    const rootOf = (s: Sig) => this.root(s);

    const buildScope = (sc: Scope): ComponentDef => {
      const isRoot = sc.id === 0;
      const id = isRoot ? this.opt.id : `${this.opt.id}_${sc.idName ?? sc.name}`;
      // children first
      for (const k of sc.kids) built.set(k, buildScope(this.scopes[k]));
      // a label is ~0.5 units a character beside its pin and stub: two of them must fit in a column gap
      const L = Math.max(4, ...this.names.filter((_, i) => this.alias[i] === i).map((nm) => nm.length));
      const gapW = Math.ceil(L + 7);
      const b = new Builder(gapW, gapW);
      const myGates = this.gates.filter((g) => g.scope === sc.id);
      const byReg = (xs: Sig[]) => (sc.role ? [...xs].sort((a, b) => (this.regRank.get(a) ?? 1e9) - (this.regRank.get(b) ?? 1e9)) : xs);
      const importList = isRoot ? [] : byReg([...imp[sc.id]].map(rootOf));
      const exportList = isRoot ? [] : byReg([...exp[sc.id]].map(rootOf));
      if (sc.split && !isRoot) return this.drawSplit(sc, id, importList, exportList, built, exp, imp);
      const netName = (s: Sig) => this.names[rootOf(s)];
      // drivers of each signal as seen in this scope
      const drv = new Map<Sig, string>();
      for (const s of importList) drv.set(s, netName(s));
      // columns tall enough for a roughly square drawing: ~24 units a column, ~8 a gate
      const H = this.opt.columnHeight ?? Math.max(40, Math.round(Math.sqrt(192 * this.gates.filter((g) => g.scope === sc.id).length)));
      let colH = 0;
      const place = (def: ComponentDef, label: string | undefined, name: string) => {
        b.add(def, label, name);
        colH += symbolGeom(def).h + 4;
        if (colH > H) { b.next(); colH = 0; }
      };
      // root pins that are buses: a splitter / merger each
      const ports: PortDef[] = [];
      const pinNames = new Set<string>();
      if (isRoot) {
        for (const p of this.ins) {
          ports.push({ name: p.name, width: p.width, dir: 'in', ...(this.clocks.has(p.name) ? { side: 'bottom' as const, clock: true } : {}) });
          if (p.width === 1) drv.set(p.sigs[0], p.name);
          else {
            place(splitter(ones(p.width)), undefined, `sp_${p.name}`);
            b.wire(p.name, `sp_${p.name}.in`);
            p.sigs.forEach((s, i) => drv.set(s, `sp_${p.name}.o${i}`));
          }
          pinNames.add(p.name);
          b.pins(p.name);
        }
        b.next(); colH = 0;
      } else {
        for (const s of importList) { ports.push({ name: netName(s), width: 1, dir: 'in', ...(this.clocks.has(netName(s)) ? { side: 'bottom' as const, clock: true } : {}) }); pinNames.add(netName(s)); b.pins(netName(s)); }
      }
      // child instances, then gates in creation order
      const kidInst = new Map<number, string>();
      for (const k of sc.kids) {
        const kd = built.get(k)!;
        const nm = this.scopes[k].name;
        place(kd, this.scopes[k].label, nm);
        kidInst.set(k, nm);
        for (const s of exp[k]) drv.set(rootOf(s), `${nm}.${netName(s)}`);
      }
      b.next(); colH = 0;
      for (const g of myGates) {
        place(g.def, g.label, g.name);
        OUT_PORTS(g.def).forEach((p, i) => drv.set(g.out[i], `${g.name}.${p}`));
      }
      // wire every input
      const need = new Set<Sig>();
      const link = (s: Sig, sink: string) => {
        const r = rootOf(s);
        const d = drv.get(r);
        if (d === undefined) throw new Error(`${id}: no driver for ${netName(r)} (${sink})`);
        b.wire(d, sink);
        need.add(r);
      };
      for (const g of myGates) IN_PORTS(g.def).forEach((p, i) => link(g.ins[i], `${g.name}.${p}`));
      for (const k of sc.kids) for (const s of imp[k]) link(s, `${this.scopes[k].name}.${netName(s)}`);
      // outputs
      if (isRoot) {
        b.next(); colH = 0;
        for (const o of this.outs) {
          ports.push({ name: o.name, width: o.width, dir: 'out' });
          if (o.width === 1) link(o.sigs[0], o.name);
          else {
            place(merger(ones(o.width)), undefined, `mg_${o.name}`);
            o.sigs.forEach((s, i) => link(s, `mg_${o.name}.i${i}`));
            b.wire(`mg_${o.name}.out`, o.name);
          }
        }
      } else {
        for (const s of exportList) { ports.push({ name: netName(s), width: 1, dir: 'out' }); link(s, netName(s)); }
      }
      // names and labels: every net is a label (a long line between columns is a label in a real schematic)
      for (const [s, d] of drv) {
        if (!need.has(s)) continue;
        if (d.includes('.')) b.name(d, netName(s), true);
      }
      const R = b.right;
      const inP = ports.filter((p) => p.dir === 'in'), outP = ports.filter((p) => p.dir === 'out');
      const pins: Record<string, [number, number]> = {};
      inP.forEach((p, i) => { pins[p.name] = [0, 2 + 2 * i]; });
      outP.forEach((p, i) => { pins[p.name] = [R, 2 + 2 * i]; });
      // a pin used as a driver is named after itself; a pass-through (in → out) is a net of two pins
      const nets: NetDef[] = b.nets();
      const instances: InstanceDef[] = b.instances;
      // a block of gates is laid out by logic depth, rows level with what they talk to, its short nets drawn as wires where
      // no other part stands between their ends (lib/layered.ts, avoid): a small block, and a split block's next state / outputs
      // of any size (drawn in columns with every net a label they read as nothing but pointers: 31 276 of 32 244 nets over the
      // book's blocks, 16 274 laid out); not one of boxes or wide buses, whose pointer names need wider channels than layered
      // leaves. Laid out when the level is first opened, not when the design is built. room: a split block's labels need it.
      const small = !sc.kids.length && (!!sc.role || instances.length <= SPLIT_MIN) && instances.every((i) => i.def.ports.length <= 8);
      let lay: ReturnType<typeof layered> | null = null;
      const laid = () => (lay ??= layered(ports, b, { gap: 14, x0: gapW, avoid: true, ...(sc.role ? { room: true } : {}) })); // x0: room for a pin's pointer
      return define({
        id,
        name: isRoot ? this.opt.name : sc.role ? `${this.opt.name}: ${this.scopes[sc.parent].label || this.opt.name}, ${sc.label}` : `${this.opt.name}: ${sc.label}`,
        category: isRoot ? this.opt.category : this.opt.category,
        summary: isRoot ? this.opt.summary : `${sc.label} (a block of ${this.opt.name}).`,
        ports,
        symbol: { kind: 'box', label: isRoot ? (this.opt.label ?? this.opt.name) : sc.label, ...(isRoot && this.opt.boxW ? { w: this.opt.boxW } : {}) },
        netlist: () => (small ? laid() : { pins, instances, nets }),
        ...(isRoot && this.opt.notes ? { notes: this.opt.notes } : {}),
      });
    };
    const top = buildScope(this.scopes[0]);
    this.defs.push(top);
    if (!RTL_TOPS.includes(top)) RTL_TOPS.push(top);
    return top;
  }
}
