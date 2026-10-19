// A Custom ISA table's decoder in gates (the encoding designer's "Open the decoder"): the word split
// into bits, an inverter for each bit some pattern fixes to 0, one AND per instruction over its fixed
// bits, and the NOT of every more specific pattern that overlaps it (the most specific match wins),
// one match line per instruction and `valid` (any of them). It is the plain decoder isa/design.ts
// prices: tests/isa-decoder.test.ts holds stats() to that estimate and every output to the table's
// own match() on every word. Not registered: it is built for a table and opened in the sandbox.

import { analyze } from '../isa/design';
import { tableOf, type IsaDoc } from '../isa/table';
import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { andN } from './combinational';
import { ones, splitter } from './define';
import { AND, NOT, OR } from './gates';
import { TIE1 } from './transistors';
import { orN } from './wide';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, dir, width: 1 });

/** Output names: the mnemonics as identifiers, unique (a second ADD is ADD_2). */
export function matchNames(doc: IsaDoc): string[] {
  const seen = new Map<string, number>();
  return doc.instrs.map((r) => {
    let n = r.mnemonic.replace(/[^\w]/g, '_').replace(/^(\d)/, '_$1') || 'instr';
    if (n === 'w' || n === 'valid') n = `${n}_`;
    const k = (seen.get(n.toLowerCase()) ?? 0) + 1;
    seen.set(n.toLowerCase(), k);
    return k > 1 ? `${n}_${k}` : n;
  });
}

const cache = new WeakMap<IsaDoc, ComponentDef>();

export function isaDecoder(doc: IsaDoc): ComponentDef {
  const hit = cache.get(doc);
  if (hit) return hit;
  const W = doc.wordBits;
  const rows = tableOf(doc).compiled;
  const a = analyze(doc);
  const names = matchNames(doc);
  const b = new Builder(10, 14);
  b.pins('w');
  const sw = b.op(splitter(ones(W)), ['w']);
  b.next();
  // Complement rails only where a pattern needs a 0.
  const neg: string[] = [];
  for (let i = 0; i < W; i++) {
    b.name(`${sw}.o${i}`, `w${i}`, true);
    if (rows.some((r) => (r.mask >>> i) & 1 && !((r.value >>> i) & 1))) neg[i] = b.name(b.op1(NOT, [`${sw}.o${i}`]), `w${i}′`, true);
  }
  b.next();
  const andOf = (drivers: string[], label: string) =>
    drivers.length === 0 ? b.op1(TIE1, []) : drivers.length === 1 ? drivers[0] : b.op1(drivers.length === 2 ? AND : andN(drivers.length), drivers, label);
  const lits = (i: number) => Array.from({ length: W }, (_, k) => W - 1 - k).filter((k) => (rows[i].mask >>> k) & 1)
    .map((k) => ((rows[i].value >>> k) & 1 ? `${sw}.o${k}` : neg[k]));
  // Rows another row overlaps with more fixed bits: their raw match, inverted, keeps the general one off.
  const excl = rows.map((_, i) => a.shadows.filter((s) => s.general === i).map((s) => s.special));
  const inverted = [...new Set(excl.flat())].sort((x, y) => x - y);
  // Column 1: every row's match over its fixed bits (final already when nothing shadows it).
  const raw = rows.map((_, i) => b.name(andOf(lits(i), names[i]), excl[i].length ? `${names[i]} (raw)` : names[i], true));
  b.next();
  const notRaw = new Map<number, string>();
  for (const j of inverted) notRaw.set(j, b.op1(NOT, [raw[j]], `not ${names[j]}`));
  if (inverted.length) b.next();
  const match = rows.map((_, i) => (excl[i].length ? b.op1(excl[i].length + 1 === 2 ? AND : andN(excl[i].length + 1), [raw[i], ...excl[i].map((j) => notRaw.get(j)!)], names[i]) : raw[i]));
  b.next();
  const valid = rows.length === 0 ? b.op1(TIE1, []) : rows.length === 1 ? match[0] : b.op1(rows.length === 2 ? OR : orN(rows.length), match, 'valid');
  match.forEach((m, i) => b.wire(m, names[i]));
  b.wire(valid, 'valid');

  // Output pins down the right edge, each level with the part driving it when there is one.
  const R = b.right;
  const yOf = (drv: string, k: number) => {
    const inst = b.instances.find((x) => drv.startsWith(`${x.name}.`));
    return inst ? inst.at![1] + Math.round(symbolGeom(inst.def).h / 2) : 2 + 3 * k;
  };
  const used = new Set<number>();
  const pinY = (drv: string, k: number) => {
    let y = yOf(drv, k);
    while (used.has(y)) y += 2;
    used.add(y);
    return y;
  };
  const pins: Record<string, [number, number]> = { w: [0, 6] };
  names.forEach((n, i) => { pins[n] = [R, pinY(match[i], i)]; });
  pins.valid = [R, pinY(valid, names.length)];
  const def: ComponentDef = {
    id: `isadec_${doc.id}`, name: `${doc.name} decoder`, category: 'gate',
    summary: `Decodes ${W}-bit words of ${doc.name}: one AND per instruction over its fixed bits (${a.decoder.ands} NANDs), ${a.decoder.nots} inverters, valid = any match.`,
    ports: [{ name: 'w', dir: 'in', width: W }, ...names.map((n) => bit(n, 'out')), bit('valid', 'out')],
    symbol: { kind: 'box', label: 'DEC' },
    netlist: () => ({ pins, instances: b.instances, nets: b.nets() }),
  };
  cache.set(doc, def);
  return def;
}
