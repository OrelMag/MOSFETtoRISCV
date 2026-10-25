// The sandbox's memories, on screen: the Memory palette group, the ROM's properties (size,
// addressing, language, samples, a live listing) and its program editor, the RAM's live
// contents and initial contents, and the Examples menu. Everything plugs in through the
// editor's registries; values are read from the running simulation once per frame while the
// element showing them is on the page.

import '../styles/memui.css';
import { BANK_K, kWords, ramLeafState, ramWord } from '../lib/bigmem';
import { B0, B1, BX } from '../sim/types';
import { h, icon, placeMenu } from '../ui/dom';
import { codeEditor } from '../widgets/codeedit';
import type { CodeLang } from '../widgets/codetok';
import { type Editor, registerToolbarAction } from './editor';
import { addExample, EXAMPLES } from './examples';
import {
  addrValue, convertProgram, initText, type ListingRow, parseInit, readRam, ROM_SAMPLES, romImage, romIndex, romListing, type RomRef, sampleK,
} from './memory';
import type { PartDoc } from './model';
import { setRef } from './ops';
import { registerPaletteGroup } from './palette';
import { MAX_ROM_K } from './parts';
import { registerPropsSection } from './props';
import type { ProgramLang } from './program';
import { ISA4_PRESET } from '../isa/presets';
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
  '6502': { name: '6502 assembly', code: 'm6502asm', shape: { w: 8, addr: 'word' } },
  hex: { name: 'hex words', code: 'hex', shape: {} },
  isa: { name: 'custom instruction set', code: 'hex', shape: { addr: 'word' } },
};

/** A ROM's highlighter and language name: a custom instruction set's from its table. */
const codeOf = (r: Pick<RomRef, 'lang' | 'isa'>): CodeLang => (r.lang === 'isa' && r.isa ? { table: r.isa } : LANGS[r.lang].code);
const langName = (r: Pick<RomRef, 'lang' | 'isa'>) => (r.lang === 'isa' && r.isa ? r.isa.name : LANGS[r.lang].name);

// ---- palette -------------------------------------------------------------------------------

const FIB = ROM_SAMPLES.find((s) => s.id === 'fib')!.src;
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

    const sample = h('select', { 'aria-label': 'Load a sample program' },
      h('option', { value: '' }, 'Load a sample…'), ROM_SAMPLES.map((s) => h('option', { value: s.id }, `${s.name}${s.lang === 'hex' ? ' (hex)' : ''}`))) as HTMLSelectElement;
    sample.addEventListener('change', () => {
      const s = ROM_SAMPLES.find((x) => x.id === sample.value);
      if (!s) return;
      // RV32 assembly needs 32-bit words, RV16 and the 4-bit CPU 16-bit word-addressed ones; the ROM grows to hold the sample (never shrinks).
      set({ lang: s.lang, src: s.src, k: Math.max(r.k, sampleK(s.lang, s.src)), ...LANGS[s.lang].shape });
    });

    const width = select(r.w, [[8, '8 bits'], [16, '16 bits'], [32, '32 bits']], (w) => set({ w }), 'Word width');
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
      row('Sample', sample),
      status,
      h('div', { class: 'sb-btns' }, h('button', { class: 'btn sm primary', title: 'Edit the program with a live listing', onclick: () => openProgramEditor(ed, id) }, icon('code', 14), 'Edit program…'),
        h('button', { class: 'btn sm', title: 'Download the program as a deck of punched cards (.deck.json): one card a word, printed with its source line', onclick: () => saveRomDeck(ed, id) }, 'Save as deck'),
        h('button', { class: 'btn sm', title: 'Replace the program with the words of a deck of cards (as hex, each card’s print a comment); a .deck.json dropped on the canvas does it too', onclick: () => void pickDeck(ed).then((d) => d && loadDeckIntoRom(ed, id, d)) }, 'Load deck…')),
      now, list.el);

    let key = '';
    live(out, () => {
      const i = romNow(ed, id, r);
      const k = String(i);
      if (k === key) return;
      key = k;
      list.setCurrent(i);
      const l = i === null ? undefined : img.lines[i];
      now.replaceChildren(i === null
        ? h('span', null, 'Address unknown (not connected or X)')
        : h('span', null, 'Reading ', h('b', null, r.addr === 'rv32' ? `0x${(4 * i).toString(16).padStart(4, '0')}` : rows[i]?.addr ?? `[${i}]`), ' → ',
          h('code', null, !l ? (r.addr === 'rv32' ? 'nop (fill)' : '0 (fill)') : r.w === 32 || r.lang === 'cpu4' || r.lang === 'isa' || (r.lang === '6502' && l.text) ? l.text : `0x${(l.word >>> 0).toString(16).padStart(r.w / 4, '0')}`)));
    });
    return out;
  },
});

/** A ROM's Language: the built-in languages, the workspace's instruction sets, and the ISA editor. */
function languageSelect(ed: Editor, partId: string, r: RomRef, set: (patch: Partial<RomRef>) => void): HTMLSelectElement {
  const cur = r.lang === 'isa' && r.isa ? `isa:${r.isa.id}` : r.lang;
  const isas = isaList(ed.ws);
  const sel = h('select', { 'aria-label': 'Language' },
    (['asm', 'rv16', 'cpu4', '6502', 'hex'] as const).map((l) => h('option', { value: l, selected: cur === l }, LANGS[l].name)),
    isas.length ? h('optgroup', { label: 'Instruction sets' }, isas.map((d) => h('option', { value: `isa:${d.id}`, selected: cur === `isa:${d.id}` }, d.name))) : null,
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
  const ce = codeEditor({ value: applied.src, lang: codeOf(applied), rows: 24, onChange: () => schedule() });

  const rebuild = () => {
    img = romImage({ ...applied, src: ce.value });
    ce.setDiagnostics(img.problems.filter((e) => e.line > 0));
    list = listingTable(romListing(applied, img), (r) => r.srcLine && ce.setActiveLine(r.srcLine), new Set(img.problems.map((e) => e.line)));
    listBox.replaceChildren(list.el);
    if (tilesOn) tiles?.refresh();
    cur = undefined;
    const errs = img.problems;
    status.className = `sb-rom-dlg-status${errs.length ? ' err' : ''}`;
    status.replaceChildren(errs.length
      ? `${errs.length} problem${errs.length > 1 ? 's' : ''}: ${errs[0].line ? `line ${errs[0].line}: ` : ''}${errs[0].message}${errs.length > 1 ? ' …' : ''}`
      : `${usage(img)}${ce.value === applied.src ? '' : ' · not applied yet'}`);
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; rebuild(); }, 200);
  };

  const close = () => {
    if (timer) clearTimeout(timer);
    ce.destroy();
    ov.remove();
    ed.view.svg.focus?.();
  };
  const apply = () => {
    const p = part();
    if (!p || !('rom' in p.ref)) {
      ed.toast(`The ROM '${partId}' is gone: nothing to apply to`, 'err');
      return close();
    }
    if (p.ref.rom.src !== ce.value) {
      const doc = ed.ws.chips[chipId];
      const r = setRef(doc, partId, { rom: { ...p.ref.rom, src: ce.value } }, ed.defOf);
      if (r.reason) return void ed.toast(r.reason, 'err');
      // A ROM inside a placed chip (an instruction cache's) is applied where it is, without leaving this tab.
      if (chipId === ed.chipId) ed.edit(() => r.doc);
      else ed.editWs((ws) => ({ ...ws, chips: { ...ws.chips, [chipId]: r.doc } }));
    }
    close();
  };
  const cancel = () => {
    if (ce.value !== applied.src && !ov.classList.contains('confirm')) {
      ov.classList.add('confirm');
      status.className = 'sb-rom-dlg-status err';
      status.textContent = 'Unapplied changes: Cancel again to discard them, or Apply.';
      return;
    }
    close();
  };

  const srcBox = h('div', { class: 'sb-rom-dlg-src' }, ce.el);
  const body = h('div', { class: 'sb-rom-dlg-body' }, srcBox, listBox);
  // Every language with instructions: the instruction builder on the caret's line (Ctrl+Space), and the
  // program as tiles (a view of the text: a click builds a line, a drag moves it).
  const hasIsa = applied.lang !== 'hex' && applied.lang !== '6502';
  const isaOf = () => import('../isa/compose').then((c) => c.composeIsaOf(applied.lang, applied.isa, applied.custom));
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
        applied.lang === 'asm' ? h('button', { class: 'btn sm ghost', title: 'Your own instructions for this CPU: the core and the golden model learn them, and this program can use them', onclick: customInstrs }, 'Custom instructions…') : null,
        h('button', { class: 'btn sm ghost', title: 'Download the program in the box as a deck of punched cards (.deck.json)', onclick: () => saveRomDeck(ed, partId, ce.value, chipId) }, 'Save as deck'),
        chipId === ed.chipId ? h('button', { class: 'btn sm ghost', title: 'Replace the program with the words of a deck of cards (applied at once: one undo step)', onclick: () => void pickDeck(ed).then((d) => {
          if (!d || !loadDeckIntoRom(ed, partId, d)) return;
          close();
          openProgramEditor(ed, partId);
        }) }, 'Load deck…') : null,
        h('button', { class: 'btn sm', onclick: cancel }, 'Cancel'),
        h('button', { class: 'btn sm primary', title: 'Apply (Ctrl+Enter): one undo step', onclick: apply }, 'Apply'))));
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
    const digits = Math.max(1, Math.ceil(w / 4));
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
      const bits = showBits ? snap?.bits(i) ?? null : null;
      const cells = showBits ? Array.from({ length: w }, (_, j) => h('span', { class: `cell${bits?.[j] === B1 ? ' one' : bits && bits[j] !== B0 ? ' x' : ''}` })).reverse() : [];
      return h('div', { class: `row${i === cur ? (writing ? ' write' : ' read') : ''}` }, h('span', { class: 'addr' }, at(i)),
        showBits ? h('span', { class: 'cells' }, cells) : null,
        h('span', { class: 'hex' }, v < 0 ? 'x'.repeat(digits) : v.toString(16).toUpperCase().padStart(digits, '0')));
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

let closeMenu: (() => void) | null = null;

function examplesMenu(ed: Editor): void {
  if (closeMenu) return closeMenu();
  const btn = ed.actionAnchor('examples');
  // Esc puts the focus back where the menu was opened from (the toolbar, More, the empty chip's card)
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const r = btn?.getBoundingClientRect();
  const menu = h('div', { class: 'sb-menu', role: 'menu', 'aria-label': 'Examples' },
    h('div', { class: 'sb-menu-head' }, 'Load an example as a new chip'),
    EXAMPLES.map((ex) => h('button', { class: 'sb-menu-item', role: 'menuitem', 'data-example': ex.id, onclick: () => {
      close();
      let id = '';
      ed.editWs((ws) => { const a = addExample(ws, ex); id = a.id; return a.ws; });
      ed.toast(`Loaded “${ed.ws.chips[id]?.name ?? ex.name}” (Ctrl+Z removes it)`);
    } }, h('b', null, ex.name), h('small', null, ex.blurb))));
  // Wide enough for a title on one line; never wider than the window.
  const W = Math.min(380, innerWidth - 16);
  placeMenu(menu, { bottom: r?.bottom ?? 48 }, Math.max(8, Math.min(r?.left ?? 8, innerWidth - W - 8)));
  menu.style.width = `${W}px`;
  // A press outside closes it; the button's own click toggles it (run() above).
  const away = (e: Event) => { if (!menu.contains(e.target as Node) && !btn?.contains(e.target as Node)) close(); };
  const esc = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
    (opener?.isConnected ? opener : btn)?.focus();
  };
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', away, true);
    document.removeEventListener('keydown', esc, true);
    closeMenu = null;
  };
  closeMenu = close;
  ed.claimMenu(close);
  document.addEventListener('pointerdown', away, true);
  document.addEventListener('keydown', esc, true);
  ed.el.append(menu);
  (menu.querySelector('.sb-menu-item') as HTMLElement | null)?.focus();
}

registerToolbarAction({ id: 'examples', title: 'Load an example circuit as a new chip', icon: 'book', label: 'Examples ▸', order: 60, run: examplesMenu });
