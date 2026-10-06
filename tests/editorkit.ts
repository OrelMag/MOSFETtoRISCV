// Builders for sandbox documents in tests: terse pins, parts and wires.

import { compileChip } from '../src/editor/compile';
import { type ChipDoc, type EndRef, type LabelDoc, type PartDoc, type PartRef, type PinDoc, SCHEMA, type Vec, type WireDoc, type Workspace } from '../src/editor/model';
import { partDef } from '../src/editor/parts';

export const pin = (id: string, dir: 'in' | 'out', at: Vec, width = 1, name = id): PinDoc => ({ id, name, dir, width, at });
export const part = (id: string, ref: PartRef, at: Vec, flip?: boolean): PartDoc => ({ id, ref, at, ...(flip ? { flip } : {}) });
export const lbl = (id: string, name: string, at: Vec, face?: LabelDoc['face']): LabelDoc => ({ id, name, at, ...(face ? { face } : {}) });

/** End shorthand: 'x.a' → part port, 'pin:a' → pin, 'lbl:l1' → pointer. */
export function end(s: string | EndRef): EndRef {
  if (typeof s !== 'string') return s;
  if (s.startsWith('pin:')) return { pin: s.slice(4) };
  if (s.startsWith('lbl:')) return { label: s.slice(4) };
  const i = s.indexOf('.');
  return { part: s.slice(0, i), port: s.slice(i + 1) };
}

export const wire = (id: string, a: string | EndRef, b: string | EndRef, pts: Vec[] = [], extra: Partial<WireDoc> = {}): WireDoc =>
  ({ id, a: end(a), b: end(b), pts, ...extra });

export const chip = (id: string, name: string, c: Partial<ChipDoc>): ChipDoc =>
  ({ id, name, pins: [], parts: [], wires: [], labels: [], ...c });

/** Compile with library parts only (no user chips). */
export const compileLib = (doc: ChipDoc) => compileChip(doc, (ref) => partDef(ref, () => undefined));

/**
 * Half adder from the library XOR and AND (both gate symbols: inputs at y = 1, 3, output at
 * (4, 2)). Pin b reaches n.b by a branch at a corner of its first wire, pin a by a branch in
 * the middle of a segment; the carry wire is drawn backwards (from the pin to the gate).
 */
export function halfAdder(id = 'u_ha'): ChipDoc {
  return chip(id, 'HA', {
    pins: [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 6]), pin('s', 'out', [20, 3]), pin('c', 'out', [20, 9])],
    parts: [part('x', { lib: 'xor' }, [8, 1]), part('n', { lib: 'and' }, [8, 7])],
    wires: [
      wire('w1', 'pin:a', 'x.a'),
      wire('w2', { wire: 'w1', at: [4, 2] }, 'n.a', [[4, 8]]),
      wire('w3', 'pin:b', 'x.b', [[6, 6], [6, 4]]),
      wire('w4', { wire: 'w3', at: [6, 6] }, 'n.b', [[6, 10]]),
      wire('w5', 'x.y', 'pin:s'),
      wire('w6', 'pin:c', 'n.y'),
    ],
  });
}

/** A wire from `from` to each of `to` (ids `<id>_1`, `<id>_2`, …): how a user fans a signal out. */
export const fan = (id: string, from: string | EndRef, ...to: (string | EndRef)[]): WireDoc[] =>
  to.map((t, i) => wire(`${id}_${i + 1}`, from, t));

/** Workspace holding these chips (the first one open). */
export const workspace = (...chips: ChipDoc[]): Workspace =>
  ({ schema: SCHEMA, chips: Object.fromEntries(chips.map((c) => [c.id, c])), open: [chips[0].id] });
