// The sandbox ROM part: a program (assembly or hex) → a mux tree of constants, simulated as a
// lookup. The lookup must be the structure, and an rv32 ROM must fetch like the CPU's.

import { describe, expect, it } from 'vitest';
import type { PartRef } from '../src/editor/model';
import { isError, MAX_ROM_K, partDef, wordRom } from '../src/editor/parts';
import { buildProgram } from '../src/editor/program';
import { registry } from '../src/lib/define';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { evalOnce, simulate } from '../src/sim/harness';
import type { ComponentDef } from '../src/sim/types';
import { netlistOf } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { ViewCtx } from '../src/view/context';
import { routeNetlist, wireOverlaps } from '../src/view/route';

type Rom = Extract<PartRef, { rom: unknown }>['rom'];
const romOf = (r: Partial<Rom>) => partDef({ rom: { k: 2, w: 8, addr: 'word', lang: 'hex', src: '', ...r } }, () => undefined);
const def = (r: Partial<Rom>): ComponentDef => {
  const d = romOf(r);
  if (isError(d)) throw new Error(d.error);
  return d;
};

/** Gate-level simulation of the real structure (the ROM's lookup is not used). */
const structural = (d: ComponentDef) => new GateSim(flatten(d, { expand: () => true }));

const ASM = `
  addi x1, x0, 5
  addi x2, x0, 7
loop:
  add  x3, x1, x2
  beq  x0, x0, loop
`;

describe('ROM part', () => {
  it.each([
    [1, 8], [2, 8], [3, 16], [4, 8], [4, 32],
  ] as const)('word-addressed 2^%i × %i: lookup ≡ mux tree, exhaustively', (k, w) => {
    const words = Array.from({ length: 2 ** k }, (_, i) => (Math.imul(i + 1, 0x9e3779b1) >>> 0) % 2 ** w);
    const d = def({ k, w, src: words.map((x) => x.toString(16)).join(' ') });
    expect(d.ports).toEqual([{ name: 'addr', width: k, dir: 'in' }, { name: 'data', width: w, dir: 'out' }]);
    expect(d.preferBehavior).toBe(true);
    const beh = simulate(d), str = structural(d);
    expect(beh.design.leaves).toHaveLength(1); // the lookup
    expect(str.design.leaves.length).toBeGreaterThan(2 ** k); // the tree of NANDs
    for (let a = 0; a < 2 ** k; a++) {
      expect(evalOnce(beh, [a]), `beh[${a}]`).toEqual([words[a]]);
      expect(evalOnce(str, [a]), `str[${a}]`).toEqual([words[a]]);
    }
  });

  it('rv32: fetches the assembled words at byte addresses 0, 4, 8, … (NOPs past the end)', () => {
    const p = buildProgram('asm', ASM);
    expect(p.errors).toEqual([]);
    const d = def({ k: 3, w: 32, addr: 'rv32', lang: 'asm', src: ASM });
    expect(d.ports).toEqual([{ name: 'addr', width: 32, dir: 'in' }, { name: 'data', width: 32, dir: 'out' }]);
    const beh = simulate(d), str = structural(d);
    for (let i = 0; i < 8; i++) {
      const want = i < p.words.length ? p.words[i] >>> 0 : 0x13;
      for (const off of [0, 1, 3]) expect(evalOnce(beh, [4 * i + off]), `beh @${4 * i + off}`).toEqual([want]);
      expect(evalOnce(str, [4 * i]), `str @${4 * i}`).toEqual([want]);
    }
    expect(evalOnce(beh, [32])).toEqual([p.words[0] >>> 0]); // wraps like the CPU's ROM
  });

  it('same program → same def (cached); the cache is bounded; nothing is registered', () => {
    const before = registry.size;
    const a = def({ src: '1 2 3' }), b = def({ src: '1 2 3' });
    expect(a).toBe(b);
    expect(def({ src: '1 2 4' })).not.toBe(a);
    for (let i = 0; i < 20; i++) def({ src: `${i + 10}` });
    expect(def({ src: '1 2 3' })).not.toBe(a); // evicted
    // muxTree may register library trees on first use; the program's words never do.
    expect([...registry.keys()].slice(before).filter((id) => /const|rom/.test(id))).toEqual([]);
  });

  it('wordRom: content past the program is 0 (word) or NOP (rv32)', () => {
    expect(evalOnce(simulate(wordRom(2, 8, 'word', [5])), [3])).toEqual([0]);
    expect(evalOnce(simulate(wordRom(2, 32, 'rv32', [5])), [12])).toEqual([0x13]);
  });

  it('errors: first program error with its line, size, width, parameters', () => {
    const err = (r: Partial<Rom>) => {
      const d = romOf(r);
      return isError(d) ? d.error : 'ok';
    };
    expect(err({ src: '1\nzz 2\nqq' })).toBe('ROM program: line 2: not a hex number: "zz"');
    expect(err({ lang: 'asm', w: 32, src: 'addi x1, x0, 1\nfoo x1' })).toMatch(/^ROM program: line 2: /);
    expect(err({ k: 1, src: '1 2 3' })).toBe('ROM program: 3 words do not fit in 2^1 = 2 words');
    expect(err({ src: '1\n1ff' })).toBe('ROM program: line 2: word 1 (0x1ff) does not fit in 8 bits');
    expect(err({ k: 0 })).toMatch(/k = 1–/);
    expect(err({ k: MAX_ROM_K + 1 })).toMatch(/k = 1–/);
    expect(err({ w: 12 as 8 })).toMatch(/8, 16 or 32/);
    expect(err({ addr: 'rv32', w: 16 })).toMatch(/32-bit/);
    expect(err({ src: '' })).toBe('ok');
  });

  it('opened, it simulates its structure: the mux opens, inner nets carry values', () => {
    // A placed ROM is a lookup leaf; look inside starts a sub-simulation of the ROM itself,
    // which must expand it despite preferBehavior (else nothing inside is live or openable).
    const words = [0x513, 0x100293, 0xb00313, 0x550533, 0x128293, 0xfe629ce3, 0xa02023, 0x6f];
    const R = wordRom(3, 32, 'rv32', words);
    const top: ComponentDef = {
      id: 't_rom_host', name: 'host', category: 'memory', ports: R.ports, symbol: { kind: 'box' },
      netlist: () => ({ pins: { addr: [0, 0], data: [0, 0] }, instances: [{ name: 'rom', def: R, at: [0, 0] }],
        nets: [{ ends: ['addr', 'rom.addr'] }, { ends: ['rom.data', 'data'] }] }),
    };
    const sim = new GateSim(flatten(top));
    sim.setInput('addr', 0x79c);
    sim.settle();
    const root = new ViewCtx(sim, sim.design.root);
    expect(root.childLeaf('rom')).toBeDefined();
    const rom = root.child('rom')!;
    expect(rom.isSubSim).toBe(true);
    expect(rom.canOpen('mux')).toBe(true);
    expect(pack(rom.sim.getBits(rom.node.children!.get('mux')!.ports.s))).toBe(7);
    expect(pack(rom.portBits('data'))).toBe(0x6f);
    const mux = rom.child('mux')!;
    expect(mux.canOpen('m0_0')).toBe(true);
    expect(pack(mux.portBits('y'))).toBe(0x6f);
  });

  it('its inside view routes cleanly', () => {
    for (const d of [def({ k: 3, src: '1 2 3' }), def({ k: 3, w: 32, addr: 'rv32', lang: 'asm', src: ASM })]) {
      expect(wireOverlaps(routeNetlist(d, netlistOf(d)!).nets)).toEqual([]);
    }
  });
});
