import { describe, expect, it } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { resolveComponent } from '../src/lib/resolve';
import { B0, B1, BX, BZ, type Bit, netlistOf } from '../src/sim/types';
import { compileChip } from '../src/editor/compile';
import { docFromDef } from '../src/editor/fromdef';
import type { ChipDoc } from '../src/editor/model';
import { netMembers, netOfSelection } from '../src/editor/netsel';
import { partDef } from '../src/editor/parts';
import { flatten } from '../src/sim/flatten';
import { readersOf } from '../src/sim/netcap';
import { crossings, factsOf, fanText, valueRows } from '../src/view/netfacts';

const bitsOf = (v: bigint, w: number): Bit[] => Array.from({ length: w }, (_, i) => ((v >> BigInt(i)) & 1n ? B1 : B0));

describe('a wire\'s value in the menu', () => {
  it('reads a word in hex, decimal and binary', () => {
    const [hex, dec, sgn, bin] = valueRows(bitsOf(0x1f40n, 16));
    expect(sgn.hidden).toBe(true);
    expect(hex.copy).toBe('0x1F40');
    expect(dec.copy).toBe('8000');
    expect(bin.text).toBe('0001 1111 0100 0000');
    expect(bin.copy).toBe('0001111101000000');
    expect(hex.unknown).toBe(false);
  });

  it('gives both readings of a word with its top bit set', () => {
    const [, dec, sgn] = valueRows(bitsOf(0xffffff0cn, 32));
    expect(dec.copy).toBe('4294967052');
    expect(sgn.copy).toBe('-244');
    expect(sgn.text).toBe('−244');
    expect(sgn.hidden).toBeUndefined();
  });

  it('is exact past 53 bits', () => {
    const v = (1n << 63n) + 1n;
    const [hex, dec, sgn] = valueRows(bitsOf(v, 64));
    expect(hex.copy).toBe('0x8000000000000001');
    expect(dec.copy).toBe('9223372036854775809');
    expect(sgn.copy).toBe('-9223372036854775807');
    expect(valueRows(bitsOf(v, 65))[1].copy).toBe('9223372036854775809');
  });

  it('folds a wide word and still copies all of it', () => {
    const v = (1n << 255n) + 5n;
    const [hex, dec, sgn, bin] = valueRows(bitsOf(v, 256));
    expect(hex.text).toContain('…');
    expect(hex.copy).toHaveLength(66);
    expect(BigInt(hex.copy)).toBe(v);
    expect(bin.text).toContain('…');
    expect(bin.copy).toHaveLength(256);
    expect(BigInt(`0b${bin.copy}`)).toBe(v);
    expect(dec.text).toContain('…');
    expect(BigInt(dec.copy)).toBe(v);
    // each reading folds by itself, whole digits at both ends
    expect(dec.text).toMatch(/^\d{16} … \d{16}$/);
    expect(sgn.text).toMatch(/^−\d{16} … \d{16}$/);
    expect(BigInt(sgn.copy)).toBe(v - (1n << 256n));
    // a word just past the fold's limit folds too
    expect(valueRows(bitsOf(v, 65))[3].text).toContain('…');
  });

  it('marks X and Z per bit, and never makes up a decimal', () => {
    const bits: Bit[] = [...bitsOf(0xf0n, 8), BX, BX, BX, BX, BX, BX, BX, BX];
    const [hex, dec, sgn, bin] = valueRows(bits);
    expect(sgn.hidden).toBe(true);
    expect(hex.text).toBe('0xxxF0');
    expect(hex.unknown).toBe(true);
    expect(dec.text).toBe('unknown (8 X of 16 bits)');
    expect(bin.text).toBe('xxxx xxxx 1111 0000');
    expect(valueRows([BZ, BZ, BZ, BZ])[1].text).toBe('Z: nothing drives it');
  });

  it('gives a bit one row', () => {
    expect(valueRows([B1]).map((r) => [r.k, r.text])).toEqual([['val', '1']]);
    expect(valueRows([BX])[0]).toMatchObject({ text: 'X', unknown: true });
    expect(valueRows([BZ])[0].text).toBe('Z');
    expect(valueRows([])).toEqual([]);
  });
});

describe('a sandbox selection as a net', () => {
  // a real chip through the real compiler: the maps' keys are what this got wrong once
  const doc = docFromDef(resolveComponent('xor')!) as ChipDoc;
  const c = compileChip(doc, (ref) => partDef(ref, () => undefined));
  const pin = doc.pins.find((p) => p.name === 'a')!;
  const idx = c.netOfEnd.get(`pin:${pin.id}`)!;

  it('finds a pin\'s net, and its wires', () => {
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(netOfSelection(c, { pins: [pin.id] })).toBe(idx);
    const { wires } = netMembers(c, idx);
    expect(wires.length).toBeGreaterThan(0);
    expect(netOfSelection(c, { wires })).toBe(idx);
    expect(netOfSelection(c, { wires: wires.slice(0, 1) })).toBe(idx);
    expect(netOfSelection(c, { wires, pins: [pin.id] })).toBe(idx);
  });

  it('finds a pointer\'s net by its id', () => {
    const m = { netOfWire: new Map([['w1', 3]]), netOfLabel: new Map([['l1', 3], ['l2', 4], ['gone', -1]]), netOfEnd: new Map() };
    expect(netOfSelection(m, { labels: ['l1'] })).toBe(3);
    expect(netOfSelection(m, { labels: ['l1'], wires: ['w1'] })).toBe(3);
    expect(netOfSelection(m, { labels: ['l1', 'l2'] })).toBe(-1);
    expect(netOfSelection(m, { labels: ['gone'] })).toBe(-1);
    expect(netMembers(m, 3)).toEqual({ wires: ['w1'], labels: ['l1'] });
  });

  it('is no net for parts, comments, two pins or nothing', () => {
    expect(netOfSelection(c, {})).toBe(-1);
    expect(netOfSelection(c, { parts: [doc.parts[0].id] })).toBe(-1);
    expect(netOfSelection(c, { pins: doc.pins.map((p) => p.id) })).toBe(-1);
    expect(netOfSelection(c, { wires: ['no such wire'] })).toBe(-1);
  });
});

describe('fan-out', () => {
  it('counts every input reading a net: NAND inputs at gate level, gates at switch level', () => {
    const gates = flatten(resolveComponent('xor')!, { mode: 'gate' });
    expect(readersOf(gates)[gates.root.ports.a[0]]).toBe(2);
    const inv = flatten(resolveComponent('inv_cmos')!, { mode: 'switch' });
    expect(readersOf(inv)[inv.root.ports.a[0]]).toBe(2);
    // a source or drain is not an input
    expect(readersOf(inv)[inv.root.ports.y[0]]).toBe(0);
  });
});

describe('who drives a net and who reads it', () => {
  it('reads XOR\'s nets by direction', () => {
    const xor = resolveComponent('xor')!;
    const nl = netlistOf(xor)!;
    const a = factsOf(xor, nl.nets.findIndex((n) => n.ends.includes('a')))!;
    expect(a.drivers.map((e) => e.label)).toEqual(['a']);
    expect(a.sinks.length).toBeGreaterThan(0);
    expect(a.sinks.every((e) => e.inst !== null)).toBe(true);
    expect(crossings(a)).toEqual(a.sinks.map((e) => e.label));
    const y = factsOf(xor, nl.nets.findIndex((n) => n.ends.includes('y')))!;
    expect(y.sinks.map((e) => e.label)).toEqual(['y']);
    expect(y.drivers[0].inst).not.toBeNull();
  });

  it('lists a transistor\'s source and drain as two-way', () => {
    const inv = resolveComponent('inv_cmos')!;
    const nl = netlistOf(inv)!;
    const y = factsOf(inv, nl.nets.findIndex((n) => n.ends.includes('y')))!;
    expect(y.both.length).toBeGreaterThan(0);
    expect(y.drivers).toEqual([]);
  });

  it('accounts for every end of every registered netlist', () => {
    let nets = 0;
    for (const def of registry.values()) {
      const nl = netlistOf(def);
      if (!nl) continue;
      nl.nets.forEach((n, i) => {
        const f = factsOf(def, i)!;
        nets++;
        expect(f.name).toBeTruthy();
        expect(f.drivers.length + f.sinks.length + f.both.length).toBe(n.ends.length);
      });
    }
    expect(nets).toBeGreaterThan(1000);
    expect(factsOf(resolveComponent('xor')!, 9999)).toBeNull();
  });

  it('says what a wire has to drive', () => {
    const f = { name: 'a', drivers: [], sinks: [{ inst: 'u', port: 'a', label: 'u.a' }], both: [] };
    expect(fanText(f, 1, false)).toBe('1 here, 1 NAND input flat');
    expect(fanText(f, 2, true)).toBe('1 here, 2 gate inputs flat');
  });
});
