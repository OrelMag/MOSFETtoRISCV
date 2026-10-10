// Flattening turns a hierarchical design into a flat list of primitive leaves connected by
// 1-bit nets, while keeping the hierarchy as a tree of HierNodes. Every node remembers which
// flat nets its ports and internal wires map to, so any level can be viewed live from a
// single simulation. That is what makes every box transparent at no extra cost.

import {
  type ComponentDef, type HierLeafKind, inPorts, isSwitchPrim, netlistOf, outPorts, parseEnd,
} from './types';

export interface HierNode {
  /** Instance names from the root ('' for the root itself). */
  path: string[];
  name: string;
  def: ComponentDef;
  parent: HierNode | null;
  /** Flat net ids for each bit of each port. */
  ports: Record<string, number[]>;
  /** True when the node's netlist was expanded in this simulation. */
  expanded: boolean;
  /** Flat net ids per NetDef index (only when expanded). */
  nets?: number[][];
  children?: Map<string, HierNode>;
  /** Index into FlatDesign.leaves when this node is a leaf of the simulation. */
  leafIndex?: number;
}

export interface FlatLeaf {
  kind: HierLeafKind;
  def: ComponentDef;
  node: HierNode;
  inputs: number[][];
  outputs: number[][];
  /**
   * For switch-level primitives: the nets of its ports in port order (a transistor's g, a, b; a
   * resistor's two ends; the node of a rail or a capacitor).
   */
  terminals?: number[];
}

export interface FlatDesign {
  root: HierNode;
  netCount: number;
  leaves: FlatLeaf[];
  powerOn: Map<number, 0 | 1>;
  /** Nets marked `cap`, or with a capacitor on them (switch level): they hold their charge when undriven. */
  caps: Set<number>;
}

export type FlattenMode = 'gate' | 'switch';

export interface FlattenOptions {
  mode?: FlattenMode;
  /** Return false to keep a component with a behaviour as a leaf (mixed-level simulation). */
  expand?: (def: ComponentDef, node: HierNode) => boolean;
}

class UnionFind {
  parent: number[] = [];
  make(): number {
    const id = this.parent.length;
    this.parent.push(id);
    return id;
  }
  find(x: number): number {
    const p = this.parent;
    while (p[x] !== x) {
      p[x] = p[p[x]];
      x = p[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

function leafKind(def: ComponentDef, mode: FlattenMode): HierLeafKind | null {
  if (mode === 'gate') {
    if (def.prim === 'nand') return 'nand';
    if (isSwitchPrim(def)) throw new Error(`${def.id}: ${def.prim === 'res' || def.prim === 'cap' ? 'resistors and capacitors' : 'transistors'} can only be simulated at switch level`);
    return null;
  }
  return isSwitchPrim(def) ? def.prim as HierLeafKind : null;
}

/**
 * Raw bits of a power-on hint: a net or port of `node`, or a dotted path through its instances
 * ('w3.ff0.ff.slave.sr.q'), so a component can seed storage deep inside its children (a RAM's
 * initial contents). Undefined: no such net; null: the path ends inside a leaf of this
 * simulation (an unexpanded child), where there is nothing to seed.
 */
export function hintBits(node: HierNode, name: string): number[] | null | undefined {
  const path = name.split('.');
  const net = path.pop()!;
  let n = node;
  for (const seg of path) {
    if (!n.expanded) return null;
    const c = n.children?.get(seg);
    if (!c) return undefined;
    n = c;
  }
  if (n.expanded) {
    const ni = netlistOf(n.def)!.nets.findIndex((q) => q.name === net);
    if (ni >= 0) return n.nets![ni];
  }
  return n.ports[net] ?? (n.expanded || n === node ? undefined : null);
}

export function flatten(rootDef: ComponentDef, opts: FlattenOptions = {}): FlatDesign {
  const mode = opts.mode ?? 'gate';
  const uf = new UnionFind();
  const leaves: FlatLeaf[] = [];
  const hints: [number, 0 | 1][] = [];
  const capsRaw: number[] = [];

  const alloc = (w: number): number[] => Array.from({ length: w }, () => uf.make());

  const root: HierNode = {
    path: [], name: '', def: rootDef, parent: null, ports: {}, expanded: false,
  };
  for (const p of rootDef.ports) root.ports[p.name] = alloc(p.width);

  const visit = (node: HierNode): void => {
    const def = node.def;

    if (def.prim === 'alias') {
      for (const [pa, ba, pb, bb] of def.alias ?? []) uf.union(node.ports[pa][ba], node.ports[pb][bb]);
      return;
    }

    const kind = leafKind(def, mode);
    const nl = netlistOf(def);
    const canExpand = !!nl && (mode === 'switch' || nl.level !== 'switch');
    const wantExpand = canExpand && (kind === null) && (!def.behavior || (opts.expand ? opts.expand(def, node) : !def.preferBehavior));

    if (!wantExpand) {
      if (kind === null && !def.behavior) {
        throw new Error(`${def.id}: cannot be simulated in ${mode} mode (no structure or behaviour)`);
      }
      node.leafIndex = leaves.length;
      leaves.push({
        kind: kind ?? 'behavior',
        def,
        node,
        inputs: inPorts(def).map((p) => node.ports[p.name]),
        outputs: outPorts(def).map((p) => node.ports[p.name]),
        terminals: kind && kind !== 'nand' ? def.ports.map((p) => node.ports[p.name][0]) : undefined,
      });
      return;
    }

    const netlist = nl!;
    node.expanded = true;
    node.nets = [];
    node.children = new Map();
    const instByName = new Map(netlist.instances.map((i) => [i.name, i]));
    const childPorts = new Map<string, Record<string, number[]>>();

    netlist.nets.forEach((net, ni) => {
      let width = -1;
      const resolved = net.ends.map((end) => {
        const { inst, port } = parseEnd(end);
        let w: number;
        if (inst === null) {
          const p = def.ports.find((q) => q.name === port);
          if (!p) throw new Error(`${def.id}: net ${net.name ?? ni} references unknown port '${port}'`);
          w = p.width;
        } else {
          const id = instByName.get(inst);
          if (!id) throw new Error(`${def.id}: net ${net.name ?? ni} references unknown instance '${inst}'`);
          const p = id.def.ports.find((q) => q.name === port);
          if (!p) throw new Error(`${def.id}: instance ${inst} (${id.def.id}) has no port '${port}'`);
          w = p.width;
        }
        if (width < 0) width = w;
        else if (w !== width) {
          throw new Error(`${def.id}: width mismatch on net ${net.name ?? ni} at '${end}' (${w} vs ${width})`);
        }
        return { inst, port };
      });
      const bits = alloc(width);
      node.nets!.push(bits);
      if (net.cap) capsRaw.push(...bits);
      for (const { inst, port } of resolved) {
        if (inst === null) {
          bits.forEach((b, i) => uf.union(b, node.ports[port][i]));
        } else {
          let cp = childPorts.get(inst);
          if (!cp) childPorts.set(inst, (cp = {}));
          if (cp[port]) bits.forEach((b, i) => uf.union(b, cp![port][i]));
          else cp[port] = bits;
        }
      }
    });

    for (const inst of netlist.instances) {
      const cp = childPorts.get(inst.name) ?? {};
      const ports: Record<string, number[]> = {};
      for (const p of inst.def.ports) ports[p.name] = cp[p.name] ?? alloc(p.width);
      const child: HierNode = {
        path: [...node.path, inst.name], name: inst.name, def: inst.def, parent: node, ports, expanded: false,
      };
      node.children.set(inst.name, child);
      visit(child);
    }

    if (def.powerOn) {
      for (const [name, v] of Object.entries(def.powerOn)) {
        const bits = hintBits(node, name);
        if (bits === undefined) throw new Error(`${def.id}: powerOn hint for unknown net '${name}'`);
        if (bits) for (const b of bits) hints.push([b, v]);
      }
    }
  };

  visit(root);

  // Compress union-find roots into dense ids and rewrite every reference.
  const dense = new Map<number, number>();
  const id = (raw: number): number => {
    const r = uf.find(raw);
    let d = dense.get(r);
    if (d === undefined) dense.set(r, (d = dense.size));
    return d;
  };
  const remap = (a: number[]): number[] => a.map(id);
  const walk = (n: HierNode): void => {
    for (const k of Object.keys(n.ports)) n.ports[k] = remap(n.ports[k]);
    if (n.nets) n.nets = n.nets.map(remap);
    n.children?.forEach(walk);
  };
  walk(root);
  for (const l of leaves) {
    l.inputs = l.inputs.map(remap);
    l.outputs = l.outputs.map(remap);
    if (l.terminals) l.terminals = remap(l.terminals);
  }
  const powerOn = new Map<number, 0 | 1>();
  for (const [raw, v] of hints) powerOn.set(id(raw), v);

  const caps = new Set(capsRaw.map(id));
  // a capacitor part marks its node, exactly like a `cap` net
  for (const l of leaves) if (l.kind === 'cap') caps.add(l.terminals![0]);
  return { root, netCount: dense.size, leaves, powerOn, caps };
}

export function findNode(root: HierNode, path: readonly string[]): HierNode | null {
  let n: HierNode | undefined = root;
  for (const name of path) {
    n = n.children?.get(name);
    if (!n) return null;
  }
  return n;
}
