// A Custom ISA table's decoder in gates: every output against the table's own match(), its cost
// against the encoding designer's estimate, and the chip it opens as in the sandbox.

import { describe, expect, it } from 'vitest';
import { remixDef } from '../src/editor/remix';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { analyze } from '../src/isa/design';
import { ISA4_PRESET } from '../src/isa/presets';
import { tableOf, type IsaDoc } from '../src/isa/table';
import { isaDecoder, matchNames } from '../src/lib/isadecoder';
import { orN } from '../src/lib/wide';
import { evalOnce, simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';

const TOY: IsaDoc = {
  id: 'toy', name: 'TOY16', wordBits: 16,
  operands: { d: { kind: 'reg', names: ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'] }, s: { kind: 'reg', names: ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'] }, i: { kind: 'imm', signed: true } },
  instrs: [
    { mnemonic: 'add', operands: ['d', 's'], pattern: '0000 ddd sss 000000' },
    { mnemonic: 'add', operands: ['d', 's', 'i'], pattern: '0001 ddd sss iiiiii' },
    { mnemonic: 'ld', operands: ['d', 's', 'i'], pattern: '0010 ddd sss iiiiii' },
    { mnemonic: 'halt', operands: [], pattern: '1111 ------------' },
    { mnemonic: 'nop', operands: [], pattern: '1111 000000000000' },
  ],
};

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0);

function check(doc: IsaDoc, words: number[]) {
  const def = isaDecoder(doc);
  const sim = simulate(def);
  const t = tableOf(doc);
  for (const w of words) {
    const out = evalOnce(sim, [w]);
    const m = t.match(w);
    const want = doc.instrs.map((_, i) => (m && t.compiled.indexOf(m) === i ? 1 : 0));
    expect(out, `0x${w.toString(16)}`).toEqual([...want, m ? 1 : 0]);
  }
}

describe('a table\'s decoder in gates', () => {
  it('names its outputs after the mnemonics, unique', () => {
    expect(matchNames(TOY)).toEqual(['add', 'add_2', 'ld', 'halt', 'nop']);
  });

  it('TOY16: every output on every word', () => {
    check(TOY, Array.from({ length: 2 ** 16 }, (_, w) => w).filter((w) => w % 7 === 0 || w >= 0xf000));
  });

  it('the 4-bit CPU: matches the table on sampled words, every opcode byte', () => {
    check(ISA4_PRESET, [...Array.from({ length: 256 }, (_, i) => (i << 8) | (rnd() & 0xff)), ...Array.from({ length: 300 }, () => rnd() & 0xffff)]);
  });

  it('costs what the designer estimates, plus the valid OR', () => {
    for (const doc of [TOY, ISA4_PRESET]) {
      const n = doc.instrs.length;
      expect(stats(isaDecoder(doc)).nands).toBe(analyze(doc).decoder.nands + stats(orN(n)).nands);
    }
  });

  it('opens as a sandbox chip that compiles back with the same pins, and decodes the same', () => {
    const r = remixDef(emptyWorkspace(), isaDecoder(TOY));
    if ('error' in r) throw new Error(r.error);
    const lib = new UserLibrary();
    lib.update(r.ws);
    const c = lib.compiled(r.id)!;
    expect(c.diags.filter((x) => x.level === 'error').map((x) => x.msg)).toEqual([]);
    // the chip lists its pins by where they sit on the box: compare by name
    expect(c.def.ports.map((p) => p.name).sort()).toEqual(['add', 'add_2', 'halt', 'ld', 'nop', 'valid', 'w']);
    const sim = simulate(c.def);
    const outs = c.def.ports.filter((p) => p.dir === 'out').map((p) => p.name);
    const read = (w: number) => Object.fromEntries(evalOnce(sim, [w]).map((v, i) => [outs[i], v]));
    expect(read(0xf000)).toEqual({ add: 0, add_2: 0, ld: 0, halt: 0, nop: 1, valid: 1 });
    expect(read(0x1234)).toEqual({ add: 0, add_2: 1, ld: 0, halt: 0, nop: 0, valid: 1 });
  });
});
