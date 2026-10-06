// Wide gates: n-bit bitwise operators and reduction trees.

import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { define, merger, ones, splitter } from './define';
import { AND, OR, XOR } from './gates';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

function memo<A extends unknown[]>(f: (...a: A) => ComponentDef): (...a: A) => ComponentDef {
  const cache = new Map<string, ComponentDef>();
  return (...a: A) => {
    const k = JSON.stringify(a);
    let d = cache.get(k);
    if (!d) cache.set(k, (d = f(...a)));
    return d;
  };
}


/** n copies of a 2-input gate working bit by bit. */
export const bitwise = memo((op: 'and' | 'or' | 'xor', n: number): ComponentDef => {
  const g = op === 'and' ? AND : op === 'or' ? OR : XOR;
  const P = 6;
  const instances: InstanceDef[] = [
    { name: 'sa', def: splitter(ones(n), P), at: [4, 0] },
    { name: 'sb', def: splitter(ones(n), P), at: [7, 2] },
    { name: 'my', def: merger(ones(n), P), at: [17, 1] },
  ];
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'sa.in'] }, { name: 'b', ends: ['b', 'sb.in'] }, { name: 'y', ends: ['my.out', 'y'] },
  ];
  for (let i = 0; i < n; i++) {
    instances.push({ name: `g${i}`, def: g, at: [10, 2 + P * i] });
    nets.push({ ends: [`sa.o${i}`, `g${i}.a`] }, { ends: [`sb.o${i}`, `g${i}.b`] }, { ends: [`g${i}.y`, `my.i${i}`] });
  }
  const f = op === 'and' ? (a: number, b: number) => (a & b) >>> 0 : op === 'or' ? (a: number, b: number) => (a | b) >>> 0 : (a: number, b: number) => (a ^ b) >>> 0;
  return define({
    id: `${op}x${n}`, name: `${n}-bit ${op.toUpperCase()}`, category: 'gate',
    summary: `${n} ${op.toUpperCase()} gates side by side: bit i of the result depends only on bit i of the inputs.`,
    ports: [bus('a', n, 'in'), bus('b', n, 'in'), bus('y', n, 'out')],
    symbol: { kind: 'box', label: `${op.toUpperCase()}${n}` },
    spec: ([a, b]) => [f(a, b)],
    netlist: () => ({ pins: { a: [1, (P * n) / 2], b: [1, 2 + (P * n) / 2], y: [21, 1 + (P * n) / 2] }, instances, nets }),
  });
});

/** Balanced tree of 2-input gates reducing n inputs i0..i(n-1) to y. */
function gateTree(gate: ComponentDef, n: number, id: string, name: string, spec: (v: number[]) => number[]): ComponentDef {
  const ins = Array.from({ length: n }, (_, i) => bit(`i${i}`, 'in'));
  const instances: InstanceDef[] = [];
  const nets: NetDef[] = [];
  let level: string[] = ins.map((p) => p.name);
  const ypos = new Map<string, number>(level.map((s, i) => [s, 2 + 2 * i]));
  let col = 0, k = 0;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      const nm = `g${k++}`;
      const yc = (ypos.get(level[i])! + ypos.get(level[i + 1])!) / 2;
      instances.push({ name: nm, def: gate, at: [5 + col * 8, yc - 2] });
      nets.push({ ends: [level[i], `${nm}.a`] }, { ends: [level[i + 1], `${nm}.b`] });
      next.push(`${nm}.y`);
      ypos.set(`${nm}.y`, yc);
    }
    if (level.length % 2) next.push(level[level.length - 1]);
    level = next;
    col++;
  }
  nets.push({ ends: [level[0], 'y'] });
  const pins: Record<string, [number, number]> = { y: [5 + col * 8 + 2, ypos.get(level[0])!] };
  ins.forEach((p, i) => (pins[p.name] = [1, 2 + 2 * i]));
  return define({
    id, name, category: 'gate', summary: `A tree of ${n - 1} two-input gates, ${col} levels deep.`,
    ports: [...ins, bit('y', 'out')], symbol: { kind: gate.symbol.kind }, spec,
    netlist: () => ({ pins, instances, nets }),
  });
}

export const orN = memo((n: number): ComponentDef =>
  gateTree(OR, n, `or${n}`, `${n}-input OR`, (v) => [v.some((x) => x === 1) ? 1 : 0]));

