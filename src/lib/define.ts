// Helpers for writing the component library tersely.

import type { Category, ComponentDef, PortDef, SymbolSpec } from '../sim/types';

/** Every named component, for the workbench / library browser. */
export const registry = new Map<string, ComponentDef>();

export function define(d: ComponentDef): ComponentDef {
  if (registry.has(d.id) && registry.get(d.id) !== d) throw new Error(`duplicate component id '${d.id}'`);
  registry.set(d.id, d);
  return d;
}

type PortSpec = number | Omit<PortDef, 'name' | 'dir'>;

/** Build a port list: inputs first (in order), then outputs. */
export function io(ins: Record<string, PortSpec>, outs: Record<string, PortSpec>): PortDef[] {
  const mk = (dir: 'in' | 'out') => ([name, s]: [string, PortSpec]): PortDef =>
    typeof s === 'number' ? { name, width: s, dir } : { name, dir, ...s };
  return [...Object.entries(ins).map(mk('in')), ...Object.entries(outs).map(mk('out'))];
}

export function box(label?: string, w?: number, h?: number): SymbolSpec {
  return { kind: 'box', label, w, h };
}

export const cat = (c: Category) => c;

// ---- splitters and mergers ------------------------------------------------------------
// They are pure wiring (prim 'alias'): no delay, no transistors.

const splitCache = new Map<string, ComponentDef>();

/** Bus of sum(widths) bits → outputs o0, o1, … (o0 holds the least-significant bits). */
export function splitter(widths: number[], pitch = 2): ComponentDef {
  const id = `split_${widths.join('_')}${pitch !== 2 ? `_p${pitch}` : ''}`;
  let d = splitCache.get(id);
  if (d) return d;
  const total = widths.reduce((a, b) => a + b, 0);
  const alias: [string, number, string, number][] = [];
  let bit = 0;
  widths.forEach((w, i) => {
    for (let j = 0; j < w; j++) alias.push(['in', bit++, `o${i}`, j]);
  });
  d = {
    id, name: `Split ${total}→${widths.join('+')}`, category: 'plumbing',
    summary: 'Fans a bus out into smaller buses or single wires. Pure wiring.',
    ports: [{ name: 'in', width: total, dir: 'in' }, ...widths.map((w, i): PortDef => ({ name: `o${i}`, width: w, dir: 'out' }))],
    symbol: { kind: 'split', pitch }, prim: 'alias', alias,
  };
  splitCache.set(id, d);
  return d;
}

/** Inputs i0, i1, … (i0 = least-significant) → one bus 'out'. */
export function merger(widths: number[], pitch = 2): ComponentDef {
  const id = `merge_${widths.join('_')}${pitch !== 2 ? `_p${pitch}` : ''}`;
  let d = splitCache.get(id);
  if (d) return d;
  const total = widths.reduce((a, b) => a + b, 0);
  const alias: [string, number, string, number][] = [];
  let bit = 0;
  widths.forEach((w, i) => {
    for (let j = 0; j < w; j++) alias.push([`i${i}`, j, 'out', bit++]);
  });
  d = {
    id, name: `Merge ${widths.join('+')}→${total}`, category: 'plumbing',
    summary: 'Bundles wires or small buses into one bus. Pure wiring.',
    ports: [...widths.map((w, i): PortDef => ({ name: `i${i}`, width: w, dir: 'in' })), { name: 'out', width: total, dir: 'out' }],
    symbol: { kind: 'merge', pitch }, prim: 'alias', alias,
  };
  splitCache.set(id, d);
  return d;
}

export const ones = (n: number) => Array.from({ length: n }, () => 1);
