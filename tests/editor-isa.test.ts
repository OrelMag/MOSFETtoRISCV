// Custom ISAs in the sandbox: tables in the workspace and copied into the ROMs that use them, a ROM
// part assembling with its table, storage and share round trips, hex conversion, the highlighter,
// and the CPU drawer following (not checking) a CPU whose ROM holds a custom table.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { Cpu4Monitor, detectCpu4 } from '../src/editor/cpu4mon';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { copyIsa, deleteIsa, isaById, isaList, isaUses, putIsa } from '../src/editor/isaops';
import { UserLibrary } from '../src/editor/library';
import { convertProgram, romImage, romListing, type RomRef } from '../src/editor/memory';
import { emptyWorkspace, type Workspace } from '../src/editor/model';
import { isError, partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { migrate } from '../src/editor/store';
import { BCD4 } from '../src/isa4/programs4';
import { assemble4 } from '../src/isa4/asm4';
import { ISA4_PRESET } from '../src/isa/presets';
import { type IsaDoc, sanitizeIsa } from '../src/isa/table';
import { tokenize } from '../src/widgets/codetok';

/** The 4-bit example with its ROM switched to a copy of the 4-bit preset (as "New instruction set…" does). */
function exampleOnTable(): { ws: Workspace; id: string; isa: IsaDoc } {
  const ex = addExample(emptyWorkspace(), EXAMPLES.find((e) => e.id === 'cpu4')!);
  const c = copyIsa(ex.ws, ISA4_PRESET, 'My 4-bit ISA');
  const isa = c.ws.isas![c.id];
  const chip = c.ws.chips[ex.id];
  const parts = chip.parts.map((p) => (p.id === 'rom' && 'rom' in p.ref ? { ...p, ref: { rom: { ...p.ref.rom, lang: 'isa' as const, isa } } } : p));
  return { ws: { ...c.ws, chips: { ...c.ws.chips, [ex.id]: { ...chip, parts } } }, id: ex.id, isa };
}

const romOf = (ws: Workspace, chip: string): RomRef => {
  const p = ws.chips[chip].parts.find((q) => q.id === 'rom')!;
  if (!('rom' in p.ref)) throw new Error('no rom');
  return p.ref.rom;
};

describe('custom ISAs in the workspace', () => {
  it('copies a preset, lists it, and finds the ROMs that hold it', () => {
    const { ws, id, isa } = exampleOnTable();
    expect(isa.id).toBe('isa_my_4_bit_isa');
    expect(isaList(ws).map((d) => d.name)).toEqual(['My 4-bit ISA']);
    expect(isaUses(ws, isa.id)).toEqual([{ chip: id, part: 'rom' }]);
    expect(isaById(ws, 'cpu4')).toBe(ISA4_PRESET);
    expect(copyIsa(ws, isa).id).toBe('isa_my_4_bit_isa_copy');
  });

  it('an edit reaches every ROM that holds the table, word width included', () => {
    const { ws, id, isa } = exampleOnTable();
    const renamed = { ...isa, name: 'Renamed', instrs: [...isa.instrs, { mnemonic: 'SWAP', operands: ['p'], pattern: '0011 ppp0 --------' }] };
    const next = putIsa(ws, renamed);
    expect(romOf(next, id).isa).toBe(renamed);
    expect(next.isas![isa.id].name).toBe('Renamed');
    const wide = putIsa(ws, { ...isa, wordBits: 32 });
    expect(romOf(wide, id).w).toBe(32);
    // Other chips are the same objects (nothing to recompile there).
    for (const k of Object.keys(ws.chips)) if (k !== id) expect(next.chips[k]).toBe(ws.chips[k]);
  });

  it('deleting a table from the list leaves the ROMs their copy (still listed while one holds it)', () => {
    const { ws, id, isa } = exampleOnTable();
    const next = deleteIsa(ws, isa.id);
    expect(next.isas).toBeUndefined();
    expect(romOf(next, id).isa).toEqual(isa);
    expect(isaList(next).map((d) => d.id)).toEqual([isa.id]);
  });
});

describe('a ROM on a custom table', () => {
  const isa: IsaDoc = { ...structuredClone(ISA4_PRESET), id: 'isa_t', name: 'T' };
  const rom: RomRef = { k: 8, w: 16, addr: 'word', lang: 'isa', src: BCD4, isa };

  it('assembles with its table: the 4-bit words, its disassembly in the listing', () => {
    const img = romImage(rom);
    expect(img.problems).toEqual([]);
    expect(img.words).toEqual(assemble4(BCD4).words);
    expect(romListing(rom, img).at(-1)!.text).toBe('JUN  0x25');
    const d = partDef({ rom }, () => undefined);
    expect(isError(d)).toBe(false);
    if (!isError(d)) expect(d.behavior!.eval([0x25], undefined)[0]).toBe(0x4025);
  });

  it('refuses a ROM without its table or with another word width', () => {
    expect(partDef({ rom: { ...rom, isa: undefined } }, () => undefined)).toMatchObject({ error: expect.stringMatching(/no instruction set/) });
    expect(partDef({ rom: { ...rom, w: 32 } }, () => undefined)).toMatchObject({ error: expect.stringMatching(/16-bit words/) });
  });

  it('converts to hex words and back', () => {
    const hex = convertProgram(BCD4, 'hex', 'isa', isa)!;
    expect(hex.split('\n')[0]).toMatch(/^0x2012 {2}# FIM {2}P0, 0x12/);
    const back = convertProgram(hex, 'isa', 'hex', isa)!;
    expect(romImage({ ...rom, src: back }).words).toEqual(assemble4(BCD4).words);
    expect(back.split('\n')[0]).toMatch(/\.word 0x2012 {3}# FIM {2}P0, 0x12/);
  });

  it('highlights with the table: mnemonics, registers, list names, labels', () => {
    const sig = (line: string) => tokenize(line, { table: isa }).filter((t) => t.text.trim()).map((t) => `${t.cls}:${t.text.trim()}`);
    expect(sig('loop: isz R3, loop ; count')).toEqual(['lbl:loop:', 'op:isz', 'reg:R3', 'pun:,', 'sym:loop', 'com:; count']);
    expect(sig('  JCN TZ, 0x10')).toEqual(['op:JCN', 'kw:TZ', 'pun:,', 'num:0x10']);
    expect(sig('  BOGUS 1')).toEqual(['bad:BOGUS', 'num:1']);
  });
});

describe('storage', () => {
  it('keeps the workspace tables and each ROM\'s copy; drops a malformed one', () => {
    const { ws, id, isa } = exampleOnTable();
    const back = migrate(JSON.parse(JSON.stringify(ws))) as Workspace;
    expect(back.isas).toEqual(ws.isas);
    expect(romOf(back, id)).toEqual(romOf(ws, id));
    const bad = JSON.parse(JSON.stringify(ws));
    bad.isas.junk = { id: 'junk', name: 'x', wordBits: 12, operands: {}, instrs: [] };
    expect(Object.keys((migrate(bad) as Workspace).isas!)).toEqual([isa.id]);
    expect(sanitizeIsa({ ...isa, operands: { r: { kind: 'nope' } } })).toBeNull();
    expect(sanitizeIsa(isa)).toEqual(isa);
  });
});

describe('the CPU drawer on a custom table', () => {
  it('follows the program the ROM reads (listing, PC), without a golden model', () => {
    const { ws, id, isa } = exampleOnTable();
    expect(detectCpu4(ws.chips[id])).toEqual({ rom: 'rom', table: isa });
    const lib = new UserLibrary(ws);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(lib.compiled(id)!, ws.chips[id].pins);
    const mon = new Cpu4Monitor(es, () => ws.chips[id], () => ws.chips);
    expect(mon.checking).toBe(false);
    expect(mon.problem).toMatch(/custom instruction set/);
    es.runCycles(5);
    expect(mon.pc).toBe(5);
    expect(mon.isa.disasm(mon.wordAt(5)!)).toBe('LD   R3');
    expect(mon.describe(0x8b00)).toMatch(/A ← A \+ r \+ CY/);
    expect(mon.mismatch).toBeNull();
  });
});
