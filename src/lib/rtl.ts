// A small register-transfer kit for the Communication chapters' state machines. A design is written as gates on 1-bit
// signals in nested scopes; build() turns each scope into a ComponentDef of its own (a box in its parent) and
// wires the signals that cross a boundary through ports of the same name, so a signal used three levels away from its
// driver is one named port on every box between. Everything is NAND gates (through the library's gates), the library's
// D flip-flop and tie cells: the result is an ordinary netlist, simulated, counted, drawn and opened like any other.

import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { define, merger, ones, splitter } from './define';
import { AND, MUX2, NOR, NOT, OR, XNOR, XOR } from './gates';
import { DFF } from './sequential';
import { DFF_R } from './seqparts';
import { NAND, TIE0, TIE1 } from './transistors';

export type Sig = number;

interface Driver { scope: number; inst: string; port: string }
interface Gate { scope: number; name: string; def: ComponentDef; ins: Sig[]; out: Sig[]; label?: string }
interface Pin { name: string; width: number; sigs: Sig[] }
interface Scope { id: number; name: string; label: string; parent: number; kids: number[] }

const OUT_PORTS = (d: ComponentDef) => d.ports.filter((p) => p.dir === 'out').map((p) => p.name);
const IN_PORTS = (d: ComponentDef) => d.ports.filter((p) => p.dir === 'in').map((p) => p.name);

export interface RtlOptions {
  id: string;
  name: string;
  category: ComponentDef['category'];
  summary: string;
  label?: string;
  notes?: string;
  /** Wrap a column of the drawing after this many grid units. */
  columnHeight?: number;
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
    const s: Scope = { id: this.scopes.length, name, label, parent: this.cur, kids: [] };
    this.scopes.push(s);
    this.scopes[this.cur].kids.push(s.id);
    const was = this.cur;
    this.cur = s.id;
    try { return fn(); } finally { this.cur = was; }
  }

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
  reg(clk: Sig, name?: string): Sig {
    const q = this.gate(DFF, [-1, clk]);
    if (name) this.name(q, name);
    this.pending.set(q, this.gates[this.gates.length - 1]);
    return q;
  }
  /** A flip-flop with an asynchronous active-low reset. */
  regR(clk: Sig, rstn: Sig, name?: string): Sig {
    const q = this.gate(DFF_R, [-1, clk, rstn]);
    if (name) this.name(q, name);
    this.pending.set(q, this.gates[this.gates.length - 1]);
    return q;
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

  private defs: ComponentDef[] = [];
  build(): ComponentDef {
    if (this.pending.size) throw new Error(`${this.opt.id}: a register has no d`);
    const { imp, exp } = this.plumbing();
    const built = new Map<number, ComponentDef>();
    const rootOf = (s: Sig) => this.root(s);
    const H = this.opt.columnHeight ?? 70;

    const buildScope = (sc: Scope): ComponentDef => {
      const isRoot = sc.id === 0;
      const id = isRoot ? this.opt.id : `${this.opt.id}_${sc.name}`;
      // children first
      for (const k of sc.kids) built.set(k, buildScope(this.scopes[k]));
      // a label is ~0.5 units a character beside its pin and stub: two of them must fit in a column gap
      const L = Math.max(4, ...this.names.filter((_, i) => this.alias[i] === i).map((nm) => nm.length));
      const gapW = Math.ceil(L + 7);
      const b = new Builder(gapW, gapW);
      const myGates = this.gates.filter((g) => g.scope === sc.id);
      const importList = isRoot ? [] : [...imp[sc.id]].map(rootOf);
      const exportList = isRoot ? [] : [...exp[sc.id]].map(rootOf);
      const netName = (s: Sig) => this.names[rootOf(s)];
      // drivers of each signal as seen in this scope
      const drv = new Map<Sig, string>();
      for (const s of importList) drv.set(s, netName(s));
      const place = (def: ComponentDef, label: string | undefined, name: string) => {
        b.add(def, label, name);
        if (b.instances.length > 0 && b.height > H) { b.next(); }
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
        b.next();
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
      b.next();
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
        b.next();
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
      return define({
        id,
        name: isRoot ? this.opt.name : `${this.opt.name}: ${sc.label}`,
        category: isRoot ? this.opt.category : this.opt.category,
        summary: isRoot ? this.opt.summary : `${sc.label} (a block of ${this.opt.name}).`,
        ports,
        symbol: { kind: 'box', label: isRoot ? (this.opt.label ?? this.opt.name) : sc.label },
        netlist: () => ({ pins, instances, nets }),
        ...(isRoot && this.opt.notes ? { notes: this.opt.notes } : {}),
      });
    };
    const top = buildScope(this.scopes[0]);
    this.defs.push(top);
    return top;
  }
}
