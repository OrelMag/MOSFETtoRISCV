// The sandbox ROM speaks RV16: assembly builds the same words as the campaign's assembler, the
// part refuses an RV16 program in a 32-bit or byte-addressed ROM, conversion to hex and back
// keeps the words, and stored documents keep the language.

import { describe, expect, it } from 'vitest';
import { convertProgram, romImage, RV16_LEDS } from '../src/editor/memory';
import { partDef } from '../src/editor/parts';
import { buildProgram } from '../src/editor/program';
import { sanitizeChip } from '../src/editor/store';
import { assemble16 } from '../src/riscv/rv16/asm16';

describe('RV16 programs in the sandbox ROM', () => {
  it('builds the assembler\'s words, word addressed, with RV16 disassembly', () => {
    const p = buildProgram('rv16', RV16_LEDS);
    expect(p.errors).toEqual([]);
    expect(p.words).toEqual(assemble16(RV16_LEDS).words);
    expect(p.lines.find((l) => l.text === 'sw a0, 0(sp)')).toMatchObject({ addr: 16 }); // li sp, 0x20 takes two words
    const d = partDef({ rom: { k: 5, w: 16, addr: 'word', lang: 'rv16', src: RV16_LEDS } }, () => undefined);
    expect('error' in d).toBe(false);
    if (!('error' in d)) expect(d.behavior!.eval([3], undefined)[0]).toBe(p.words[3]);
    expect(partDef({ rom: { k: 5, w: 32, addr: 'word', lang: 'rv16', src: RV16_LEDS } }, () => undefined)).toEqual({ error: 'ROM: RV16 programs need 16-bit words, word addressed' });
    expect(romImage({ k: 2, w: 16, lang: 'rv16', src: RV16_LEDS }).error).toMatch(/do not fit/);
  });

  it('converts to hex and back', () => {
    const hex = convertProgram(RV16_LEDS, 'hex', 'rv16')!;
    expect(buildProgram('hex', hex).words).toEqual(assemble16(RV16_LEDS).words);
    const back = convertProgram(hex, 'rv16', 'hex')!;
    expect(buildProgram('rv16', back).words).toEqual(assemble16(RV16_LEDS).words);
    expect(convertProgram(RV16_LEDS, 'asm', 'rv16')).toBeNull();
  });

  it('survives the store\'s sanitizer', () => {
    const chip = { id: 'u_c', name: 'c', pins: [], parts: [{ id: 'rom', ref: { rom: { k: 5, w: 16, addr: 'word', lang: 'rv16', src: RV16_LEDS } }, at: [0, 0] }], wires: [], labels: [] };
    expect(sanitizeChip(chip)!.parts[0].ref).toEqual(chip.parts[0].ref);
  });
});
