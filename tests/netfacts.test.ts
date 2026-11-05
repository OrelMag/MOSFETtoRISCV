import { describe, expect, it } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { resolveComponent } from '../src/lib/resolve';
import { B0, B1, BX, BZ, type Bit, netlistOf } from '../src/sim/types';
import { crossings, factsOf, fanText, valueRows } from '../src/view/netfacts';

const bitsOf = (v: bigint, w: number): Bit[] => Array.from({ length: w }, (_, i) => ((v >> BigInt(i)) & 1n ? B1 : B0));

describe('a wire\'s value in the menu', () => {
  it('reads a word in hex, decimal and binary', () => {
    const [hex, dec, bin] = valueRows(bitsOf(0x1f40n, 16));
    expect(hex.copy).toBe('0x1F40');
    expect(dec.copy).toBe('8000');
    expect(bin.text).toBe('0001 1111 0100 0000');
    expect(bin.copy).toBe('0001111101000000');
    expect(hex.unknown).toBe(false);
  });

  it('gives both readings of a word with its top bit set', () => {
    const dec = valueRows(bitsOf(0xffffff0cn, 32))[1];
    expect(dec.copy).toBe('4294967052 -244');
    expect(dec.text).toContain('−244');
  });

  it('is exact past 53 bits', () => {
    const v = (1n << 63n) + 1n;
    const [hex, dec] = valueRows(bitsOf(v, 64));
    expect(hex.copy).toBe('0x8000000000000001');
    expect(dec.copy.split(' ')[0]).toBe('9223372036854775809');
    expect(valueRows(bitsOf(v, 65))[1].copy).toBe('9223372036854775809');
  });

  it('folds a wide word and still copies all of it', () => {
    const v = (1n << 255n) + 5n;
    const [hex, dec, bin] = valueRows(bitsOf(v, 256));
    expect(hex.text).toContain('…');
    expect(hex.copy).toHaveLength(66);
    expect(BigInt(hex.copy)).toBe(v);
    expect(bin.text).toContain('…');
    expect(bin.copy).toHaveLength(256);
    expect(BigInt(`0b${bin.copy}`)).toBe(v);
    expect(dec.text).toContain('…');
    expect(BigInt(dec.copy.split(' ')[0])).toBe(v);
  });

  it('marks X and Z per bit, and never makes up a decimal', () => {
    const bits: Bit[] = [...bitsOf(0xf0n, 8), BX, BX, BX, BX, BX, BX, BX, BX];
    const [hex, dec, bin] = valueRows(bits);
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
