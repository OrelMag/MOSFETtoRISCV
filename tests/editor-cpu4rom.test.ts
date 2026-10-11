// The sandbox ROM speaks the 4-bit CPU's assembly: every sample builds the assembler's words, word
// addressed, with disasm4 in the listing; the part refuses a 4-bit program in a 32-bit or
// byte-addressed ROM; conversion to hex and back keeps the words; stored documents keep the
// language; the highlighter knows exactly the assembler's mnemonics, registers and conditions.

import { describe, expect, it } from 'vitest';
import { convertProgram, ROM_SAMPLES, romImage, romListing } from '../src/editor/memory';
import { partDef } from '../src/editor/parts';
import { buildProgram } from '../src/editor/program';
import { sanitizeChip } from '../src/editor/store';
import { assemble4, DIRECTIVES4 } from '../src/isa4/asm4';
import { disasm4, INSTRS4, JCN_NAMES } from '../src/isa4/isa4';
import { PROGRAMS4 } from '../src/isa4/programs4';
import { tokenize } from '../src/widgets/codetok';

const sig = (line: string) => tokenize(line, 'cpu4asm').filter((t) => t.text.trim()).map((t) => `${t.cls}:${t.text.trim()}`);

describe('4-bit CPU programs in the sandbox ROM', () => {
  it('builds every sample to the assembler\'s words, word addressed, with disasm4', () => {
    for (const s of PROGRAMS4) {
      const p = buildProgram('cpu4', s.src);
      const a = assemble4(s.src);
      expect(p.errors, s.id).toEqual([]);
      expect(p.words, s.id).toEqual(a.words);
      expect(p.lines.map((l) => l.addr), s.id).toEqual(a.lines.map((l) => 4 * l.addr));
      expect(p.lines.map((l) => l.text), s.id).toEqual(a.lines.map((l) => disasm4(l.word)));
      expect(p.lines.map((l) => l.srcLine), s.id).toEqual(a.lines.map((l) => l.srcLine));
    }
  });

  it('offers the samples with lang cpu4', () => {
    for (const s of PROGRAMS4) expect(ROM_SAMPLES.find((x) => x.id === s.id)).toEqual({ id: s.id, name: s.name, lang: 'cpu4', src: s.src });
  });

  it('a cpu4 ROM part compiles; its image and listing show disasm4', () => {
    const src = PROGRAMS4[0].src;
    const words = assemble4(src).words;
    const ref = { k: 8, w: 16 as const, addr: 'word' as const, lang: 'cpu4' as const, src };
    const d = partDef({ rom: ref }, () => undefined);
    expect('error' in d).toBe(false);
    if (!('error' in d)) expect(d.behavior!.eval([3], undefined)[0]).toBe(words[3]);
    const img = romImage(ref);
    expect(img.error).toBeNull();
    expect(img.lines[0].text).toBe(disasm4(words[0]));
    const rows = romListing(ref, img);
    expect(rows[0]).toMatchObject({ index: 0, addr: '[0]', word: words[0].toString(16).padStart(4, '0'), text: disasm4(words[0]) });
    expect(rows.every((r, i) => r.text === disasm4(words[i]))).toBe(true);
    expect(rows[0].text).toMatch(/^FIM\s+P0, 0x12$/);
    // a 16-bit hex ROM still lists no disassembly
    expect(romListing({ w: 16, addr: 'word', lang: 'hex' }, buildProgram('hex', '2012'))[0].text).toBe('');
    expect(partDef({ rom: { ...ref, w: 32 } }, () => undefined)).toEqual({ error: 'ROM: 4-bit CPU programs need 16-bit words, word addressed' });
    expect(partDef({ rom: { ...ref, w: 32, addr: 'rv32' } }, () => undefined)).toEqual({ error: 'ROM: 4-bit CPU programs need 16-bit words, word addressed' });
    expect(romImage({ ...ref, k: 2 }).error).toMatch(/do not fit/);
  });

  it('converts to hex and back for every sample', () => {
    for (const s of PROGRAMS4) {
      const words = assemble4(s.src).words;
      const hex = convertProgram(s.src, 'hex', 'cpu4')!;
      expect(hex.split('\n')[0]).toMatch(/^0x[0-9a-f]{4} {2}# /);
      expect(buildProgram('hex', hex).words, s.id).toEqual(words);
      const back = convertProgram(hex, 'cpu4', 'hex')!;
      expect(back.split('\n')[0]).toBe(`        .word 0x${words[0].toString(16).padStart(4, '0')}   # ${disasm4(words[0])}`);
      expect(buildProgram('cpu4', back).words, s.id).toEqual(words);
    }
    expect(convertProgram(PROGRAMS4[0].src, 'asm', 'cpu4')).toBeNull();
    expect(convertProgram(PROGRAMS4[0].src, 'rv16', 'cpu4')).toBeNull();
  });

  it('survives the store\'s sanitizer', () => {
    const chip = { id: 'u_c', name: 'c', pins: [], parts: [{ id: 'rom', ref: { rom: { k: 8, w: 16, addr: 'word', lang: 'cpu4', src: PROGRAMS4[0].src } }, at: [0, 0] }], wires: [], labels: [] };
    expect(sanitizeChip(chip)!.parts[0].ref).toEqual(chip.parts[0].ref);
  });
});

describe('cpu4asm tokenizer', () => {
  it('labels, mnemonics in any case, registers, pairs, conditions, numbers, comments', () => {
    expect(sig('loop:   FIM  P7, 0x00      ; port 0')).toEqual(['lbl:loop:', 'op:FIM', 'reg:P7', 'pun:,', 'num:0x00', 'com:; port 0']);
    expect(sig('  jcn tz, up # wait')).toEqual(['op:jcn', 'kw:tz', 'pun:,', 'sym:up', 'com:# wait']);
    expect(sig('ISZ R15, loop // delay')).toEqual(['op:ISZ', 'reg:R15', 'pun:,', 'sym:loop', 'com:// delay']);
    expect(sig('.word 0x1234, 7')).toEqual(['dir:.word', 'num:0x1234', 'pun:,', 'num:7']);
    expect(sig('.org 16')).toEqual(['dir:.org', 'num:16']);
    expect(sig('.text')[0]).toBe('bad:.text');
    expect(sig('add r1')).toEqual(['op:add', 'reg:r1']);
    expect(sig('LD R16')).toEqual(['op:LD', 'sym:R16']);
    expect(sig('SRC P8')).toEqual(['op:SRC', 'sym:P8']);
    expect(sig('mv R1')[0]).toBe('bad:mv'); // an RV32 mnemonic is not a 4-bit one
    expect(sig('JCN constructor, 0')[1]).toBe('sym:constructor');
  });

  it('every directive and instruction of the assembler is known, in any case', () => {
    for (const d of DIRECTIVES4) {
      expect(assemble4(d).errors.map((e) => e.message).join()).not.toMatch(/unknown instruction/);
      expect(sig(d)[0]).toBe(`dir:${d}`);
    }
    for (const i of INSTRS4) {
      expect(assemble4(i.name.toLowerCase()).errors.map((e) => e.message).join()).not.toMatch(/unknown instruction/);
      expect(sig(i.name)[0]).toBe(`op:${i.name}`);
      expect(sig(i.name.toLowerCase())[0]).toBe(`op:${i.name.toLowerCase()}`);
    }
    for (const c of Object.keys(JCN_NAMES)) expect(sig(`JCN ${c.toUpperCase()}, 0`)[1]).toBe(`kw:${c.toUpperCase()}`);
    for (let r = 0; r < 16; r++) expect(sig(`INC R${r}`)[1]).toBe(`reg:R${r}`);
    for (let p = 0; p < 8; p++) expect(sig(`JIN P${p}`)[1]).toBe(`reg:P${p}`);
  });

  it('tokens rebuild every line of every sample, with nothing flagged', () => {
    for (const s of PROGRAMS4) {
      for (const line of s.src.split('\n')) {
        const ts = tokenize(line, 'cpu4asm');
        expect(ts.map((t) => t.text).join('')).toBe(line);
        expect(ts.filter((t) => t.cls === 'bad'), `${s.id}: ${line}`).toEqual([]);
      }
    }
  });
});
