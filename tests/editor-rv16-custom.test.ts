// RV16 custom instructions in the sandbox (editor/owninstr16.ts applies them): the core part becomes { core16 }, the
// ROM keeps a copy of the rows, both survive the store's sanitizer, the CPU drawer's detection reads the rows off the
// core, and its golden model runs them in lock step with the gates, on the single-cycle core and on the pipeline.

import { describe, expect, it } from 'vitest';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { detectRv16, rv16Program, Rv16Monitor } from '../src/editor/cpu16';
import { UserLibrary } from '../src/editor/library';
import { type ChipDoc, emptyWorkspace, rv16CoreOf, rv16CoreRef } from '../src/editor/model';
import { sanitizeChip, sanitizeRef } from '../src/editor/store';
import { EditorSim } from '../src/editor/runtime';
import { issCode16, WHY_NO_IMM16 } from '../src/editor/owninstr16';
import type { Custom16Row } from '../src/riscv/rv16/custom16';
import '../src/lib';

const LWX: Custom16Row = { name: 'lwx', f3: 1, alu: 'add', result: 'mem' };

// stores 10…14 to words 0…4, then sums them back through the indexed load and shows the sum on the LEDs
const SRC = `        li   a0, 0
        li   a1, 5
fill:   addi t0, a0, 10
        sw   t0, 0(a0)
        addi a0, a0, 1
        blt  a0, a1, fill
        li   a0, 0
        li   a2, 0
sum:    lwx  t0, zero, a0
        add  a2, a2, t0
        addi a0, a0, 1
        blt  a0, a1, sum
        sw   a2, -5(zero)
        halt
`;

function computer(pipe: boolean, rows: Custom16Row[]) {
  let doc = levelChallenge(nodeById('c_computer')!)!.answer().at(-1)!;
  const desc = detectRv16(doc, {})!;
  doc = {
    ...doc, parts: doc.parts.map((p) => (p.id === desc.core ? { ...p, ref: rv16CoreRef({ pipe, custom: rows }) }
      : p.id === desc.rom && 'rom' in p.ref ? { ...p, ref: { rom: { ...p.ref.rom, src: SRC, ...(rows.length ? { custom16: rows } : {}) } } } : p)),
  };
  // what a reload makes of it
  doc = sanitizeChip(JSON.parse(JSON.stringify(doc)))!;
  const ws = { ...emptyWorkspace(), chips: { [doc.id]: doc } };
  const es = new EditorSim({ debounceMs: 0 });
  es.update(new UserLibrary(ws).compiled(doc.id)!, doc.pins);
  return { doc, es, ws };
}

describe('RV16 custom instructions in the sandbox', { timeout: 120000 }, () => {
  it('the part refs: a library id without rows, { core16 } with, both through the sanitizer', () => {
    expect(rv16CoreRef({ pipe: false, custom: [] })).toEqual({ lib: 'rv16_cpu' });
    expect(rv16CoreRef({ pipe: true, custom: [] })).toEqual({ lib: 'rv16_pipe_111' });
    expect(sanitizeRef({ core16: { custom: [LWX], pipe: true } })).toEqual({ core16: { custom: [LWX], pipe: true } });
    expect(sanitizeRef({ core16: { custom: [{ ...LWX, f3: 5 }] } })).toEqual({ lib: 'rv16_cpu' });
    expect(rv16CoreOf({ lib: 'rv16_pipe_111' })).toEqual({ pipe: true, custom: [] });
    expect(rv16CoreOf({ lib: 'rv16_pipe_111s' })).toBeNull();
    // the ROM's copy only on an RV16 ROM
    expect(sanitizeRef({ rom: { k: 4, w: 16, addr: 'word', lang: 'rv16', src: '', custom16: [LWX] } })).toEqual({ rom: { k: 4, w: 16, addr: 'word', lang: 'rv16', src: '', custom16: [LWX] } });
    expect(sanitizeRef({ rom: { k: 4, w: 32, addr: 'rv32', lang: 'asm', src: '', custom16: [LWX] } })).toEqual({ rom: { k: 4, w: 32, addr: 'rv32', lang: 'asm', src: '' } });
  });

  for (const pipe of [false, true]) {
    it(`${pipe ? 'the pipeline' : 'the single-cycle core'} runs the row in lock step with the golden model`, () => {
      const { doc, es, ws } = computer(pipe, [LWX]);
      const d = detectRv16(doc, ws.chips)!;
      expect(d.custom).toEqual([LWX]);
      expect(rv16Program(doc, d.rom)).not.toBeNull();
      const m = new Rv16Monitor(es, () => doc);
      expect(m.problem).toBeNull();
      m.runToHalt(Infinity, 2000);
      expect(m.mismatch).toBeNull();
      expect(m.iss!.halted).toBe(true);
      expect(m.leds).toBe(10 + 11 + 12 + 13 + 14);
      expect(m.log.some((e) => e.text.startsWith('lwx t0, zero, a0'))).toBe(true);
    });
  }

  it('without the row in the core, the ROM does not assemble (the program names an instruction the core lacks)', () => {
    const { doc } = computer(false, []);
    expect(rv16Program(doc, detectRv16(doc, {})!.rom)).toBeNull();
  });

  it('the dialog says why rows have no immediate, and the golden model code steps the PC by one word', () => {
    expect(WHY_NO_IMM16).toMatch(/opcode is full/);
    expect(WHY_NO_IMM16).toMatch(/no immediate/);
    expect(issCode16(LWX)).toBe('// lwx: R-type, opcode OPX (0010), funct3 001\nconst y = x[rs1] + x[rs2];\nif (rd) x[rd] = load16(y);\npc += 1;');
  });
});
