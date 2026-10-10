// The sandbox's memories: a ROM's image, listing and current row; language conversion; RAM
// contents read from the simulation and seeded at power-on (dotted power-on hints); and the
// examples (each compiles cleanly and runs).

import { describe, expect, it } from 'vitest';
import { checkSimulatable } from '../src/editor/compile';
import { addExample, counterSeg7Chip, EXAMPLES, FETCH_PROGRAM, fetchChip } from '../src/editor/examples';
import { UserLibrary } from '../src/editor/library';
import { deadParts, openInputs } from '../src/editor/lint';
import {
  convertProgram, initText, kFor, parseInit, ramInit, ramWithInit, readRam, ROM_SAMPLES, romImage, romIndex, romListing, SEG7_FONT,
} from '../src/editor/memory';
import { emptyWorkspace } from '../src/editor/model';
import { isError, partDef } from '../src/editor/parts';
import { buildProgram } from '../src/editor/program';
import { sanitizeChip } from '../src/editor/store';
import { ram } from '../src/lib/memory';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { simulate } from '../src/sim/harness';
import type { ComponentDef } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { chip, compileLib, part, pin, wire, workspace } from './editorkit';
import { out, set, tick } from './util';

describe('ROM image and listing', () => {
  it('locates size and width problems on source lines; the part reports the first', () => {
    const img = romImage({ k: 1, w: 8, lang: 'hex', src: '1\n2\n1ff' });
    expect(img.problems).toEqual([
      { line: 3, message: '3 words do not fit in 2^1 = 2 words' },
      { line: 3, message: 'word 2 (0x1ff) does not fit in 8 bits' },
    ]);
    expect(img.error).toBe('ROM program: 3 words do not fit in 2^1 = 2 words');
    const asm = romImage({ k: 3, w: 32, lang: 'asm', src: 'addi x1, x0, 1\nbogus' });
    expect(asm.problems[0].line).toBe(2);
    expect(romImage({ k: 3, w: 32, lang: 'asm', src: FETCH_PROGRAM }).problems).toEqual([]);
  });

  it('rows: byte addresses (rv32) or word indices, disassembly for 32-bit words, source lines', () => {
    const img = romImage({ k: 3, w: 32, lang: 'asm', src: FETCH_PROGRAM });
    const rows = romListing({ w: 32, addr: 'rv32' }, img);
    expect(rows).toHaveLength(8);
    expect(rows[3]).toMatchObject({ index: 3, addr: '0x000c', text: expect.stringMatching(/^add\s/) });
    expect(FETCH_PROGRAM.split('\n')[rows[3].srcLine - 1]).toMatch(/loop:\s+add/);
    const hex = romListing({ w: 8, addr: 'word' }, romImage({ k: 2, w: 8, lang: 'hex', src: 'a 1b' }));
    expect(hex.map((r) => [r.addr, r.word, r.text])).toEqual([['[0]', '0a', ''], ['[1]', '1b', '']]);
  });

  it('current word from the address value: rv32 divides by 4 and wraps, X is unknown', () => {
    expect(romIndex({ k: 3, addr: 'rv32' }, 12)).toBe(3);
    expect(romIndex({ k: 3, addr: 'rv32' }, 32 + 4)).toBe(1);
    expect(romIndex({ k: 2, addr: 'word' }, 3)).toBe(3);
    expect(romIndex({ k: 2, addr: 'word' }, -1)).toBeNull();
  });

  it('converts between assembly and hex without changing the words', () => {
    const hex = convertProgram(FETCH_PROGRAM, 'hex')!;
    expect(buildProgram('hex', hex).words).toEqual(buildProgram('asm', FETCH_PROGRAM).words);
    const back = convertProgram(hex, 'asm')!;
    expect(buildProgram('asm', back).words).toEqual(buildProgram('asm', FETCH_PROGRAM).words);
    expect(convertProgram('bogus x1', 'hex')).toBeNull();
  });

  it('every sample builds, and fits the smallest ROM kFor picks', () => {
    for (const s of ROM_SAMPLES) {
      const p = buildProgram(s.lang, s.src);
      expect(p.errors, s.id).toEqual([]);
      expect(p.words.length, s.id).toBeLessThanOrEqual(2 ** kFor(p.words.length));
    }
    expect(kFor(0)).toBe(1);
    expect(kFor(8)).toBe(3);
    expect(kFor(9)).toBe(4);
  });
});

describe('RAM contents', () => {
  const K = 2, W = 4;

  it('a dotted power-on hint seeds a net deep in the hierarchy; unknown names still throw', () => {
    const d: ComponentDef = { ...ram(K, W), id: 'ram_hint_test', powerOn: { 'w1.ff2.ff.slave.sr.q': 1, 'w1.ff2.ff.slave.sr.q_n': 0, 'w1.ff2.ff.master.sr.q': 1, 'w1.ff2.ff.master.sr.q_n': 0 } };
    const s = new GateSim(flatten(d));
    s.reset('zero');
    expect(readRam(s, 'm')).toBeNull(); // not placed in a chip: no node 'm'
    expect(s.design.powerOn.size).toBeGreaterThan(0);
    const bad: ComponentDef = { ...d, id: 'ram_hint_bad', powerOn: { 'w1.nope.q': 1 } };
    expect(() => flatten(bad)).toThrow(/unknown net 'w1.nope.q'/);
  });

  it('initial contents appear at power-on (to 0), survive until written, and reads match', () => {
    const init = [0x3, 0xa, 0, 0xf];
    const doc = chip('u_m', 'M', {
      pins: [pin('addr', 'in', [-10, 2], K), pin('din', 'in', [-10, 4], W), pin('we', 'in', [-10, 6]), pin('clk', 'in', [-10, 12]), pin('dout', 'out', [30, 4], W)],
      parts: [part('mem', { ram: { k: K, w: W, init } }, [0, 0])],
      wires: [wire('a', 'pin:addr', 'mem.addr'), wire('d', 'pin:din', 'mem.din'), wire('e', 'pin:we', 'mem.we'), wire('c', 'pin:clk', 'mem.clk'), wire('o', 'mem.dout', 'pin:dout')],
    });
    const c = compileLib(doc);
    expect(c.diags).toEqual([]);
    const sim = new GateSim(flatten(c.def));
    for (const n of ['addr', 'din', 'we', 'clk']) sim.setInput(n, 0);
    sim.reset('zero');
    sim.settle();
    expect(readRam(sim, 'mem')).toEqual(init);
    sim.reset('x');
    sim.settle();
    expect(readRam(sim, 'mem')).toEqual([-1, -1, -1, -1]);

    // The RAM's own ports: read each word, then write one.
    const r = simulate(ramWithInit(K, W, init));
    set(r, { clk: 0, we: 0, din: 0 });
    for (let a = 0; a < 4; a++) {
      set(r, { addr: a });
      expect(out(r, 'dout'), `word ${a}`).toBe(init[a]);
    }
    set(r, { addr: 2, din: 9, we: 1 });
    tick(r);
    set(r, { we: 0 });
    expect(out(r, 'dout')).toBe(9);
    set(r, { addr: 1 });
    expect(out(r, 'dout')).toBe(0xa);
  });

  it('no init (or all zero) is the library RAM itself; init is trimmed and masked; cached by content', () => {
    expect(ramWithInit(K, W, undefined)).toBe(ram(K, W));
    expect(ramWithInit(K, W, [0, 0])).toBe(ram(K, W));
    expect(ramInit(K, W, [1, 0x1f, 2, 3, 4])).toEqual([1, 0xf, 2, 3]);
    expect(ramWithInit(K, W, [1, 2])).toBe(ramWithInit(K, W, [1, 2]));
    expect(ramWithInit(K, W, [1, 2]).id).not.toBe(ram(K, W).id);
    const d = partDef({ ram: { k: K, w: W, init: [5] } }, () => undefined);
    expect(isError(d) ? d.error : d.id).toBe(ramWithInit(K, W, [5]).id);
  });

  it('init text round-trips; bad words are refused', () => {
    expect(initText([1, 2, 0, 0], 8)).toBe('01 02');
    expect(parseInit('01 02', 2, 8)).toEqual({ init: [1, 2] });
    expect(parseInit('@2 ff', 2, 8)).toEqual({ init: [0, 0, 0xff] });
    expect(parseInit('100', 2, 8)).toEqual({ error: 'word 0 (0x100) does not fit in 8 bits' });
    expect(parseInit('1 2 3 4 5', 2, 8)).toHaveProperty('error');
  });

  it('the store keeps init (non-zero only) and drops junk', () => {
    const raw = (init: unknown) => ({ id: 'u_x', name: 'X', parts: [{ id: 'm', ref: { ram: { k: 2, w: 8, init } }, at: [0, 0] }] });
    expect(sanitizeChip(raw([1, 2]))!.parts[0].ref).toEqual({ ram: { k: 2, w: 8, init: [1, 2] } });
    expect(sanitizeChip(raw([0, 0]))!.parts[0].ref).toEqual({ ram: { k: 2, w: 8 } });
    expect(sanitizeChip(raw(['x']))!.parts[0].ref).toEqual({ ram: { k: 2, w: 8 } });
  });
});

describe('examples', () => {
  it.each(EXAMPLES.map((e) => [e.id, e] as const))('%s compiles cleanly and is simulatable', (_id, ex) => {
    const { ws, id } = addExample(emptyWorkspace(), ex);
    expect(ws.open[ws.open.length - 1]).toBe(id);
    const lib = new UserLibrary(ws);
    const c = lib.compiled(id)!;
    expect(c.diags).toEqual([]);
    expect(checkSimulatable(c)).toEqual([]);
    expect(deadParts(ws.chips[id], c)).toEqual([]);
    expect(openInputs(c)).toEqual([]);
  });

  it('loading twice adds a second chip; nothing is overwritten', () => {
    const a = addExample(emptyWorkspace(), EXAMPLES[0]);
    const b = addExample(a.ws, EXAMPLES[0]);
    expect(b.id).not.toBe(a.id);
    expect(Object.keys(b.ws.chips)).toHaveLength(3);
    expect(b.ws.chips[b.id].name).not.toBe(a.ws.chips[a.id].name);
  });

  it('fetch loop: the PC steps by 4 and the ROM returns each word, wrapping', () => {
    const lib = new UserLibrary(workspace(fetchChip('u_f', 'F')));
    const sim = simulate(lib.defOf('u_f')!);
    const words = buildProgram('asm', FETCH_PROGRAM).words;
    set(sim, { clk: 0 });
    for (let i = 0; i < 20; i++) {
      expect(out(sim, 'pc')).toBe(4 * i);
      expect(out(sim, 'instr')).toBe(words[i % 8] >>> 0);
      tick(sim);
    }
  });

  it('counter: the font ROM drives the 7-segment digit 0–F', () => {
    const lib = new UserLibrary(workspace(counterSeg7Chip('u_c', 'C')));
    const c = lib.compiled('u_c')!;
    const s = new GateSim(flatten(c.def));
    s.setInput('clk', 0);
    s.reset('zero');
    s.settle();
    const seg = c.netOfEnd.get('p:seg.a')!;
    for (let i = 0; i < 18; i++) {
      expect(pack(s.getBits(s.design.root.nets![seg])), `count ${i}`).toBe(SEG7_FONT[i % 16]);
      s.setInput('clk', 1);
      s.settle();
      s.setInput('clk', 0);
      s.settle();
    }
  });
});
