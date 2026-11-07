// The sandbox ROM speaks the DSP core's assembly (DSP24, 24-bit words): every benchmark builds the assembler's words, word
// addressed, with disasm24 in the listing; the part refuses a DSP24 program in a 32-bit or byte-addressed ROM; conversion to
// hex and back keeps the words; stored documents keep the language and the width; the highlighter knows the assembler's
// mnemonics, registers and directives; the builder's ISA exists (the instruction builder takes tables only: null there).

import { describe, expect, it } from 'vitest';
import { assemble24, DIRECTIVES24 } from '../src/dsp/asm24';
import { BY_NAME24, disasm24, INSTRS24, REGNAMES24 } from '../src/dsp/isa24';
import { BENCH24 } from '../src/dsp/programs24';
import { composeIsaOf } from '../src/isa/compose';
import { isaOf } from '../src/isa/isa';
import { convertProgram, ROM_SAMPLES, romImage, romListing, sampleK } from '../src/editor/memory';
import { partDef } from '../src/editor/parts';
import { buildProgram } from '../src/editor/program';
import { sanitizeChip } from '../src/editor/store';
import { tokenize } from '../src/widgets/codetok';

const sig = (line: string) => tokenize(line, 'dsp24asm').filter((t) => t.text.trim()).map((t) => `${t.cls}:${t.text.trim()}`);

describe('DSP24 programs in the sandbox ROM', () => {
  it('builds every benchmark to the assembler\'s words, word addressed, with disasm24', () => {
    for (const b of BENCH24) {
      const p = buildProgram('dsp24', b.src);
      const a = assemble24(b.src);
      expect(p.errors, b.id).toEqual([]);
      expect(p.words, b.id).toEqual(a.words);
      expect(p.lines.map((l) => l.addr), b.id).toEqual(a.lines.map((l) => 4 * l.addr));
      expect(p.lines.map((l) => l.text), b.id).toEqual(a.lines.map((l) => disasm24(l.word)));
      expect(p.lines.map((l) => l.srcLine), b.id).toEqual(a.lines.map((l) => l.srcLine));
    }
  });

  it('offers the benchmarks with lang dsp24, each in a ROM that fits', () => {
    for (const b of BENCH24) {
      const s = ROM_SAMPLES.find((x) => x.id === `dsp24_${b.id}`)!;
      expect(s).toEqual({ id: `dsp24_${b.id}`, name: `DSP24: ${b.name}`, lang: 'dsp24', src: b.src });
      expect(sampleK('dsp24', b.src), b.id).toBeLessThanOrEqual(8);
    }
  });

  it('a dsp24 ROM part compiles; its image and listing show disasm24, six hex digits a word', () => {
    const src = BENCH24[0].src;
    const words = assemble24(src).words;
    const ref = { k: 8, w: 24 as const, addr: 'word' as const, lang: 'dsp24' as const, src };
    const d = partDef({ rom: ref }, () => undefined);
    expect('error' in d).toBe(false);
    if (!('error' in d)) {
      expect(d.ports.find((p) => p.name === 'data')!.width).toBe(24);
      expect(d.behavior!.eval([3], undefined)[0]).toBe(words[3]);
      expect(d.behavior!.eval([200], undefined)[0]).toBe(0); // past the program: zero words (nop)
    }
    const img = romImage(ref);
    expect(img.error).toBeNull();
    const rows = romListing(ref, img);
    expect(rows[0]).toMatchObject({ index: 0, addr: '[0]', word: words[0].toString(16).padStart(6, '0'), text: disasm24(words[0]) });
    expect(rows.every((r, i) => r.text === disasm24(words[i]) && r.word.length === 6)).toBe(true);
    expect(partDef({ rom: { ...ref, w: 32 } }, () => undefined)).toEqual({ error: 'ROM: DSP24 programs need 24-bit words, word addressed' });
    expect(partDef({ rom: { ...ref, w: 16 } }, () => undefined)).toEqual({ error: 'ROM: DSP24 programs need 24-bit words, word addressed' });
    expect(partDef({ rom: { ...ref, w: 32, addr: 'rv32' } }, () => undefined)).toEqual({ error: 'ROM: DSP24 programs need 24-bit words, word addressed' });
    expect(romImage({ ...ref, k: 2 }).error).toMatch(/do not fit/);
    // a hex program of 24 bits fits a 24-bit ROM; a wider word does not
    expect(romImage({ k: 2, w: 24, lang: 'hex', src: '0xffffff' }).error).toBeNull();
    expect(romImage({ k: 2, w: 24, lang: 'hex', src: '0x1000000' }).error).toMatch(/does not fit in 24 bits/);
  });

  it('converts to hex and back for every benchmark', () => {
    for (const b of BENCH24) {
      const words = assemble24(b.src).words;
      const hex = convertProgram(b.src, 'hex', 'dsp24')!;
      expect(hex.split('\n')[0]).toMatch(/^0x[0-9a-f]{6} {2}# /);
      expect(buildProgram('hex', hex).words, b.id).toEqual(words);
      const back = convertProgram(hex, 'dsp24', 'hex')!;
      expect(back.split('\n')[0]).toBe(`        .word 0x${words[0].toString(16).padStart(6, '0')}   # ${disasm24(words[0])}`);
      expect(buildProgram('dsp24', back).words, b.id).toEqual(words);
    }
    expect(convertProgram(BENCH24[0].src, 'asm', 'dsp24')).toBeNull();
    expect(convertProgram(BENCH24[0].src, 'cpu4', 'dsp24')).toBeNull();
  });

  it('survives the store\'s sanitizer, width and language kept; a bad width is refused', () => {
    const ref = { rom: { k: 8, w: 24, addr: 'word', lang: 'dsp24', src: BENCH24[0].src } };
    const chip = { id: 'u_c', name: 'c', pins: [], parts: [{ id: 'rom', ref, at: [0, 0] }], wires: [], labels: [] };
    expect(sanitizeChip(chip)!.parts[0].ref).toEqual(ref);
    expect(sanitizeChip(JSON.parse(JSON.stringify(sanitizeChip(chip))))!.parts[0].ref).toEqual(ref);
    const bad = { ...chip, parts: [{ id: 'rom', ref: { rom: { ...ref.rom, w: 20 } }, at: [0, 0] }] };
    expect(sanitizeChip(bad)!.parts).toEqual([]);
  });

  it('is an Isa for the editor (fields of 24 bits), and no table for the instruction builder', () => {
    const isa = isaOf('dsp24')!;
    expect(isa).toMatchObject({ id: 'dsp24', wordBits: 24, addressing: 'word' });
    expect(isa.words.mnemonics).toEqual(INSTRS24.map((i) => i.name));
    const w = assemble24('mac x(p0)+c, y(p4)-').words[0];
    expect(isa.disasm(w)).toBe(disasm24(w));
    expect(isa.fields(w).reduce((n, f) => n + f.bits, 0)).toBe(24);
    for (const i of INSTRS24) expect(isa.fields(assemble24(i.name === 'loop' ? 'loop 3, 1' : i.name).words[0] ?? 0).reduce((n, f) => n + f.bits, 0), i.name).toBe(24);
    expect(composeIsaOf('dsp24')).toBeNull();
  });
});

describe('dsp24asm tokenizer', () => {
  it('labels, mnemonics in any case, registers, memory operands, numbers, comments', () => {
    expect(sig('next:   ld    r1, x(p1)+        ; the next sample')).toEqual(['lbl:next:', 'op:ld', 'reg:r1', 'pun:,', 'kw:x', 'pun:(', 'reg:p1', 'pun:)+', 'com:; the next sample']);
    expect(sig('  MAC x(p0)+c, y(p4)-m')).toEqual(['op:MAC', 'kw:x', 'pun:(', 'reg:p0', 'pun:)+', 'kw:c', 'pun:,', 'kw:y', 'pun:(', 'reg:p4', 'pun:)-', 'kw:m']);
    expect(sig('mov xl, r3')).toEqual(['op:mov', 'reg:xl', 'pun:,', 'reg:r3']);
    expect(sig('ldi p1, -5 # c')).toEqual(['op:ldi', 'reg:p1', 'pun:,', 'num:-5', 'com:# c']);
    expect(sig('jnz r2, next')).toEqual(['op:jnz', 'reg:r2', 'pun:,', 'sym:next']);
    expect(sig('.word 0x123456')).toEqual(['dir:.word', 'num:0x123456']);
    expect(sig('.text')[0]).toBe('bad:.text');
    expect(sig('mv r1')[0]).toBe('bad:mv'); // an RV32 mnemonic is not a DSP24 one
    expect(sig('ld r8, x(p0)')[1]).toBe('sym:r8');
  });

  it('every directive, instruction and register of the assembler is known, in any case', () => {
    for (const d of DIRECTIVES24) expect(sig(d)[0]).toBe(`dir:${d}`);
    for (const i of INSTRS24) {
      expect(BY_NAME24.has(i.name)).toBe(true);
      expect(sig(i.name)[0]).toBe(`op:${i.name}`);
      expect(sig(i.name.toUpperCase())[0]).toBe(`op:${i.name.toUpperCase()}`);
    }
    for (const r of REGNAMES24) if (r) expect(sig(`mov ${r}, r0`)[1], r).toBe(`reg:${r}`);
  });

  it('tokens rebuild every line of every benchmark, with nothing flagged', () => {
    for (const b of BENCH24) {
      for (const line of b.src.split('\n')) {
        const ts = tokenize(line, 'dsp24asm');
        expect(ts.map((t) => t.text).join('')).toBe(line);
        expect(ts.filter((t) => t.cls === 'bad'), `${b.id}: ${line}`).toEqual([]);
      }
    }
  });
});
