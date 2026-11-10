// The sandbox's memories, on screen: the Memory palette group, the ROM's properties (size,
// addressing, language, samples, a live listing) and its program editor, the RAM's live
// contents and initial contents, and the Examples menu. Everything plugs in through the
// editor's registries; values are read from the running simulation once per frame while the
// element showing them is on the page.

import '../styles/memui.css';
import { BANK_K, kWords, ramLeafState, ramWord } from '../lib/bigmem';
import { BX, type Bit } from '../sim/types';
import { memRow } from '../view/memview';
import { h, icon, rememberFocus } from '../ui/dom';
import { codeEditor } from '../widgets/codeedit';
import type { CodeLang } from '../widgets/codetok';
import { type Editor, registerToolbarAction } from './editor';
import {
  addrValue, convertProgram, initText, type ListingRow, parseInit, readRam, ROM_SAMPLES, romImage, romIndex, romListing, type RomRef, sampleK,
} from './memory';
import { customizable16 } from './cpu16';
import type { PartDoc } from './model';
import { setRef } from './ops';
import { portCoreOf, portCoreRef } from './model';
import { CORE64, DMEM64_DEFAULT, DMEM64_MAX, DMEM64_MIN, setCore64Memory } from './rv64mon';
import { registerPaletteGroup } from './palette';
import { RV64_SOURCE, RVC_SOURCE } from './exampleisa';
import { MAX_ROM_K } from './parts';
import { registerPropsSection } from './props';
import type { ProgramLang } from './program';
import { ISA4_PRESET, ISA_PRESETS, PDP8_PRESET } from '../isa/presets';
import { copyIsa, isaById, isaList } from './isaops';
import { openIsaEditor } from './isaui';
import { virtualRows } from './vlist';
import { loadDeckIntoRom, pickDeck, saveRomDeck } from './cardui';
import { romComposer } from './romcompose';
import { romTiles } from './romtiles';

/** Each program language: its name, the code editor's highlighter, and the ROM shape it needs (RV16 and the
 *  4-bit CPU: 16-bit words, word addressed; RV32 assembly: 32-bit words). */
const LANGS: Record<ProgramLang, { name: string; code: CodeLang; shape: Partial<Pick<RomRef, 'w' | 'addr'>> }> = {
  asm: { name: 'RISC-V assembly', code: 'rvasm', shape: { w: 32 } },
  rv16: { name: 'RV16 assembly', code: 'rv16asm', shape: { w: 16, addr: 'word' } },
  cpu4: { name: '4-bit CPU assembly', code: 'cpu4asm', shape: { w: 16, addr: 'word' } },
  dsp24: { name: 'DSP24 assembly', code: 'dsp24asm', shape: { w: 24, addr: 'word' } },
  '6502': { name: '6502 assembly', code: 'm6502asm', shape: { w: 8, addr: 'word' } },
  hex: { name: 'hex words', code: 'hex', shape: {} },
  isa: { name: 'custom instruction set', code: 'hex', shape: { addr: 'word' } },
};

/** A ROM's highlighter and language name: a custom instruction set's from its table. */
const codeOf = (r: Pick<RomRef, 'lang' | 'isa'> & Partial<Pick<RomRef, 'custom' | 'custom16' | 'mac'>>): CodeLang => {
  if (r.lang === 'isa' && r.isa) return { table: r.isa };
  // the core's own instructions (the ROM's copy of its rows) highlight as instructions: they assemble
  if (r.lang === 'asm' && r.custom?.length) return { base: r.mac ? 'rvmacasm' : 'rvasm', ops: r.custom.map((c) => c.name) };
  if (r.lang === 'rv16' && r.custom16?.length) return { base: 'rv16asm', ops: r.custom16.map((c) => c.name) };
  return LANGS[r.lang].code;
};
const langName = (r: Pick<RomRef, 'lang' | 'isa'>) => (r.lang === 'isa' && r.isa ? r.isa.name : LANGS[r.lang].name);

// ---- palette -------------------------------------------------------------------------------

const FIB = ROM_SAMPLES.find((s) => s.id === 'fib')!.src;
const DSP_FIR = ROM_SAMPLES.find((s) => s.id === 'dsp24_fir16')!.src;
const WALK = '# one hex word per entry; @n moves to word n\n01 02 04 08 10 20 40 80';

registerPaletteGroup({
  id: 'memory', title: 'Memory', order: 55, collapsed: true,
  items: () => [
    { id: 'prog_rom', name: 'Program ROM (RV32)', title: '64 words of 32 bits, byte addressed like a PC, holding a RISC-V program (Edit program… in the properties)',
      place: { part: { rom: { k: 6, w: 32, addr: 'rv32', lang: 'asm', src: FIB } } } },
    { id: 'rom_words', name: 'ROM (words)', tag: '16×8', title: 'A word-addressed ROM written as hex words: a lookup table (fonts, decoders, constants)',
      place: { part: { rom: { k: 4, w: 8, addr: 'word', lang: 'hex', src: WALK } } } },
    { id: 'ram', name: 'RAM', tag: '16×8', title: 'Read-write memory: a decoder, one register per word and a multiplexer tree (contents live in the properties)',
      place: { part: { ram: { k: 4, w: 8 } } } },
  ],
});

// The cores that take their program from a ROM part (memory port or inside): a computer is a core, a ROM and a RAM.
registerPaletteGroup({
  id: 'cores', title: 'Processor cores', order: 56, collapsed: true,
  items: () => [
    { id: 'core_rv32', name: 'RV32I core', title: 'The single-cycle RV32I core with a memory port: instr in (from a Program ROM), pcOut and memAddr / memWData / memWE out, memRData in. The CPU drawer follows it.', place: { part: { lib: 'rv32i_core' } } },
    { id: 'core_rv32p', name: 'RV32I pipelined core', title: 'The five-stage pipelined RV32I core on the same two ports: instr in, pcOut and memAddr / memWData / memWE out of the M stage, memRData in; retire = an instruction reaches W. Forwarding, load-use stalls and branch flushes inside. The CPU drawer follows it with the pipeline diagram; Custom… applies to it.', place: { part: { lib: 'rv32i_pipe_core' } } },
    { id: 'core_rv32pm', name: 'RV32IM pipelined core', title: 'The pipelined core with the M extension: a multiply takes a stage more (it behaves like a load for hazards), a divide stalls the front of the pipeline for 18 cycles; retire = 0 meanwhile. Program ROM: mul / div mnemonics assemble.', place: { part: { lib: 'rv32im_pipe_core' } } },
    { id: 'core_rv32pd', name: 'RV32I pipelined core + D-cache', title: 'The pipelined core with a write-through data cache (4 lines of 4 words) in its M stage, in front of the memory port: a load miss freezes the pipeline for 8 cycles while the line is read over the port. Addresses with bit 31 set (the console, LEDs, switches, screen) bypass the cache.', place: { part: { lib: 'rv32i_pipe_dc_core' } } },
    { id: 'core_rv32pc', name: 'RV32IC pipelined core', title: 'The pipelined core with the C extension: F fetches the 32 bits at the PC (any even address) and expands a 16-bit instruction before it enters D, the PC goes up by 2 after one. Hazards and forwarding are unchanged. Its Program ROM needs the C extension ticked.', place: { part: { lib: 'rv32ic_pipe_core' } } },
    { id: 'core_rv32c', name: 'RV32IC core', title: 'RV32I with the C extension: 16-bit instructions expanded inside, PC + 2. Its Program ROM needs the C extension ticked: it answers at any even address.', place: { part: { lib: 'rv32ic_core' } } },
    { id: 'core_rv32v', name: 'RV32I + vector core', title: 'The CPU of the Vectors chapter: the single-cycle core with the vector unit (four lanes, VLEN 128, e32, LMUL 1 to 8) and a data memory of 64 words in four banks inside. instr in from a Program ROM, pcOut out; retire = 0 while a vector instruction runs its beats. The CPU drawer checks v0–v31 against the golden model.', place: { part: { lib: 'rv32iv_core' } } },
    { id: 'core_rv64', name: 'RV64I core', title: 'The 64-bit core: 64-bit PC, registers and ALU, W instructions, data memory of 64 doublewords inside (Properties: 16 to 256). Program ROM: tick RV64. The CPU drawer shows all 64 bits.', place: { part: { lib: 'rv64i_core' } } },
    { id: 'core_rv64m', name: 'RV64IM core', title: 'The 64-bit core with the M extension (multiply, divide: retire = 0 while a divide runs). Program ROM: tick RV64.', place: { part: { lib: 'rv64im_core' } } },
    { id: 'core_dsp24', name: 'DSP core', title: 'The DSP core without its memories: instr in (from a Program ROM in DSP24 assembly), pc out; X and Y read on xaddr / xdata and yaddr / ydata, a store puts a word on wdata with xwe or ywe; out / outv send results, halt stops. Two RAM parts of 256 × 16 are its X and Y memories. The CPU drawer follows it.', place: { part: { lib: 'dsp24_core' } } },
    { id: 'prog_rom_dsp24', name: 'Program ROM (DSP24)', title: '256 words of 24 bits, word addressed, holding a DSP24 program (the FIR filter to start from; the benchmarks are in Edit program… ▸ samples)', place: { part: { rom: { k: 8, w: 24, addr: 'word', lang: 'dsp24', src: DSP_FIR } } } },
    { id: 'prog_rom_c', name: 'Program ROM (RV32C)', title: 'A Program ROM with the C extension ticked: reads at any even address, assembles .option rvc and c.* mnemonics', place: { part: { rom: { k: 6, w: 32, addr: 'rv32', lang: 'asm', src: RVC_SOURCE, c: true } } } },
    { id: 'prog_rom_64', name: 'Program ROM (RV64)', title: 'A Program ROM assembled for RV64: ld, sd, the W instructions, li of any 64-bit constant', place: { part: { rom: { k: 6, w: 32, addr: 'rv32', lang: 'asm', src: RV64_SOURCE, xlen: 64 } } } },
  ],
});

// ---- helpers -------------------------------------------------------------------------------

/** The one selected part, when exactly one object is selected. */
function selectedPart(ed: Editor): PartDoc | null {
  if (ed.selCount !== 1 || !ed.sel.parts?.length) return null;
  return ed.doc.parts.find((p) => p.id === ed.sel.parts![0]) ?? null;
}

/** Run `f` once per frame while `el` is on the page (it starts detached: give it a moment). */
function live(el: HTMLElement, f: () => void): void {
  let seen = false, waited = 0;
  const tick = () => {
    if (el.isConnected) {
      seen = true;
      f();
    } else if (seen || ++waited > 120) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function setRom(ed: Editor, id: string, patch: Partial<RomRef>): void {
  const p = ed.doc.parts.find((q) => q.id === id);
  if (!p || !('rom' in p.ref)) return;
  const r = setRef(ed.doc, id, { rom: { ...p.ref.rom, ...patch } }, ed.defOf);
  if (r.reason) return void ed.toast(r.reason, 'err');
  ed.edit(() => r.doc);
}

/** The word the ROM part reads right now (null: unknown or not simulated). */
function romNow(ed: Editor, id: string, r: RomRef): number | null {
  const a = addrValue(ed.sim.endBits(`p:${id}.addr`));
  return a === null ? null : romIndex(r, a);
}

function select<T extends string | number>(value: T, options: [T, string][], commit: (v: T) => void, label: string): HTMLSelectElement {
  const s = h('select', { 'aria-label': label }, options.map(([v, l]) => h('option', { value: String(v), selected: v === value }, l))) as HTMLSelectElement;
  s.addEventListener('change', () => commit(options.find(([v]) => String(v) === s.value)![0]));
  return s;
}

/** A small number per object (a RAM leaf's state: a new one after a reset, a rebuild or Back). */
const ids = new WeakMap<object, number>();
let nextId = 0;
const objectId = (o: object) => ids.get(o) ?? (ids.set(o, ++nextId), nextId);

const row = (label: string, ctl: Node, hint?: string) => h('label', { class: 'sb-row', title: hint ?? null }, h('span', null, label), ctl);

/**
 * A listing table (address · word · disassembly) whose current row can be set cheaply. Only the
 * rows in view are built (vlist.ts): a 64K-word program is one screenful of DOM rows.
 */
function listingTable(rows: ListingRow[], onRow?: (r: ListingRow) => void, errLines?: Set<number>): { el: HTMLElement; setCurrent(i: number | null): void } {
  let cur: number | null = null;
  const make = (i: number) => {
    const r = rows[i];
    const cls = [errLines?.has(r.srcLine) ? 'err' : '', i === cur ? 'cur' : ''].join(' ').trim();
    const tr = h('tr', { 'data-row': String(r.index), class: cls || null, title: r.srcLine ? `source line ${r.srcLine}` : '' },
      h('td', { class: 'a' }, r.addr), h('td', { class: 'w' }, r.word), h('td', { class: 'd' }, r.text));
    if (onRow) tr.addEventListener('click', () => onRow(r));
    return tr;
  };
  const body = h('tbody');
  const el = h('div', { class: 'sb-rom-list' }, rows.length ? h('table', { class: 'asm-table' }, body) : h('p', { class: 'sb-sum' }, 'Empty: every word reads as the fill value.'));
  const list = rows.length ? virtualRows({ count: rows.length, el, body, row: make }) : null;
  return {
    el,
    setCurrent(i) {
      if (i === cur || !list) return;
      if (cur !== null) list.built.get(cur)?.classList.remove('cur');
      cur = i;
      if (i === null) return;
      list.built.get(i)?.classList.add('cur');
      // Keep the row in view inside the list only (scrollIntoView would scroll the page too).
      list.reveal(i);
    },
  };
}

const usage = (img: ReturnType<typeof romImage>) => `${img.words.length} of ${img.capacity} words`;

// ---- ROM properties ------------------------------------------------------------------------

registerPropsSection({
  id: 'rom', order: 20,
  render(ed) {
    const p = selectedPart(ed);
    if (!p || !('rom' in p.ref)) return null;
    const id = p.id;
    const r = p.ref.rom;
    const img = romImage(r);
    const rows = romListing(r, img);
    const set = (patch: Partial<RomRef>) => setRom(ed, id, patch);

    // by language, this ROM's own first
    const langs = [...new Set([r.lang, ...ROM_SAMPLES.map((s) => s.lang)])].filter((l) => ROM_SAMPLES.some((s) => s.lang === l));
    const sample = h('select', { 'aria-label': 'Load a sample program' },
      h('option', { value: '' }, 'Load a sample…'),
      langs.map((l) => h('optgroup', { label: LANGS[l].name }, ROM_SAMPLES.filter((s) => s.lang === l).map((s) => h('option', { value: s.id }, s.name))))) as HTMLSelectElement;
    sample.addEventListener('change', () => {
      const s = ROM_SAMPLES.find((x) => x.id === sample.value);
      if (!s) return;
      // RV32 assembly needs 32-bit words, RV16 and the 4-bit CPU 16-bit word-addressed ones; the ROM grows to hold the sample (never shrinks).
      set({ lang: s.lang, src: s.src, k: Math.max(r.k, sampleK(s.lang, s.src)), ...LANGS[s.lang].shape });
    });

    // a table's ROM has its table's width (12 bits: the PDP-8's), listed so the menu shows it
    const width = select(r.w, [[8, '8 bits'], ...(r.w === 12 ? [[12, '12 bits'] as [RomRef['w'], string]] : []), [16, '16 bits'], [32, '32 bits']] as [RomRef['w'], string][], (w) => set({ w }), 'Word width');
    width.disabled = r.addr === 'rv32';
    const status = img.problems.length
      ? h('div', { class: 'sb-rom-err' }, h('b', null, `${img.problems.length} problem${img.problems.length > 1 ? 's' : ''}: the ROM is not built`),
        img.problems.slice(0, 3).map((e) => h('div', null, e.line ? `line ${e.line}: ${e.message}` : e.message)))
      : h('p', { class: 'sb-sum' }, `${usage(img)} used${r.addr === 'rv32' ? ' · unused words read as NOP' : ''}`);
    const list = listingTable(rows, () => openProgramEditor(ed, id), new Set(img.problems.map((e) => e.line)));
    const now = h('p', { class: 'sb-rom-now' });

    const out = h('section', { class: 'sb-sec-props sb-rom' },
      h('h3', null, 'Program'),
      row('Words', select(r.k, Array.from({ length: MAX_ROM_K }, (_, i): [number, string] => [i + 1, kWords(2 ** (i + 1))]), (k) => set({ k }), 'Words'), '2^k words'),
      row('Width', width, r.addr === 'rv32' ? 'Byte addressing reads 32-bit instructions' : 'Bits per word'),
      row('Address', select(r.addr, [['word', 'word index'], ['rv32', 'byte (RV32 PC)']], (addr) => set(addr === 'rv32' ? { addr, w: 32 } : { addr }), 'Addressing'),
        'word: addr is the word number (k bits). byte: a 32-bit address like a PC, word = addr / 4'),
      row('Language', languageSelect(ed, id, r, set), 'Switching converts the program when it builds (RV16, 4-bit CPU: 16-bit words, word addressed; a custom instruction set: its word width)'),
      ...(r.lang === 'asm' && r.addr === 'rv32' && r.w === 32 ? [row('Extensions', h('span', { class: 'sb-exts' },
        h('label', { class: 'sb-check', title: 'C: the ROM answers at any even address with the 32 bits starting there; .option rvc and c.* mnemonics assemble to 16-bit instructions. Needs the RV32C core (rv32ic_core).' },
          h('input', { type: 'checkbox', checked: !!r.c, 'aria-label': 'C extension', onchange: (e: Event) => set((e.target as HTMLInputElement).checked ? { c: true, xlen: undefined } : { c: undefined }) }), 'C extension'),
        h('label', { class: 'sb-check', title: 'RV64: assemble for the 64-bit core (ld, sd, the W instructions, li of any 64-bit constant, 6-bit shifts). Needs rv64i_core or rv64im_core.' },
          h('input', { type: 'checkbox', checked: r.xlen === 64, 'aria-label': 'RV64', onchange: (e: Event) => set((e.target as HTMLInputElement).checked ? { xlen: 64, c: undefined } : { xlen: undefined }) }), 'RV64'))
        , 'C: 16-bit instructions at any even address (rv32ic_core). RV64: assemble for the 64-bit cores')] : []),
      row('Sample', sample),
      status,
      h('div', { class: 'sb-btns' }, h('button', { class: 'btn sm primary', title: 'Edit the program with a live listing', onclick: () => openProgramEditor(ed, id) }, icon('code', 14), 'Edit program…'),
        h('button', { class: 'btn sm', title: 'Download the program as a deck of punched cards (.deck.json): one card a word, printed with its source line', onclick: () => saveRomDeck(ed, id) }, 'Save as deck'),
        h('button', { class: 'btn sm', title: 'Replace the program with the words of a deck of cards (as hex, each card’s print a comment); a .deck.json dropped on the canvas does it too', onclick: () => void pickDeck(ed).then((d) => d && loadDeckIntoRom(ed, id, d)) }, 'Load deck…'),
        // a ROM in the PDP-8 table: its program runs on the PDP-8's model behind a front panel (loaded on the click)
        r.lang === 'isa' && r.isa?.id === PDP8_PRESET.id ? h('button', { class: 'btn sm', title: 'Run this program on a PDP-8 with its front panel: lamps, switches, LOAD ADD, DEP, EXAM, START',
          onclick: () => void import('./pdp8panel').then((p) => p.openPdp8Panel(ed, id)) }, 'Front panel…') : null),
      now, list.el);

    let key = '';
    live(out, () => {
      let i = romNow(ed, id, r);
      if (r.c && i !== null) {
        // with C the listing has a row an instruction: find the one at this byte address
        const a = addrValue(ed.sim.endBits(`p:${id}.addr`));
        const at = a === null ? undefined : (a & ~1) % (4 * 2 ** r.k);
        i = at === undefined ? null : img.lines.findIndex((x) => x.addr === at);
      }
      const k = String(i);
      if (k === key) return;
      key = k;
      list.setCurrent(i !== null && i >= 0 ? i : null);
      const l = i === null || i < 0 ? undefined : img.lines[i];
      now.replaceChildren(i === null
        ? h('span', null, 'Address unknown (not connected or X)')
        : h('span', null, 'Reading ', h('b', null, r.addr === 'rv32' ? `0x${(r.c && l ? l.addr : 4 * i).toString(16).padStart(4, '0')}` : rows[i]?.addr ?? `[${i}]`), ' → ',
          h('code', null, !l ? (r.addr === 'rv32' ? 'nop (fill)' : '0 (fill)') : r.w === 32 || r.lang === 'cpu4' || r.lang === 'dsp24' || r.lang === 'isa' || (r.lang === '6502' && l.text) ? l.text : `0x${(l.word >>> 0).toString(16).padStart(r.w / 4, '0')}`)));
    });
    return out;
  },
});

/** A ROM's Language: the built-in languages, the workspace's instruction sets, and the ISA editor. */
function languageSelect(ed: Editor, partId: string, r: RomRef, set: (patch: Partial<RomRef>) => void): HTMLSelectElement {
  const cur = r.lang === 'isa' && r.isa ? `isa:${r.isa.id}` : r.lang;
  const isas = isaList(ed.ws);
  const sel = h('select', { 'aria-label': 'Language' },
    (['asm', 'rv16', 'cpu4', 'dsp24', '6502', 'hex'] as const).map((l) => h('option', { value: l, selected: cur === l }, LANGS[l].name)),
    isas.length ? h('optgroup', { label: 'Instruction sets' }, isas.map((d) => h('option', { value: `isa:${d.id}`, selected: cur === `isa:${d.id}` }, d.name))) : null,
    // the shipped tables (the 4-bit CPU's, the PDP-8's) the workspace does not hold yet
    h('optgroup', { label: 'Preset instruction sets' }, Object.values(ISA_PRESETS).filter((d) => !isas.some((i) => i.id === d.id)).map((d) => h('option', { value: `isa:${d.id}`, selected: cur === `isa:${d.id}` }, d.name))),
    h('optgroup', { label: 'Custom ISA' },
      r.lang === 'isa' && r.isa ? h('option', { value: '__edit' }, `Edit ${r.isa.name}…`) : null,
      h('option', { value: '__new' }, 'New instruction set…'))) as HTMLSelectElement;
  sel.addEventListener('change', () => {
    const v = sel.value;
    sel.value = cur;
    if (v === '__edit' && r.isa) return openIsaEditor(ed, r.isa.id);
    if (v === '__new') {
      // A copy of the 4-bit preset, used by this ROM at once, opened for editing.
      const from = r.lang === 'isa' && r.isa ? r.isa : ISA4_PRESET;
      let made = '';
      ed.editWs((ws) => {
        const c = copyIsa(ws, from, r.lang === 'isa' ? undefined : 'My instruction set');
        made = c.id;
        const doc = c.ws.isas![c.id];
        const chip = c.ws.chips[ed.chipId];
        const parts = chip.parts.map((p) => (p.id === partId && 'rom' in p.ref ? { ...p, ref: { rom: { ...p.ref.rom, lang: 'isa' as const, isa: doc, w: doc.wordBits, addr: 'word' as const } } } : p));
        return { ...c.ws, chips: { ...c.ws.chips, [ed.chipId]: { ...chip, parts } } };
      });
      return openIsaEditor(ed, made);
    }
    if (v.startsWith('isa:')) {
      const doc = isaById(ed.ws, v.slice(4));
      if (!doc) return;
      const src = r.lang === 'hex' || r.lang === 'isa' ? convertProgram(r.src, 'isa', r.lang, r.lang === 'hex' ? doc : r.isa) : null;
      // From another table, the text stays: the same mnemonics may still assemble.
      return set({ lang: 'isa', isa: doc, w: doc.wordBits, addr: 'word', ...(src !== null && r.lang === 'hex' ? { src } : {}) });
    }
    const lang = v as ProgramLang;
    const src = convertProgram(r.src, lang, r.lang, r.lang === 'isa' ? r.isa : undefined, r.k);
    const shape = lang === 'asm' ? {} : LANGS[lang].shape;
    set(src === null ? { lang, ...shape, isa: undefined } : { lang, src, ...shape, isa: undefined });
  });
  return sel;
}

// ---- the program editor --------------------------------------------------------------------

/** A large editor for a ROM's program: live re-assembly, gutter diagnostics, listing; Apply = one undo step. */
/** The program editor of a ROM part of the chip being edited, or of another chip (a ROM inside a placed chip). */
/** Text left unapplied when a program editor closed, per chip and ROM: reopening brings it back, so a draft is never lost silently. */
const drafts = new Map<string, string>();

export function openProgramEditor(ed: Editor, partId: string, chipId = ed.chipId): void {
  const part = () => ed.ws.chips[chipId]?.parts.find((p) => p.id === partId);
  const p0 = part();
  if (!p0 || !('rom' in p0.ref)) return;
  ed.el.querySelector('.sb-rom-dlg')?.remove();
  const applied = p0.ref.rom;
  const appliedLines = romImage(applied).lines;

  const listBox = h('div', { class: 'sb-rom-dlg-list' });
  const status = h('div', { class: 'sb-rom-dlg-status', role: 'status' });
  let list = listingTable([]);
  let img = romImage(applied);
  /** Row shown as current (undefined: redraw on the next frame). */
  let cur: number | null | undefined;
  const dkey = `${chipId}/${partId}`;
  const draft = drafts.get(dkey);
  const restored = draft !== undefined && draft !== applied.src;
  const ce = codeEditor({ value: restored ? draft : applied.src, lang: codeOf(applied), rows: 24, onChange: () => schedule() });

  const applyBtn = h('button', { class: 'btn sm primary', title: 'Apply (Ctrl+Enter): one undo step', onclick: () => apply() }, 'Apply') as HTMLButtonElement;
  const rebuild = () => {
    img = romImage({ ...applied, src: ce.value });
    ce.setDiagnostics(img.problems.filter((e) => e.line > 0));
    list = listingTable(romListing(applied, img), (r) => r.srcLine && ce.setActiveLine(r.srcLine), new Set(img.problems.map((e) => e.line)));
    listBox.replaceChildren(list.el);
    if (tilesOn) tiles?.refresh();
    cur = undefined;
    const errs = img.problems;
    applyBtn.disabled = errs.length > 0;
    applyBtn.title = errs.length ? 'Fix the problems first: a program with errors would leave the ROM unresolved' : 'Apply (Ctrl+Enter): one undo step';
    status.className = `sb-rom-dlg-status${errs.length ? ' err' : ''}`;
    status.replaceChildren(errs.length
      ? `${errs.length} problem${errs.length > 1 ? 's' : ''}: ${errs[0].line ? `line ${errs[0].line}: ` : ''}${errs[0].message}${errs.length > 1 ? ' …' : ''}`
      : `${usage(img)}${ce.value === applied.src ? '' : restored && ce.value === draft ? ' · your unapplied draft, kept from last time' : ' · not applied yet'}`);
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; rebuild(); }, 200);
  };

  const back = rememberFocus(() => ed.view.svg);
  const close = (keep = true) => {
    if (timer) clearTimeout(timer);
    if (keep && ce.value !== applied.src) drafts.set(dkey, ce.value); else drafts.delete(dkey);
    ce.destroy();
    ov.remove();
    back();
  };
  const apply = () => {
    const p = part();
    if (!p || !('rom' in p.ref)) {
      ed.toast(`The ROM '${partId}' is gone: nothing to apply to`, 'err');
      return close(false);
    }
    if (p.ref.rom.src !== ce.value) {
      // typed just now: the debounced check may not have run
      if (romImage({ ...p.ref.rom, src: ce.value }).problems.length) return void ed.toast('Fix the program problems first: nothing was applied', 'err');
      const doc = ed.ws.chips[chipId];
      const r = setRef(doc, partId, { rom: { ...p.ref.rom, src: ce.value } }, ed.defOf);
      if (r.reason) return void ed.toast(r.reason, 'err');
      // A ROM inside a placed chip (an instruction cache's) is applied where it is, without leaving this tab.
      if (chipId === ed.chipId) ed.edit(() => r.doc);
      else ed.editWs((ws) => ({ ...ws, chips: { ...ws.chips, [chipId]: r.doc } }));
    }
    close(false);
  };
  const cancel = () => {
    if (ce.value !== applied.src && !ov.classList.contains('confirm')) {
      ov.classList.add('confirm');
      status.className = 'sb-rom-dlg-status err';
      status.textContent = 'Unapplied changes: Cancel again to close (the text is kept as a draft), or Apply.';
      return;
    }
    close();
  };

  const srcBox = h('div', { class: 'sb-rom-dlg-src' }, ce.el);
  const body = h('div', { class: 'sb-rom-dlg-body' }, srcBox, listBox);
  // Every language with instructions: the instruction builder on the caret's line (Ctrl+Space), and the
  // program as tiles (a view of the text: a click builds a line, a drag moves it).
  const hasIsa = applied.lang !== 'hex' && applied.lang !== '6502' && applied.lang !== 'dsp24'; // DSP24 has no instruction builder (see isa/isa.ts)
  const isaOf = () => import('../isa/compose').then((c) => c.composeIsaOf(applied.lang, applied.isa, applied.custom, { c: applied.c, xlen: applied.xlen, custom16: applied.custom16 }));
  // RV32: the CPU's own instructions (editor/owninstr.ts), from the footer or a free custom slot in the builder;
  // the program editor closes for it and reopens after
  const customInstrs = () => {
    if (ce.value !== applied.src) return void ed.toast('Apply or cancel the program first', 'err');
    close();
    void import('./owninstr').then((m) => m.openCustomInstructions(ed, () => openProgramEditor(ed, partId, chipId)));
  };
  const builder = hasIsa ? romComposer(ce, body, (m) => ed.toast(m, 'err'), isaOf, applied.lang === 'asm' ? customInstrs : undefined) : null;
  const tiles = builder ? romTiles(ce, isaOf, (n) => builder.openAt(n)) : null;
  let tilesOn = false;
  const showTiles = (on: boolean) => {
    tilesOn = on;
    if (!tiles) return;
    // Off screen, not display: none: the builder and a drag still edit it (native undo needs it focusable)
    ce.el.classList.toggle('ce-away', on);
    if (on && !tiles.el.isConnected) srcBox.append(tiles.el);
    tiles.el.hidden = !on;
    if (on) tiles.refresh();
    viewSeg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', (i === 1) === on));
  };
  const viewSeg = h('span', { class: 'cmp-seg sb-rom-view', role: 'group', 'aria-label': 'View' },
    h('button', { class: 'on', onclick: () => showTiles(false) }, 'Text'),
    h('button', { title: 'The program as tiles: branch arrows, where each register was written; click a tile to build it, drag to move it', onclick: () => showTiles(true) }, 'Tiles'));
  const title = h('h3', null, icon('code', 16), `Program · ${partId}`,
    h('small', null, `${2 ** applied.k} × ${applied.w} bits · ${applied.addr === 'rv32' ? 'byte addressed' : 'word addressed'} · ${langName(applied)}`),
    tiles ? viewSeg : null);
  const ov = h('div', { class: 'sb-help sb-rom-dlg', role: 'dialog', 'aria-label': `Program of ${partId}` },
    h('div', { class: 'panel' },
      h('div', { class: 'sb-help-head' }, title, h('button', { class: 'btn ghost icon-only', 'aria-label': 'Cancel', title: 'Cancel (Esc)', onclick: cancel }, icon('close', 16))),
      body,
      h('div', { class: 'sb-rom-dlg-foot' }, status,
        builder?.button,
        // An RV32 program's CPU can learn its own instructions (editor/owninstr.ts); the editor reopens after
        applied.lang === 'asm' || (applied.lang === 'rv16' && customizable16(ed.doc, ed.ws.chips, ed.chipId, !!ed.level)) ? h('button', { class: 'btn sm ghost', title: 'Your own instructions for this CPU: the core and the golden model learn them, and this program can use them', onclick: customInstrs }, 'Custom instructions…') : null,
        h('button', { class: 'btn sm ghost', title: 'Download the program in the box as a deck of punched cards (.deck.json)', onclick: () => saveRomDeck(ed, partId, ce.value, chipId) }, 'Save as deck'),
        chipId === ed.chipId ? h('button', { class: 'btn sm ghost', title: 'Replace the program with the words of a deck of cards (applied at once: one undo step)', onclick: () => void pickDeck(ed).then((d) => {
          if (!d || !loadDeckIntoRom(ed, partId, d)) return;
          close(false);
          openProgramEditor(ed, partId);
        }) }, 'Load deck…') : null,
        h('button', { class: 'btn sm', onclick: cancel }, 'Cancel'),
        applyBtn)));
  // Keys stay in the dialog: the canvas's shortcuts (Delete, arrows, Ctrl+Z) must not act behind it.
  ov.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); if (!builder?.close()) cancel(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); }
    else ov.classList.remove('confirm');
  });
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) cancel(); });
  ed.el.append(ov);
  rebuild();
  ce.focus();

  // The running circuit's address: the row it reads, and its source line while the text is the
  // program the ROM holds (an edited text's lines no longer match the hardware).
  live(ov, () => {
    const i = ed.chipId === chipId ? romNow(ed, partId, applied) : null;
    const same = ce.value === applied.src;
    // While the builder is open the source stays on the line being built (the PC would scroll it away).
    const k = same && !builder?.isOpen ? i : null;
    if (k === cur) return;
    cur = k;
    list.setCurrent(i);
    if (same) ce.setActiveLine(i === null ? null : appliedLines[i]?.srcLine ?? null);
  });
}

// ---- RAM properties ------------------------------------------------------------------------

registerPropsSection({
  id: 'ram', order: 20,
  render(ed) {
    const p = selectedPart(ed);
    if (!p || !('ram' in p.ref)) return null;
    const id = p.id;
    const { k, w, init } = p.ref.ram;
    const multi = (p.ref.ram.ports ?? 1) > 1;
    const N = 2 ** k;
    const showBits = w <= 16;
    // Past 64 words the RAM is a lookup: its words come from the leaf's state (lib/bigmem.ts).
    const big = k > BANK_K;
    const at = (i: number) => (big ? `[${i.toString(16).toUpperCase().padStart(Math.ceil(k / 4), '0')}]` : `[${i}]`);
    /** What the rows show (refreshed once per frame while the section is on the page). */
    let snap: { word(i: number): number; bits(i: number): readonly number[] | null } | null = null;
    let cur: number | null = null, writing = false;
    const grid = h('div', { class: `memgrid sb-ram-grid${big ? ' big' : ''}` });
    const makeRow = (i: number) => {
      const v = snap ? snap.word(i) : -1;
      const bits = (showBits ? snap?.bits(i) : null) ?? Array.from({ length: w }, (_, j) => (v < 0 ? BX : (Math.floor(v / 2 ** j) % 2) as Bit));
      return memRow(at(i), bits, w, { cls: i === cur ? (writing ? 'write' : 'read') : '', prefix: '', cells: showBits });
    };
    // Only the rows in view are built: a 64K-word RAM is one screenful of rows.
    const rows = virtualRows({ count: N, el: grid, body: grid, row: makeRow, rowH: 17 });
    const goto = big ? h('input', { type: 'text', class: 'sb-ram-goto', placeholder: 'go to word (hex)', 'aria-label': 'Go to word', spellcheck: 'false' }) as HTMLInputElement : null;
    goto?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const t = goto.value.trim().replace(/^0x/i, '');
      const i = /^[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : NaN;
      if (i >= 0 && i < N) rows.reveal(i);
      else ed.toast(`Go to: a word index from 0 to ${(N - 1).toString(16).toUpperCase()} (hex)`, 'err');
    });
    const note = h('p', { class: 'sb-sum' });

    const text = h('textarea', { rows: '3', spellcheck: 'false', class: 'sb-ram-init', placeholder: 'hex words, e.g. 01 02 ff (@n: word n)', 'aria-label': 'Initial contents' }, initText(init, w)) as HTMLTextAreaElement;
    const setInit = (words: number[] | undefined) => {
      const cur = ed.doc.parts.find((q) => q.id === id);
      if (!cur || !('ram' in cur.ref)) return;
      const { init: _old, ...rest } = cur.ref.ram;
      const ref = words?.some((x) => x) ? { ram: { ...rest, init: words } } : { ram: rest };
      const r = setRef(ed.doc, id, ref, ed.defOf);
      if (r.reason) return void ed.toast(r.reason, 'err');
      ed.edit(() => r.doc);
      // The contents are power-on values: show them now (the rebuild would carry the old state).
      ed.sim.flush();
      ed.sim.reset();
      ed.toast(ed.sim.powerOn === 'zero' ? 'Initial contents set: the circuit was power-cycled' : 'Initial contents set: they apply in "power on to 0" mode');
    };
    const applyText = () => {
      const r = parseInit(text.value, k, w);
      if ('error' in r) return void ed.toast(`Initial contents: ${r.error}`, 'err');
      setInit(r.init);
    };

    const out = h('section', { class: 'sb-sec-props sb-ram' },
      h('h3', null, 'Contents', h('small', null, ` ${N} × ${w} bits, live`)),
      goto, grid, note,
      h('h3', null, 'Initial contents'),
      h('p', { class: 'sb-sum' }, big
        ? 'Held at power-on ("to 0" mode): the lookup starts with them, and its banks show them when opened. No extra gates.'
        : 'Held at power-on ("to 0" mode): seeded into the flip-flops, no extra gates.'),
      text,
      h('div', { class: 'sb-btns' },
        h('button', { class: 'btn sm', title: 'Set these words and power-cycle the circuit', onclick: applyText }, 'Apply & reset'),
        h('button', { class: 'btn sm ghost', title: 'Make what the RAM holds now its initial contents', onclick: () => {
          const ws = readRam(ed.sim.sim!, id);
          if (!ws) return void ed.toast('The RAM is not simulated', 'err');
          setInit(ws.map((x) => Math.max(0, x)));
        } }, 'Keep current'),
        init?.length ? h('button', { class: 'btn sm ghost', title: 'Start from zeros', onclick: () => setInit(undefined) }, 'Clear') : null));

    let key = '';
    live(out, () => {
      const sim = ed.sim.sim;
      const node = sim?.design.root.children?.get(id);
      const st = sim ? ramLeafState(sim, node) : null;
      // A large RAM: its state object and write count say whether anything changed (no 64K-word join per frame).
      const words = st || !sim ? null : readRam(sim, id);
      // a memory with ports: port 0's address and write enable
      const a = addrValue(ed.sim.endBits(`p:${id}.${multi ? 'addr0' : 'addr'}`));
      const we0 = addrValue(ed.sim.endBits(`p:${id}.we`));
      const we = multi && we0 !== null && we0 >= 0 ? we0 & 1 : we0;
      const k2 = `${st ? `${objectId(st)}:${st.writes}` : words?.join(',')}|${a}|${we}`;
      if (k2 === key) return;
      key = k2;
      const known = !!(st || words);
      note.textContent = known ? (a === null || a < 0 ? 'Address unknown.' : `${multi ? 'Port 0: ' : ''}${we === 1 ? 'Writing' : 'Reading'} ${at(a)}${we === 1 ? ' at the next rising clock edge' : ''}.`) : 'Not simulated.';
      cur = known && a !== null && a >= 0 ? a : null;
      writing = we === 1;
      const bitsOf = (v: number) => Array.from({ length: w }, (_, j) => (v < 0 ? BX : Math.floor(v / 2 ** j) % 2));
      snap = st ? { word: (i) => ramWord(st, i), bits: (i) => bitsOf(ramWord(st, i)) }
        : words && sim ? { word: (i) => words[i] ?? -1, bits: (i) => { const r = node?.children?.get(`w${i}`); return r ? sim.getBits(r.ports.q) : null; } }
        : null;
      rows.refresh();
    });
    return out;
  },
});

// ---- examples ------------------------------------------------------------------------------

/** The gallery is a chunk of its own (examplegallery.ts, its styles and the thumbnails' code): fetched on the first click. */
function examplesGallery(ed: Editor): void {
  void import('./examplegallery').then((m) => m.openExamplesGallery(ed));
}

registerToolbarAction({ id: 'examples', title: 'Load an example circuit as a new chip', icon: 'book', label: 'Examples', order: 60, run: examplesGallery });

// ---- the pipelined core's variant ---------------------------------------------------------

registerPropsSection({
  id: 'pipecore', order: 18,
  render(ed) {
    const p = selectedPart(ed);
    const k = p ? portCoreOf(p.ref) : null;
    if (!p || !k?.pipe) return null;
    const cur = k.m ? 'm' : k.dcache ? 'dc' : 'plain';
    return h('section', { class: 'sb-sec-props' }, h('h3', null, `Pipelined RV32I${k.c ? 'C' : ''} core`),
      row('Variant', select(cur, [['plain', `RV32I${k.c ? 'C' : ''}`], ['m', `RV32IM${k.c ? 'C' : ''}: multiply and divide`], ['dc', `RV32I${k.c ? 'C' : ''} + write-through data cache`]], (v) => {
        const r = setRef(ed.doc, p.id, portCoreRef({ pipe: true, m: v === 'm', c: k.c, dcache: v === 'dc', custom: k.custom }), ed.defOf);
        if (r.reason) return void ed.toast(r.reason, 'err');
        ed.edit(() => r.doc);
      }, 'Variant'), 'M: a multiply splits over E and M, a divide (radix-4 SRT) stalls the front for 18 cycles. Data cache: 4 lines × 4 words in M, write-through; a load miss freezes the pipeline 8 cycles; bit-31 addresses (devices) are never cached. Custom instructions are kept.'));
  },
});

// ---- the 64-bit core's data memory ---------------------------------------------------------

registerPropsSection({
  id: 'core64', order: 19,
  render(ed) {
    const p = selectedPart(ed);
    const m = p && 'lib' in p.ref ? CORE64.exec(p.ref.lib) : null;
    if (!p || !m) return null;
    const k = m[2] ? +m[2] : DMEM64_DEFAULT;
    const opts = Array.from({ length: DMEM64_MAX - DMEM64_MIN + 1 }, (_, i): [number, string] => {
      const n = DMEM64_MIN + i;
      return [n, `${2 ** n} dwords (${kWords(2 ** (n + 3))} B)`];
    });
    return h('section', { class: 'sb-sec-props' }, h('h3', null, `${m[1] === 'im' ? 'RV64IM' : 'RV64I'} core`),
      row('Data memory', select(k, opts, (n) => {
        const r = setCore64Memory(ed.doc, p.id, n, ed.defOf);
        if (r.reason) return void ed.toast(r.reason, 'err');
        ed.edit(() => r.doc);
      }, 'Data memory'), 'The core keeps its data memory inside: 2^k doublewords as eight byte banks. A larger memory is more gates to build and simulate (2^8 is about 400 000 leaves).'),
      h('p', { class: 'sb-sum' }, 'The memory is inside the core part, so the drawer’s memory view and the golden model follow the size; addresses past it wrap.'));
  },
});
