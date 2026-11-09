// A synthesized gate netlist traced back to the Verilog lines it came from (DOM-free).
//
// Yosys's `abc` pass rebuilds the logic and drops every cell's `src` attribute (checked: after abc the cells carry none, only
// the module, the ports and the wires do). What survives is the wires marked `(* keep *)`: ABC must leave them as nets, and
// write_json gives each its `src`, the line that declares it. A gate then belongs to the line of the kept wire it feeds, the
// nearest one downstream (its cone), which is the statement it was made for. A gate no kept wire is downstream of has no line.
// So the source must be written one statement per kept wire, which is also what makes the path readable.

/** A NAND/NOT netlist with Yosys's numbering replaced by names, in topological order. */
export interface GateNet {
  module: string;
  /** Ports in declaration order; `nets` is one net name per bit, least significant first. */
  ports: { name: string; dir: 'in' | 'out'; nets: string[] }[];
  /** Cells in topological order: `g<i>`, its input nets, the net it drives (its own name). */
  cells: { name: string; type: 'NAND' | 'NOT'; in: string[] }[];
  /** Kept wires with the line that declares them: one entry per bit (`c1`, `p[0]`). */
  kept: { name: string; net: string; line: number }[];
}

type YBit = number | string;
interface YModule {
  ports?: Record<string, { direction: string; bits: YBit[] }>;
  cells?: Record<string, { type: string; connections?: Record<string, YBit[]> }>;
  netnames?: Record<string, { bits: YBit[]; attributes?: Record<string, unknown> }>;
}

const lineOf = (src: unknown): number | undefined => {
  const m = /^[^|:]+:(\d+)/.exec(typeof src === 'string' ? src : '');
  return m ? Number(m[1]) : undefined;
};

/** Yosys's write_json (NAND gate set: $_NAND_ and $_NOT_ only) → a GateNet. Throws on anything else. */
export function gateNetOf(json: unknown, top: string): GateNet {
  const mod = (json as { modules: Record<string, YModule> }).modules[top];
  if (!mod) throw new Error(`no module ${top}`);
  const cellsIn = Object.values(mod.cells ?? {});
  const driver = new Map<YBit, { type: 'NAND' | 'NOT'; in: YBit[] }>();
  for (const c of cellsIn) {
    if (c.type !== '$_NAND_' && c.type !== '$_NOT_') throw new Error(`cell type ${c.type} is not NAND / NOT`);
    const k = c.connections!;
    driver.set(k.Y[0], c.type === '$_NAND_' ? { type: 'NAND', in: [k.A[0], k.B[0]] } : { type: 'NOT', in: [k.A[0]] });
  }
  // Input bits get names first.
  const name = new Map<YBit, string>();
  const ports: GateNet['ports'] = [];
  for (const [pn, p] of Object.entries(mod.ports ?? {})) {
    const dir = p.direction === 'input' ? 'in' : 'out';
    ports.push({ name: pn, dir, nets: p.bits.map((b, i) => {
      if (typeof b === 'string') throw new Error(`port ${pn} bit ${i} is the constant ${b}`);
      const n = p.bits.length === 1 ? pn : `${pn}${i}`;
      if (dir === 'in') name.set(b, n);
      return String(b);
    }) });
  }
  // Level of every driven bit: the longest chain of gates from an input.
  const level = new Map<YBit, number>();
  const lvl = (b: YBit): number => {
    if (name.has(b)) return 0;
    const known = level.get(b);
    if (known !== undefined) return known;
    const d = driver.get(b);
    if (!d) throw new Error(`bit ${b} has no driver`);
    level.set(b, 0); // a loop would otherwise recurse for ever
    const l = 1 + Math.max(...d.in.map(lvl));
    level.set(b, l);
    return l;
  };
  const order = [...driver.keys()].map((b, i) => ({ b, i, l: lvl(b) })).sort((x, y) => x.l - y.l || x.i - y.i);
  order.forEach(({ b }, i) => name.set(b, `g${i}`));
  const cells = order.map(({ b }, i) => ({ name: `g${i}`, ...(({ type, in: ins }) => ({ type, in: ins.map((x) => name.get(x)!) }))(driver.get(b)!) }));
  // Ports now name their nets; a kept wire's bits are named by the vector's own name.
  for (const p of ports) {
    const bits = (mod.ports![p.name].bits as number[]);
    p.nets = bits.map((b) => name.get(b)!);
  }
  const kept: GateNet['kept'] = [];
  for (const [nn, n] of Object.entries(mod.netnames ?? {})) {
    if (!n.attributes || !('keep' in n.attributes)) continue;
    const line = lineOf(n.attributes.src);
    if (line === undefined) continue;
    n.bits.forEach((b, i) => {
      const net = name.get(b);
      if (net !== undefined) kept.push({ name: n.bits.length === 1 ? nn : `${nn}[${i}]`, net, line });
    });
  }
  return { module: top, ports, cells, kept };
}

/** The Verilog lines each cell comes from (sorted): the kept wire it drives, else the lines of the cells that read it. */
export function cellLines(net: GateNet): Record<string, number[]> {
  const keptLine = new Map<string, number>();
  for (const k of net.kept) if (!keptLine.has(k.net)) keptLine.set(k.net, k.line);
  const readers = new Map<string, string[]>();
  for (const c of net.cells) for (const i of c.in) (readers.get(i) ?? readers.set(i, []).get(i)!).push(c.name);
  const lines: Record<string, Set<number>> = {};
  for (let i = net.cells.length - 1; i >= 0; i--) {
    const c = net.cells[i];
    const own = keptLine.get(c.name);
    const s = new Set<number>();
    if (own !== undefined) s.add(own);
    else for (const r of readers.get(c.name) ?? []) for (const l of lines[r]) s.add(l);
    lines[c.name] = s;
  }
  return Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
}

export interface CriticalPath {
  /** Cells from the input side to the output side. */
  cells: string[];
  /** The input net it starts from and the output bit it ends at (`port[i]` / `port`). */
  from: string;
  to: string;
  /** NAND delays: one per cell. */
  depth: number;
  /** The Verilog lines the path comes from, in the order the path first meets them. */
  lines: number[];
}

/**
 * The longest input → output path, one delay per cell (the NAND-only library's unit delay, which sim/stats logicDepth also counts).
 * Ties go to the first output bit, then to the first input of each cell, so the answer is the same every run.
 */
export function criticalPathOf(net: GateNet): CriticalPath {
  const byName = new Map(net.cells.map((c) => [c.name, c]));
  const depth = new Map<string, number>();
  const via = new Map<string, string>();
  for (const c of net.cells) {
    let best = 0, from = '';
    for (const i of c.in) {
      const d = depth.get(i) ?? 0;
      if (from === '' || d > best) { best = d; from = i; }
    }
    depth.set(c.name, best + 1);
    via.set(c.name, from);
  }
  let end = '', to = '', top = -1;
  for (const p of net.ports) {
    if (p.dir !== 'out') continue;
    p.nets.forEach((n, i) => {
      const d = depth.get(n) ?? 0;
      if (d > top) { top = d; end = n; to = p.nets.length === 1 ? p.name : `${p.name}[${i}]`; }
    });
  }
  const cells: string[] = [];
  let cur = end;
  while (byName.has(cur)) { cells.unshift(cur); cur = via.get(cur)!; }
  const per = cellLines(net);
  const lines: number[] = [];
  for (const c of cells) for (const l of per[c]) if (!lines.includes(l)) lines.push(l);
  return { cells, from: cur, to, depth: top, lines };
}
