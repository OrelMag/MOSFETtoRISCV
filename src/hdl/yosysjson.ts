// Yosys's JSON netlist (`write_json`) → sandbox chips. Every fine-grained cell becomes library parts (a NAND
// is our NAND, a flip-flop our master–slave DFF, a reset or an enable the gates around it), so an imported
// design opens down to transistors like everything else; every module becomes a user chip and its module
// instances placed chips, so the hierarchy survives. The JSON carries no drawing: parts are placed left to
// right by logic depth (feedback through storage cut), each column ordered by where its drivers sit, short
// nets wired and long ones drawn as pointers named after the Verilog signal. docFromDef then routes it.

import { docFromDef } from '../editor/fromdef';
import { compileChip } from '../editor/compile';
import { type ChipDoc, isIdent, type PartRef, slug, uniqueName } from '../editor/model';
import { isError, MAX_WIDTH, partDef } from '../editor/parts';
import { symbolGeom, type Vec } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';

type YBit = number | '0' | '1' | 'x' | 'z';
interface YPort { direction: 'input' | 'output' | 'inout'; bits: YBit[] }
interface YCell {
  type: string;
  hide_name?: number;
  connections?: Record<string, YBit[]>;
  port_directions?: Record<string, 'input' | 'output' | 'inout'>;
  attributes?: Record<string, unknown>;
}
interface YNet { hide_name?: number; bits: YBit[] }
interface YModule {
  attributes?: Record<string, unknown>;
  ports?: Record<string, YPort>;
  cells?: Record<string, YCell>;
  netnames?: Record<string, YNet>;
}

export interface HdlDiag {
  level: 'error' | 'warn';
  msg: string;
  /** The Verilog module it is about. */
  module?: string;
  /** Source position from Yosys's `src` attribute, when the cell carries one: file and line. */
  file?: string;
  line?: number;
}

export interface ImportedModule {
  /** Yosys's module name. */
  module: string;
  chip: string;
  /** Yosys cells by type ($_NAND_ 12, add4 1, …). */
  cells: Record<string, number>;
}

export interface HdlImport {
  /** Bottom-up: every chip after the chips it places; the top module's last. */
  chips: ChipDoc[];
  top: string;
  modules: ImportedModule[];
  diags: HdlDiag[];
}

export interface ImportOptions {
  /** The top module (default: the one Yosys marked top, else the one nothing instantiates). */
  top?: string;
  /** Chip id for a module (resynthesis keeps its chips); default `u_<slug>` made unique against `taken`. */
  idOf?: (module: string, isTop: boolean) => string | undefined;
  taken?: Iterable<string>;
}

/** Is this text a Yosys JSON netlist (rather than a sandbox export)? */
export function isYosysJson(v: unknown): v is { modules: Record<string, YModule> } {
  return !!v && typeof v === 'object' && !('format' in v) && 'modules' in v
    && !!(v as { modules: unknown }).modules && typeof (v as { modules: unknown }).modules === 'object';
}

const WORD_CELL = /^\$(?!_)/; // $add, $and, $dff …: the coarse cells before techmap

/** Yosys's JSON (parsed) → chips, or why not. */
export function importYosysJson(json: unknown, opts: ImportOptions = {}): HdlImport | { error: string } {
  if (!isYosysJson(json)) return { error: 'not a Yosys JSON netlist (no "modules")' };
  const mods = json.modules;
  const names = Object.keys(mods).filter((n) => !isBlackbox(mods[n]));
  if (!names.length) return { error: 'the netlist has no modules' };

  // Which modules each one instantiates, for the order and the top.
  const uses = new Map<string, Set<string>>();
  for (const n of names) {
    const s = new Set<string>();
    for (const c of Object.values(mods[n].cells ?? {})) if (c.type in mods && !isBlackbox(mods[c.type])) s.add(c.type);
    uses.set(n, s);
  }
  let top = opts.top;
  if (top !== undefined && !names.includes(top)) return { error: `no module '${top}'` };
  if (top === undefined) {
    const marked = names.filter((n) => Number(String(mods[n].attributes?.top ?? '0').replace(/^0+(?=.)/, '')) === 1);
    const unused = names.filter((n) => ![...uses.values()].some((s) => s.has(n)));
    top = marked[0] ?? unused[unused.length - 1] ?? names[names.length - 1];
  }
  // The top and what it reaches, bottom-up.
  const order: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): string | undefined => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) return `module '${n}' instantiates itself`;
    state.set(n, 1);
    for (const u of uses.get(n)!) { const e = visit(u); if (e) return e; }
    state.set(n, 2);
    order.push(n);
  };
  const cyc = visit(top);
  if (cyc) return { error: cyc };

  const taken = new Set(opts.taken ?? []);
  const ids = new Map<string, string>();
  for (const n of order) {
    const want = opts.idOf?.(n, n === top);
    const id = want ?? uniqueName(`u_${slug(n)}`, taken);
    taken.add(id);
    ids.set(n, id);
  }

  const diags: HdlDiag[] = [];
  const defs = new Map<string, ComponentDef>(); // chip id → compiled def
  const chips: ChipDoc[] = [];
  const modules: ImportedModule[] = [];
  for (const n of order) {
    const r = buildModule(n, mods[n], ids, defs, mods);
    if ('error' in r) return { error: `module ${n}: ${r.error}` };
    diags.push(...r.diags.map((d) => ({ ...d, module: n })));
    const doc = r.doc;
    const c = compileChip(doc, (ref) => partDef(ref, (id) => defs.get(id)));
    const errs = c.diags.filter((d) => d.level === 'error');
    if (errs.length) return { error: `module ${n}: the drawn chip does not compile: ${errs[0].msg}` };
    defs.set(doc.id, c.def);
    chips.push(doc);
    modules.push({ module: n, chip: doc.id, cells: r.cells });
  }
  return { chips, top: ids.get(top)!, modules, diags };
}

const isBlackbox = (m: YModule) => !!m.attributes && ('blackbox' in m.attributes || 'whitebox' in m.attributes);

/** A Verilog name as a sandbox identifier: `q[3]` → q_3, `\a.b` → a_b. */
export function identOf(name: string): string {
  let s = name.replace(/^\\/, '').replace(/\[(\d+)\]/g, '_$1').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+(?=.)|_+$/g, '');
  if (!s) s = 'n';
  if (/^\d/.test(s)) s = `_${s}`;
  return isIdent(s) ? s : 'n';
}

/** Yosys `src` attribute ("top.v:12.3-12.40|…") → file and line. */
export function srcOf(attrs: Record<string, unknown> | undefined): { file?: string; line?: number } {
  const s = typeof attrs?.src === 'string' ? attrs.src : '';
  const m = /^([^|:]+):(\d+)/.exec(s);
  return m ? { file: m[1], line: Number(m[2]) } : {};
}

// ---------------------------------------------------------------------------------------------------------

/** One part being placed: its def, how the document refers to it, its column. */
interface Inst {
  name: string;
  def: ComponentDef;
  ref: PartRef;
  label?: string;
  /** Fixed column: 'in' (input splitters), 'out' (output mergers), else placed by depth. */
  fixed?: 'in' | 'out';
  col: number;
  y: number;
}

/** A net in the making: a driver end and its sinks ('inst.port' or a pin name). */
interface NetB { drv?: string; sinks: string[]; name?: string; bus?: boolean }


function buildModule(
  modName: string, m: YModule, ids: Map<string, string>, defs: Map<string, ComponentDef>, all: Record<string, YModule>,
): { doc: ChipDoc; diags: HdlDiag[]; cells: Record<string, number> } | { error: string } {
  const diags: HdlDiag[] = [];
  const warn = (msg: string, attrs?: Record<string, unknown>) => diags.push({ level: 'warn', msg, ...srcOf(attrs) });
  const cells: Record<string, number> = {};

  // ---- bits: $_BUF_ merged away (union–find), constants as their own keys ----
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.has(r)) r = parent.get(r)!;
    if (r !== k) parent.set(k, r);
    return r;
  };
  const keyOf = (b: YBit): string => (typeof b === 'number' ? `b${b}` : b === '1' ? '1' : '0');
  const cellList = Object.entries(m.cells ?? {});
  for (const [, c] of cellList) {
    if (c.type !== '$_BUF_') continue;
    const a = find(keyOf(c.connections?.A?.[0] ?? 'x')), y = find(keyOf(c.connections?.Y?.[0] ?? 'x'));
    if (a === y) continue;
    if (y === '0' || y === '1') { if (a !== '0' && a !== '1') parent.set(a, y); }
    else parent.set(y, a);
  }
  const K = (b: YBit): string => {
    if (b === 'x' || b === 'z') { undef++; return '0'; }
    return find(keyOf(b));
  };
  let undef = 0;

  // ---- signal names: a bit's Verilog name (ports first, then named wires) ----
  const bitName = new Map<string, string>();
  const nameBits = (n: string, bits: YBit[]) => {
    bits.forEach((b, i) => {
      if (typeof b !== 'number') return;
      const k = find(keyOf(b));
      if (!bitName.has(k)) bitName.set(k, identOf(bits.length > 1 ? `${n}_${i}` : n));
    });
  };
  for (const [n, p] of Object.entries(m.ports ?? {})) nameBits(n, p.bits);
  for (const [n, w] of Object.entries(m.netnames ?? {})) if (!w.hide_name) nameBits(n, w.bits);

  // ---- parts and nets ----
  const insts: Inst[] = [];
  const instByName = new Map<string, Inst>();
  const takenNames = new Set<string>();
  const refs = new Map<ComponentDef, PartRef>();
  const nets = new Map<string, NetB>(); // 1-bit nets by bit key
  const busNets: NetB[] = [];
  let fresh = 0;
  const net = (k: string): NetB => {
    let n = nets.get(k);
    if (!n) nets.set(k, (n = { sinks: [] }));
    return n;
  };
  const addInst = (prefix: string, ref: PartRef, extra: Partial<Inst> = {}): Inst => {
    const def = partDef(ref, (id) => defs.get(id));
    if (isError(def)) throw new Error(def.error);
    const name = uniqueName(prefix, takenNames);
    takenNames.add(name);
    refs.set(def, ref);
    const inst: Inst = { name, def, ref, col: 0, y: 0, ...extra };
    insts.push(inst);
    instByName.set(name, inst);
    return inst;
  };
  let twoDrivers = '';
  const drive = (k: string, end: string) => {
    const n = net(k);
    if (n.drv !== undefined && n.drv !== end) twoDrivers ||= bitName.get(k) ?? k;
    else n.drv = end;
  };
  const sink = (k: string, end: string) => net(k).sinks.push(end);
  const tmp = () => `t${fresh++}`;

  /** A library gate: inputs from bit keys, its output onto a key. */
  const gate = (lib: string, ins: Record<string, string>, out: string, outPort = 'y', label?: string): Inst => {
    const g = addInst(GATE_PREFIX[lib] ?? lib, { lib }, label ? { label } : {});
    for (const [p, k] of Object.entries(ins)) sink(k, `${g.name}.${p}`);
    drive(out, `${g.name}.${outPort}`);
    return g;
  };
  const invOf = new Map<string, string>();
  const inv = (k: string): string => {
    if (k === '0') return '1';
    if (k === '1') return '0';
    let o = invOf.get(k);
    if (!o) { o = tmp(); invOf.set(k, o); gate('not', { a: k }, o); }
    return o;
  };
  const g2 = (lib: string, a: string, b: string, out = tmp()) => (gate(lib, { a, b }, out), out);

  // ---- ports ----
  const ports: PortDef[] = [];
  const pinName = new Map<string, string>(); // Yosys port → pin name
  const portTaken = new Set<string>();
  const inPorts: { name: string; bits: string[] }[] = [];
  const outPorts: { name: string; bits: string[]; srcAttrs?: Record<string, unknown> }[] = [];
  for (const [pn, p] of Object.entries(m.ports ?? {})) {
    if (p.direction === 'inout') return { error: `port '${pn}' is inout: bidirectional ports are not supported` };
    if (p.bits.length > MAX_WIDTH) return { error: `port '${pn}' is ${p.bits.length} bits wide (pins: at most ${MAX_WIDTH})` };
    const name = uniqueName(identOf(pn), portTaken);
    portTaken.add(name);
    pinName.set(pn, name);
    const bits = p.bits.map(K);
    ports.push({ name, width: bits.length, dir: p.direction === 'input' ? 'in' : 'out' });
    (p.direction === 'input' ? inPorts : outPorts).push({ name, bits });
  }
  for (const p of ports) takenNames.add(p.name); // an instance may not share a pin's name in the netlist's ends

  // Buses that can be wired whole: an input port, or a placed chip's output port (bits in that order).
  const busSrc = new Map<string, string>();
  for (const ip of inPorts) {
    if (ip.bits.length === 1) drive(ip.bits[0], ip.name);
    else busSrc.set(ip.bits.join(','), ip.name);
  }

  // Input splitters, made when some bit of the port is used on its own.
  const splitOf = new Map<string, Inst>();
  const bitSplit = new Map<string, string>(); // bit key → 'split.oK' (first port carrying it)
  for (const ip of inPorts) {
    if (ip.bits.length === 1) continue;
    ip.bits.forEach((k, i) => { if (!bitSplit.has(k) && k !== '0' && k !== '1') bitSplit.set(k, `${ip.name}#${i}`); });
  }
  const splitFor = (portName: string): Inst => {
    let s = splitOf.get(portName);
    if (!s) {
      const ip = inPorts.find((p) => p.name === portName)!;
      s = addInst(`${portName}_bits`, { split: ip.bits.map(() => 1) }, { fixed: 'in' });
      splitOf.set(portName, s);
      busNets.push({ drv: portName, sinks: [`${s.name}.in`], name: portName, bus: true });
    }
    return s;
  };

  /** A multi-bit sink: wired whole when some bus carries exactly these bits, else a merger of single bits (or a constant). */
  const busSink = (bits: string[], end: string, prefix: string, fixed?: 'out') => {
    const src = busSrc.get(bits.join(','));
    if (src !== undefined) {
      let b = busNets.find((n) => n.drv === src);
      if (!b) busNets.push((b = { drv: src, sinks: [], name: busName(src), bus: true }));
      b.sinks.push(end);
      return;
    }
    if (bits.every((k) => k === '0' || k === '1') && bits.length <= 53) {
      const value = bits.reduce((v, k, i) => v + (k === '1' ? 2 ** i : 0), 0);
      const c = addInst('k', { const: { width: bits.length, value } }, fixed ? { fixed } : {});
      busNets.push({ drv: `${c.name}.y`, sinks: [end], bus: true });
      return;
    }
    const mg = addInst(prefix, { merge: bits.map(() => 1) }, fixed ? { fixed } : {});
    bits.forEach((k, i) => sink(k, `${mg.name}.i${i}`));
    busNets.push({ drv: `${mg.name}.out`, sinks: [end], bus: true });
  };
  const busName = (end: string) => (end.includes('.') ? undefined : end);

  // ---- cells ----
  let refused = '';
  const ffLabel = (q: string) => bitName.get(q);
  for (const [cn, c] of cellList) {
    cells[c.type] = (cells[c.type] ?? 0) + 1;
    const con = c.connections ?? {};
    const P = (p: string) => K(con[p]?.[0] ?? 'x');
    const t = c.type;
    if (t === '$_BUF_' || t === '$scopeinfo') continue;
    const simple = SIMPLE[t];
    if (simple) { gate(simple, { a: P('A'), b: P('B') }, P('Y')); continue; }
    switch (t) {
      case '$_NOT_': gate('not', { a: P('A') }, P('Y')); continue;
      case '$_ANDNOT_': gate('and', { a: P('A'), b: inv(P('B')) }, P('Y')); continue;
      case '$_ORNOT_': gate('or', { a: P('A'), b: inv(P('B')) }, P('Y')); continue;
      case '$_MUX_': gate('mux2', { a: P('A'), b: P('B'), s: P('S') }, P('Y')); continue;
      case '$_NMUX_': { const o = tmp(); gate('mux2', { a: P('A'), b: P('B'), s: P('S') }, o); gate('not', { a: o }, P('Y')); continue; }
      case '$_AOI3_': gate('nor', { a: g2('and', P('A'), P('B')), b: P('C') }, P('Y')); continue;
      case '$_OAI3_': gate('nand', { a: g2('or', P('A'), P('B')), b: P('C') }, P('Y')); continue;
      case '$_AOI4_': gate('nor', { a: g2('and', P('A'), P('B')), b: g2('and', P('C'), P('D')) }, P('Y')); continue;
      case '$_OAI4_': gate('nand', { a: g2('or', P('A'), P('B')), b: g2('or', P('C'), P('D')) }, P('Y')); continue;
    }
    const ff = parseFf(t);
    if (ff) {
      if ('refuse' in ff) { refused ||= `${t}: ${ff.refuse}`; continue; }
      const clk = ff.clkNeg ? inv(P(ff.latch ? 'E' : 'C')) : P(ff.latch ? 'E' : 'C');
      storage(ff, clk, P('D'), P('Q'), ff.en ? (ff.en.neg ? inv(P('E')) : P('E')) : undefined, P('R'), ffLabel(P('Q')));
      continue;
    }
    if (t in all && !isBlackbox(all[t])) {
      const sub = all[t];
      const id = ids.get(t)!;
      const def = defs.get(id)!;
      const name = c.hide_name ? `${identOf(t)}` : identOf(cn);
      const ch = addInst(name, { chip: id });
      ch.def = def;
      refs.set(def, { chip: id });
      for (const [pn, p] of Object.entries(sub.ports ?? {})) {
        const pin = pinNameOf(sub, pn);
        const bits = (con[pn] ?? []).map(K);
        const end = `${ch.name}.${pin}`;
        if (p.direction === 'input') {
          if (!bits.length) { warn(`instance ${cn}: input ${pn} left unconnected, read as 0`, c.attributes); bits.push(...p.bits.map(() => '0')); }
          if (bits.length !== p.bits.length) return { error: `instance ${cn}: port ${pn} has ${bits.length} of its ${p.bits.length} bits connected` };
          if (bits.length === 1) sink(bits[0], end);
          else busSink(bits, end, `${pin}_in`);
        } else if (p.direction === 'output') {
          if (!bits.length) continue; // unconnected
          if (bits.length === 1) drive(bits[0], end);
          else {
            const key = bits.join(',');
            if (!busSrc.has(key)) busSrc.set(key, end);
            const sp = addInst(`${ch.name}_${pin}`, { split: bits.map(() => 1) });
            busNets.push({ drv: end, sinks: [`${sp.name}.in`], bus: true });
            bits.forEach((k, i) => { if (k !== '0' && k !== '1') drive(k, `${sp.name}.o${i}`); });
          }
        } else return { error: `instance ${cn}: port ${pn} is inout` };
      }
      continue;
    }
    if (WORD_CELL.test(t)) return { error: `cell ${t} is a word-level cell: synthesize to gates first (synth; abc -g …; or techmap)` };
    return { error: `cell type ${t} has no part here (a vendor primitive or a missing module)` };
  }
  if (refused) return { error: `storage cell ${refused}` };

  /**
   * A flip-flop or latch with any of: inverted clock (done by the caller), enable, async reset / set, sync reset /
   * set. Built from dff, dffe, dff_r, d_latch, d_latch_r and gates; a set is a reset of the inverted value.
   */
  function storage(f: FfSpec, clk: string, d: string, q: string, en: string | undefined, r: string, label?: string) {
    const lbl = label ? { label } : {};
    const active = (neg: boolean) => (neg ? inv(r) : r); // the reset line, active high
    const srst = (x: string) => {
      const s = f.srst!;
      // 0: x AND NOT active; 1: x OR active
      return s.val === 0 ? g2('and', x, s.neg ? r : inv(r)) : g2('or', x, active(s.neg));
    };
    let dd = d;
    if (f.srst && f.srst.ce) dd = srst(dd);
    const needMux = !!en && (!!f.arst || (!!f.srst && !f.srst.ce) || f.latch);
    if (en && needMux) { const o = tmp(); gate('mux2', { a: q, b: dd, s: en }, o); dd = o; }
    if (f.srst && !f.srst.ce) dd = srst(dd);
    if (f.arst) {
      const rstn = f.arst.neg ? r : inv(r);
      if (f.arst.val === 0) storageCell(f.latch, true, dd, clk, rstn, q, lbl);
      else { const qi = tmp(); storageCell(f.latch, true, inv(dd), clk, rstn, qi, lbl); gate('not', { a: qi }, q); }
      return;
    }
    if (en && !needMux) {
      const g = addInst('ff', { lib: 'dffe' }, lbl);
      sink(dd, `${g.name}.d`); sink(en, `${g.name}.en`); sink(clk, `${g.name}.clk`); drive(q, `${g.name}.q`);
      return;
    }
    storageCell(f.latch, false, dd, clk, '', q, lbl);
  }
  function storageCell(latch: boolean | undefined, reset: boolean, d: string, clk: string, rstn: string, q: string, lbl: Partial<Inst>) {
    const g = addInst(latch ? 'lat' : 'ff', { lib: latch ? (reset ? 'd_latch_r' : 'd_latch') : reset ? 'dff_r' : 'dff' }, lbl);
    sink(d, `${g.name}.d`);
    sink(clk, `${g.name}.${latch ? 'e' : 'clk'}`);
    if (reset) sink(rstn, `${g.name}.rst_n`);
    drive(q, `${g.name}.q`);
  }

  // ---- output ports ----
  for (const op of outPorts) {
    if (op.bits.length === 1) sink(op.bits[0], op.name);
    else busSink(op.bits, op.name, `${op.name}_bits`, 'out');
  }

  // Bits used one by one that only an input bus carries: through that port's splitter.
  for (const [k, n] of nets) {
    if (n.drv !== undefined || !n.sinks.length) continue;
    const at = bitSplit.get(k);
    if (at) {
      const [pn, i] = at.split('#');
      n.drv = `${splitFor(pn).name}.o${i}`;
    }
  }
  if (twoDrivers) return { error: `signal ${twoDrivers} has two drivers` };

  // Constants and undriven bits: one tie part per value.
  let undriven = 0;
  const ties = new Map<string, Inst>();
  const tie = (v: '0' | '1') => {
    let t = ties.get(v);
    if (!t) ties.set(v, (t = addInst(v === '1' ? 'one' : 'zero', { const: { width: 1, value: v === '1' ? 1 : 0 } })));
    return t;
  };
  for (const [k, n] of nets) {
    if (n.drv !== undefined || !n.sinks.length) continue;
    if (k !== '0' && k !== '1') undriven++;
    n.drv = `${tie(k === '1' ? '1' : '0').name}.y`;
    n.name = k === '1' ? 'one' : 'zero';
  }
  if (undriven) warn(`${undriven} undriven bit${undriven > 1 ? 's' : ''} read as 0`);
  if (undef) warn(`${undef} x / z bit${undef > 1 ? 's' : ''} read as 0`);

  // Inputs that only clock flip-flops (here or in placed chips) are clock pins.
  const isClockEnd = (end: string) => {
    const i = instByName.get(end.slice(0, end.indexOf('.')));
    return !!i?.def.ports.find((p) => p.name === end.slice(end.indexOf('.') + 1))?.clock;
  };
  for (const ip of inPorts) if (ip.bits.length === 1) {
    const n = nets.get(ip.bits[0]);
    if (n?.sinks.length && n.sinks.every(isClockEnd)) ports.find((p) => p.name === ip.name)!.clock = true;
  }

  // ---- the nets as a list (driver first) ----
  const list: NetB[] = [];
  for (const [k, n] of nets) {
    if (n.drv === undefined || !n.sinks.length) continue;
    list.push({ drv: n.drv, sinks: n.sinks, name: n.name ?? bitName.get(k) });
  }
  // A placed chip's output splitter none of whose bits is read (its bus wired whole) goes.
  const reads = new Set(list.map((n) => n.drv!.slice(0, n.drv!.indexOf('.'))));
  for (let i = insts.length - 1; i >= 0; i--) {
    const s = insts[i];
    if (!('split' in s.ref) || reads.has(s.name)) continue;
    insts.splice(i, 1);
    instByName.delete(s.name);
    for (const b of busNets) b.sinks = b.sinks.filter((e) => e !== `${s.name}.in`);
  }
  list.push(...busNets.filter((b) => b.sinks.length));

  const nl = place(insts, instByName, list, ports);
  const def: ComponentDef = {
    id: ids.get(modName)!, name: modName, category: 'custom', ports, symbol: { kind: 'box', label: modName },
    netlist: () => nl,
  };
  const doc = docFromDef(def, { id: def.id, name: modName, refOf: (d) => refs.get(d) });
  if ('error' in doc) return { error: doc.error };
  return { doc, diags, cells };
}

const pinNameOf = (m: YModule, port: string): string => {
  const taken = new Set<string>();
  for (const pn of Object.keys(m.ports ?? {})) {
    const n = uniqueName(identOf(pn), taken);
    taken.add(n);
    if (pn === port) return n;
  }
  return identOf(port);
};

const SIMPLE: Record<string, string> = {
  $_AND_: 'and', $_NAND_: 'nand', $_OR_: 'or', $_NOR_: 'nor', $_XOR_: 'xor', $_XNOR_: 'xnor',
};
const GATE_PREFIX: Record<string, string> = { not: 'inv', mux2: 'mux' };

interface FfSpec {
  latch?: boolean;
  clkNeg: boolean;
  en?: { neg: boolean };
  arst?: { neg: boolean; val: 0 | 1 };
  /** ce: reset only while enabled ($_SDFFCE_); else the reset wins over the enable. */
  srst?: { neg: boolean; val: 0 | 1; ce: boolean };
}

/** Yosys's fine-grained storage cells, by name ($_DFFE_PN0P_ …), or why one cannot be built. */
export function parseFf(t: string): FfSpec | { refuse: string } | undefined {
  const n = (c: string) => c === 'N';
  let m: RegExpExecArray | null;
  if ((m = /^\$_DFF_([PN])_$/.exec(t))) return { clkNeg: n(m[1]) };
  if ((m = /^\$_DFFE_([PN])([PN])_$/.exec(t))) return { clkNeg: n(m[1]), en: { neg: n(m[2]) } };
  if ((m = /^\$_DFF_([PN])([PN])([01])_$/.exec(t))) return { clkNeg: n(m[1]), arst: { neg: n(m[2]), val: +m[3] as 0 | 1 } };
  if ((m = /^\$_DFFE_([PN])([PN])([01])([PN])_$/.exec(t))) return { clkNeg: n(m[1]), arst: { neg: n(m[2]), val: +m[3] as 0 | 1 }, en: { neg: n(m[4]) } };
  if ((m = /^\$_SDFF_([PN])([PN])([01])_$/.exec(t))) return { clkNeg: n(m[1]), srst: { neg: n(m[2]), val: +m[3] as 0 | 1, ce: false } };
  if ((m = /^\$_SDFF(C?)E_([PN])([PN])([01])([PN])_$/.exec(t))) {
    return { clkNeg: n(m[2]), srst: { neg: n(m[3]), val: +m[4] as 0 | 1, ce: m[1] === 'C' }, en: { neg: n(m[5]) } };
  }
  if ((m = /^\$_DLATCH_([PN])_$/.exec(t))) return { latch: true, clkNeg: n(m[1]) };
  if ((m = /^\$_DLATCH_([PN])([PN])([01])_$/.exec(t))) return { latch: true, clkNeg: n(m[1]), arst: { neg: n(m[2]), val: +m[3] as 0 | 1 } };
  if (/^\$_(DFFSRE?|DLATCHSR|ALDFFE?|SR|FF)_/.test(t)) return { refuse: 'set and reset together, an async load or a global clock: no part for it (synthesize with dfflegalize to plain flip-flops)' };
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Placement: columns by logic depth, rows by where the drivers sit.

const VGAP = 2;

function place(insts: Inst[], byName: Map<string, Inst>, list: NetB[], ports: PortDef[]): import('../sim/types').Netlist {
  const instOf = (end: string) => (end.includes('.') ? byName.get(end.slice(0, end.indexOf('.'))) : undefined);
  // Graph between parts.
  const succ = new Map<Inst, Set<Inst>>(), pred = new Map<Inst, Set<Inst>>();
  for (const i of insts) { succ.set(i, new Set()); pred.set(i, new Set()); }
  for (const n of list) {
    const a = instOf(n.drv!);
    if (!a) continue;
    for (const s of n.sinks) {
      const b = instOf(s);
      if (b && b !== a) { succ.get(a)!.add(b); pred.get(b)!.add(a); }
    }
  }
  // Cut feedback: depth-first from the parts nothing drives (and storage first, so loops break at a flip-flop's input).
  const back = new Set<string>();
  const st = new Map<Inst, 1 | 2>();
  const roots = [...insts].sort((x, y) => pred.get(x)!.size - pred.get(y)!.size || +isStore(y) - +isStore(x));
  for (const r of roots) {
    if (st.has(r)) continue;
    const stack: [Inst, Inst[]][] = [[r, [...succ.get(r)!]]];
    st.set(r, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const nx = top[1].pop();
      if (!nx) { st.set(top[0], 2); stack.pop(); continue; }
      const s = st.get(nx);
      if (s === 1) back.add(`${top[0].name}>${nx.name}`);
      else if (!s) { st.set(nx, 1); stack.push([nx, [...succ.get(nx)!]]); }
    }
  }
  // Longest path, in topological order of the cut graph.
  const indeg = new Map<Inst, number>();
  for (const i of insts) indeg.set(i, [...pred.get(i)!].filter((p) => !back.has(`${p.name}>${i.name}`)).length);
  const queue = insts.filter((i) => indeg.get(i) === 0);
  const depth = new Map<Inst, number>();
  for (const i of insts) depth.set(i, 1);
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi];
    for (const s of succ.get(i)!) {
      if (back.has(`${i.name}>${s.name}`)) continue;
      // Input splitters and constants (nothing drives them) add no depth: their readers can sit in the first column.
      if (i.fixed !== 'in' && pred.get(i)!.size) depth.set(s, Math.max(depth.get(s)!, depth.get(i)! + (s.fixed === 'out' ? 0 : 1)));
      indeg.set(s, indeg.get(s)! - 1);
      if (indeg.get(s) === 0) queue.push(s);
    }
  }
  // Parts with no inputs (constants) sit just before their first reader.
  for (const i of insts) {
    if (pred.get(i)!.size || i.fixed) continue;
    const ss = [...succ.get(i)!].filter((s) => !s.fixed);
    if (ss.length) depth.set(i, Math.max(1, Math.min(...ss.map((s) => depth.get(s)!)) - 1));
  }
  const maxD = Math.max(1, ...insts.filter((i) => !i.fixed).map((i) => depth.get(i)!));
  // Columns: -1 input pins, 0 input splitters, 1..maxD parts, maxD+1 output mergers, maxD+2 output pins.
  for (const i of insts) i.col = i.fixed === 'in' ? 0 : i.fixed === 'out' ? maxD + 1 : depth.get(i)!;
  // Columns that hold something, in order: rank 0 the input pins, the last the output pins.
  const present = [...new Set([-1, ...insts.map((i) => i.col), maxD + 2])].sort((a, b) => a - b);
  for (const i of insts) i.col = present.indexOf(i.col);
  const ncol = present.length;
  const colOf = (end: string) => instOf(end)?.col ?? (ports.find((p) => p.name === end)!.dir === 'in' ? 0 : ncol - 1);

  // Which nets are wired (short, forward, few sinks); the rest are pointers.
  const wired = list.map((n) => {
    const c = colOf(n.drv!);
    return n.sinks.length <= 4 && n.sinks.every((s) => colOf(s) === c + 1);
  });

  // Gap after each column: room for the wired nets' trunks and the pointers on either side.
  const trunks = new Array(ncol).fill(0), tagOut = new Array(ncol).fill(0), tagIn = new Array(ncol).fill(0);
  list.forEach((n, i) => {
    const c = colOf(n.drv!);
    if (wired[i]) { trunks[c]++; return; }
    const w = tagW(n.name ?? 'n00');
    tagOut[c] = Math.max(tagOut[c], w);
    for (const s of n.sinks) { const sc = colOf(s); tagIn[sc] = Math.max(tagIn[sc], w); }
  });
  const colW = new Array(ncol).fill(0);
  for (const i of insts) colW[i.col] = Math.max(colW[i.col], symbolGeom(i.def).w);
  const colX = new Array(ncol).fill(0);
  for (let c = 1; c < ncol; c++) colX[c] = colX[c - 1] + colW[c - 1] + Math.ceil(3 + trunks[c - 1] * 0.5 + tagOut[c - 1] + tagIn[c]);

  // Rows. Input pins and their splitters stacked in port order.
  const pins: Record<string, Vec> = {};
  const geomOf = (i: Inst) => symbolGeom(i.def);
  const endY = (end: string): number | undefined => {
    const i = instOf(end);
    if (!i) return pins[end]?.[1];
    if (!placed.has(i)) return undefined;
    return i.y + geomOf(i).ports[end.slice(end.indexOf('.') + 1)].pos[1];
  };
  const placed = new Set<Inst>();
  let cur = 2;
  for (const p of ports.filter((q) => q.dir === 'in')) {
    const sp = insts.find((i) => i.fixed === 'in' && list.some((n) => n.drv === p.name && n.sinks.includes(`${i.name}.in`)));
    if (sp) {
      const g = geomOf(sp);
      sp.y = cur;
      placed.add(sp);
      pins[p.name] = [colX[0], cur + g.ports.in.pos[1]];
      cur += g.h + VGAP + 1;
    } else {
      pins[p.name] = [colX[0], cur + 1];
      cur += 3;
    }
  }

  // Each column of parts: rows where their inputs come from, kept apart.
  const ins = new Map<Inst, NetB[]>();
  list.forEach((n) => n.sinks.forEach((s) => { const i = instOf(s); if (i) { if (!ins.has(i)) ins.set(i, []); ins.get(i)!.push(n); } }));
  for (let c = 1; c < ncol - 1; c++) {
    const col = insts.filter((i) => i.col === c && !placed.has(i));
    const want = new Map<Inst, number>();
    for (const i of col) {
      const g = geomOf(i);
      const ys: number[] = [];
      for (const n of ins.get(i) ?? []) {
        const y = endY(n.drv!);
        if (y === undefined) continue;
        for (const s of n.sinks) if (instOf(s) === i) ys.push(y - g.ports[s.slice(s.indexOf('.') + 1)].pos[1]);
      }
      want.set(i, ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity);
    }
    col.sort((a, b) => (want.get(a)! - want.get(b)!) || 0);
    let bottom = 0;
    for (const i of col) {
      const g = geomOf(i);
      const w = want.get(i)!;
      const y = Math.max(Number.isFinite(w) ? w : bottom, bottom);
      i.y = snapY(i.def, y);
      placed.add(i);
      bottom = i.y + g.h + VGAP;
    }
  }
  // Output pins: beside what drives them, in port order.
  let ob = 2;
  for (const p of ports.filter((q) => q.dir === 'out')) {
    const n = list.find((x) => x.sinks.includes(p.name));
    const y = n ? endY(n.drv!) : undefined;
    const py = Math.max(Math.round(y ?? ob), ob);
    pins[p.name] = [colX[ncol - 1], py];
    ob = py + 3;
  }

  const instances: InstanceDef[] = insts.map((i) => ({
    name: i.name, def: i.def, at: [colX[i.col], i.y] as [number, number], ...(i.label ? { label: i.label } : {}),
  }));
  const used = new Set<string>();
  const netDefs: NetDef[] = list.map((n, i) => {
    let name = n.name;
    if (name !== undefined) { name = uniqueName(name, used); used.add(name); }
    return { ...(name !== undefined ? { name } : {}), ends: [n.drv!, ...n.sinks], ...(wired[i] ? {} : { tags: true as const }) };
  });
  return { instances, nets: netDefs, pins };
}

const isStore = (i: Inst) => 'lib' in i.ref && /^(dff|dffe|dff_r|d_latch|d_latch_r)$/.test(i.ref.lib);

/** Room a pointer takes beside its port: the stub and the label. */
const tagW = (name: string) => 2 + name.length * 0.62 + 1;

/** A top row so the part's ports land on whole grid units (a box's pins may sit on half units). */
function snapY(def: ComponentDef, y: number): number {
  const ps = Object.values(symbolGeom(def).ports);
  const off = ps.length ? ((ps[0].pos[1] % 1) + 1) % 1 : 0;
  return Math.round(y - off) + off;
}
