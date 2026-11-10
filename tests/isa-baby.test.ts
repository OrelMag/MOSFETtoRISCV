// The Baby's order code as a Custom ISA table (isa/presets.ts BABY_PRESET) against the golden model's assembler and
// disassembler (ssem/asm.ts, ssem/isa.ts): every function and line number, both ways.

import { describe, expect, it } from 'vitest';
import { isaOf, tableIsa } from '../src/isa/isa';
import { BABY_PRESET, ISA_PRESETS } from '../src/isa/presets';
import { IsaTable } from '../src/isa/table';
import { assembleSsem, ssemWords } from '../src/ssem/asm';
import { disasm, encode, fnOf, lineOf, MNEMONIC, usesLine } from '../src/ssem/isa';
import { kilburnSource } from '../src/ssem/programs';

const T = new IsaTable(BABY_PRESET);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('the Baby preset table', () => {
  it('has no problems and is listed beside the 4-bit one', () => {
    expect(T.problems).toEqual([]);
    expect(ISA_PRESETS.ssem).toBe(BABY_PRESET);
    expect(BABY_PRESET.wordBits).toBe(32);
  });

  it('disassembles every function with every line number as ssem/isa.ts does (digits 5-12 and 16-31 ignored)', () => {
    for (let f = 0; f < 8; f++) {
      for (let s = 0; s < 32; s++) {
        for (const junk of [0, 0xffff0000 | 0, 0x1fe0, 0x5555a0a0 & ~0xe01f & ~0x1fe0]) {
          const w = encode(f, s) | (junk & ~(0x7 << 13) & ~31);
          expect(norm(T.disasm(w)), `f${f} s${s} junk ${junk.toString(16)}`).toBe(disasm(w));
        }
      }
    }
  });

  it('assembles every instruction and line to the word assembleSsem makes', () => {
    for (let f = 0; f < 8; f++) {
      if (f === 5) continue; // function 5 is a second SUB: only reached by decoding
      const m = MNEMONIC[f];
      for (let s = 0; s < 32; s++) {
        const text = usesLine(f) ? `${m} ${s}` : m;
        const a = T.assemble(text);
        expect(a.errors, text).toEqual([]);
        expect(a.words[0], text).toBe(ssemWords(text)[0]);
        expect(a.words[0], text).toBe(encode(f, usesLine(f) ? s : 0));
        if (!usesLine(f)) break;
      }
    }
  });

  it('assembles its own disassembly back to the word for every instruction word', () => {
    for (let w = 0; w < 1 << 16; w++) {
      const t = T.disasm(w);
      const r = T.assemble(t);
      expect(r.errors, t).toEqual([]);
      const f = fnOf(w);
      expect(r.words[0], t).toBe(encode(f === 5 ? 4 : f, usesLine(f) ? lineOf(w) : 0));
    }
  });

  it('assembles Kilburn\'s routine (labels and .org for the line numbers) to the same 32 words', () => {
    const src = kilburnSource(60);
    const ref = assembleSsem(src);
    expect(ref.errors).toEqual([]);
    // the same program in table syntax: each statement at its line, NUM as .word
    const rows: string[] = [];
    for (const l of ref.lines) {
      rows.push(`.org ${l.line}`);
      const t = l.text.trim();
      rows.push(/^(NUM|\.NUM)\s/i.test(t) ? t.replace(/^\.?NUM/i, '.word') : t.replace(/^STOP$|^HLT$/i, 'STP'));
    }
    const a = T.assemble(rows.join('\n'));
    expect(a.errors).toEqual([]);
    const words = Array.from({ length: 32 }, (_, i) => a.words[i] ?? 0);
    expect(words).toEqual(ref.words);
  });

  it('errors where the Baby assembler does: a missing or extra line number, a line past the store', () => {
    for (const src of ['JMP', 'CMP 3', 'LDN 32', 'FOO 1']) {
      expect(T.assemble(src).errors.length, src).toBe(1);
      expect(assembleSsem(src).errors.length, src).toBe(1);
    }
  });

  it('fields: function and line number, as wide as the word; reachable through isaOf', () => {
    expect(T.fields(encode(3, 9)).reduce((n, f) => n + f.bits, 0)).toBe(32);
    expect(T.fields(encode(3, 9)).filter((f) => f.kind === 'op')[0].value).toBe(3);
    const isa = isaOf('isa', BABY_PRESET)!;
    expect(isa.wordBits).toBe(32);
    expect(tableIsa(BABY_PRESET).words.mnemonics).toEqual(['JMP', 'JRP', 'LDN', 'STO', 'SUB', 'CMP', 'STP']);
  });
});
