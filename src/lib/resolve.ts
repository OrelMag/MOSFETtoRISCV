// Look up any component by id, including parameterized ones (rca8, ram16x8, …), and the
// parameter families shown in the workbench.

import type { ComponentDef } from '../sim/types';
import { addSub, andN, busMux2, decoder, incrementer, muxTree, rca } from './combinational';
import { registry } from './define';
import { ram } from './memory';
import { counter, register } from './sequential';

const log2 = (n: number) => Math.round(Math.log2(n));

const patterns: [RegExp, (m: RegExpMatchArray) => ComponentDef][] = [
  [/^rca(\d+)$/, (m) => rca(+m[1])],
  [/^addsub(\d+)$/, (m) => addSub(+m[1])],
  [/^inc(\d+)$/, (m) => incrementer(+m[1])],
  [/^and(\d+)$/, (m) => andN(+m[1])],
  [/^dec(\d)(e?)(?:_p(\d+))?$/, (m) => decoder(+m[1], m[2] === 'e', m[3] ? +m[3] : 0)],
  [/^mux2x(\d+)$/, (m) => busMux2(+m[1])],
  [/^mux2tree(\d+)$/, (m) => muxTree(1, +m[1])],
  [/^mux(\d+)x(\d+)(?:_p(\d+))?$/, (m) => muxTree(log2(+m[1]), +m[2], m[3] ? +m[3] : 2)],
  [/^reg(\d+)$/, (m) => register(+m[1])],
  [/^counter(\d+)$/, (m) => counter(+m[1])],
  [/^ram(\d+)x(\d+)$/, (m) => ram(log2(+m[1]), +m[2])],
];

export function resolveComponent(id: string): ComponentDef | undefined {
  const hit = registry.get(id);
  if (hit) return hit;
  for (const [re, make] of patterns) {
    const m = id.match(re);
    if (m) {
      try {
        return make(m);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export interface Param {
  name: string;
  values: number[];
  initial: number;
  label?: (v: number) => string;
}

export interface Family {
  id: string;
  name: string;
  category: string;
  params: Param[];
  make: (p: Record<string, number>) => ComponentDef;
}

export const families: Family[] = [
  { id: 'rca', name: 'Ripple-carry adder', category: 'arithmetic', params: [{ name: 'bits', values: [1, 2, 4, 8, 16], initial: 4 }], make: (p) => rca(p.bits) },
  { id: 'addsub', name: 'Adder / subtractor', category: 'arithmetic', params: [{ name: 'bits', values: [2, 4, 8, 16], initial: 8 }], make: (p) => addSub(p.bits) },
  { id: 'inc', name: 'Incrementer', category: 'arithmetic', params: [{ name: 'bits', values: [2, 4, 8, 16], initial: 4 }], make: (p) => incrementer(p.bits) },
  { id: 'and', name: 'Wide AND', category: 'gate', params: [{ name: 'inputs', values: [3, 4, 5, 6, 8], initial: 4 }], make: (p) => andN(p.inputs) },
  {
    id: 'dec', name: 'Decoder', category: 'routing',
    params: [{ name: 'bits', values: [1, 2, 3, 4], initial: 2 }, { name: 'enable', values: [0, 1], initial: 0, label: (v) => (v ? 'with enable' : 'no enable') }],
    make: (p) => decoder(p.bits, p.enable === 1),
  },
  { id: 'mux2x', name: 'Bus multiplexer 2:1', category: 'routing', params: [{ name: 'bits', values: [1, 2, 4, 8], initial: 4 }], make: (p) => busMux2(p.bits) },
  {
    id: 'mux', name: 'Multiplexer tree', category: 'routing',
    params: [{ name: 'inputs', values: [2, 4, 8, 16], initial: 4 }, { name: 'bits', values: [1, 2, 4, 8], initial: 1 }],
    make: (p) => muxTree(log2(p.inputs), p.bits),
  },
  { id: 'reg', name: 'Register', category: 'sequential', params: [{ name: 'bits', values: [1, 2, 4, 8, 16], initial: 4 }], make: (p) => register(p.bits) },
  { id: 'counter', name: 'Counter', category: 'sequential', params: [{ name: 'bits', values: [2, 3, 4, 8], initial: 4 }], make: (p) => counter(p.bits) },
  {
    id: 'ram', name: 'Memory (RAM)', category: 'memory',
    params: [{ name: 'words', values: [4, 8, 16, 32, 64], initial: 16 }, { name: 'bits', values: [4, 8, 16], initial: 8 }],
    make: (p) => ram(log2(p.words), p.bits),
  },
];
