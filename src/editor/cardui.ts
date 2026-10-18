// The card reader's panel (cardparts.ts) and the deck files of the sandbox: the reader's property section (mode,
// bits, feed; the deck as a list, the selected card drawn to scale and punched by hand, the card at the read
// station followed live; load, save, punch from a ROM, type a source card, drop and sort), the file picker and
// download shared with the ROM's panels (memui.ts), and a deck file dropped on the canvas (fileui.ts). Every
// change to a deck is an Editor.edit(): one undo step.

import '../styles/cardui.css';
import { type Card, type Deck, deckFromJson, deckToJson, DECK_EXT, dropDeck, MAX_WORD_BITS, seqOf, sortDeck, textCard, textOf, unpunchable, wordOf } from '../cards/card';
import { cardSource, deckBits } from '../cards/program';
import { type CardReaderState, MAX_FEED, readerProgress } from '../cards/reader';
import type { Vec } from '../sim/geometry';
import { h, icon } from '../ui/dom';
import { saveFile } from '../view/image';
import { cardView } from '../widgets/carddraw';
import { cardDoc, deckRef, READER_MAX_CARDS, READER_NAME_MAX, type ReaderRef, refDeck } from './cardparts';
import { romDeck, romWithDeck } from './deckio';
import type { Editor } from './editor';
import { fileBase } from './files';
import { partAnchor } from './geom';
import type { PartDoc, PartRef } from './model';
import { addPart, setRef } from './ops';
import { registerPropsSection } from './props';
import { virtualRows } from './vlist';

// ---- files -------------------------------------------------------------------------------------

/** Decks are small (4 096 cards ≈ 1 MB); a larger file is something else. */
const MAX_DECK_FILE = 8 << 20;

/** Read a deck file, or say on a toast why not. */
export async function readDeckFile(ed: Editor, f: File): Promise<Deck | null> {
  if (f.size > MAX_DECK_FILE) return void ed.toast(`${f.name}: too large for a deck of cards`, 'err'), null;
  let text: string;
  try {
    text = await f.text();
  } catch {
    return void ed.toast(`${f.name}: could not be read`, 'err'), null;
  }
  const d = deckFromJson(text);
  if (typeof d === 'string') return void ed.toast(`${f.name}: ${d}`, 'err'), null;
  return d;
}

/** Ask for a deck file (null: cancelled or unreadable). */
export function pickDeck(ed: Editor): Promise<Deck | null> {
  return new Promise((done) => {
    const input = h('input', { type: 'file', accept: `${DECK_EXT},.json,application/json`, style: 'display:none' }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      input.remove();
      if (f) void readDeckFile(ed, f).then(done);
      else done(null);
    });
    ed.el.append(input);
    input.click();
  });
}

/** Download a deck as a .deck.json file. */
export function saveDeck(ed: Editor, deck: Deck): void {
  saveFile(`${fileBase(deck.name, 'deck')}${DECK_EXT}`, deckToJson(deck));
  ed.toast(`Saved ${deck.cards.length} card${deck.cards.length === 1 ? '' : 's'} as ${fileBase(deck.name, 'deck')}${DECK_EXT}`);
}

function setPartRef(ed: Editor, id: string, ref: PartRef): boolean {
  const r = setRef(ed.doc, id, ref, ed.defOf);
  if (r.reason) return void ed.toast(r.reason, 'err'), false;
  ed.edit(() => r.doc);
  return true;
}

/** A ROM part's program replaced by a deck's words (hex, the cards' sources as comments): one undo step. */
export function loadDeckIntoRom(ed: Editor, partId: string, deck: Deck): boolean {
  const p = ed.doc.parts.find((q) => q.id === partId);
  if (!p || !('rom' in p.ref)) return false;
  const r = romWithDeck(p.ref.rom, deck);
  if ('error' in r) return void ed.toast(`Load deck: ${r.error}`, 'err'), false;
  if (!setPartRef(ed, partId, { rom: r })) return false;
  ed.toast(`Loaded ${deck.cards.length} card${deck.cards.length === 1 ? '' : 's'} into ${partId} (Ctrl+Z puts the program back)`);
  return true;
}

/** Save a ROM's program as a deck of object cards (src: the text to punch, default the ROM's own). */
export function saveRomDeck(ed: Editor, partId: string, src?: string, chipId = ed.chipId): void {
  const p = ed.ws.chips[chipId]?.parts.find((q) => q.id === partId);
  if (!p || !('rom' in p.ref)) return;
  const d = romDeck(src === undefined ? p.ref.rom : { ...p.ref.rom, src }, p.label ?? partId);
  if ('error' in d) return void ed.toast(`Save as deck: ${d.error}`, 'err');
  saveDeck(ed, d);
}

/**
 * A deck file dropped on the canvas: into the selected ROM or card reader, else onto a new card reader where it
 * fell (`at`, world coordinates; default the middle of the view).
 */
export async function dropDeckFile(ed: Editor, f: File, at?: Vec): Promise<void> {
  const deck = await readDeckFile(ed, f);
  if (!deck) return;
  const sel = ed.selCount === 1 && ed.sel.parts?.length === 1 ? ed.doc.parts.find((p) => p.id === ed.sel.parts![0]) : undefined;
  if (sel && 'rom' in sel.ref) return void loadDeckIntoRom(ed, sel.id, deck);
  if (sel && 'reader' in sel.ref) {
    const bits = deckBits(deck) || sel.ref.reader.bits;
    if (setPartRef(ed, sel.id, { reader: deckRef(deck, { ...sel.ref.reader, bits }) })) ed.toast(`${sel.id} holds ${deck.name} now (${deck.cards.length} cards${sel.ref.reader.mode === 'word' ? `, ${bits}-bit words` : ''})`);
    return;
  }
  const ref: PartRef = { reader: deckRef(deck, { bits: deckBits(deck) || 32 }) };
  const def = ed.defOfRef(ref);
  if (!def) return void ed.toast('The deck could not be put in a card reader', 'err');
  const where = at ?? ed.view.cam.toWorld(ed.view.svg.getBoundingClientRect().left + ed.view.svg.clientWidth / 2, ed.view.svg.getBoundingClientRect().top + ed.view.svg.clientHeight / 2);
  const r = addPart(ed.doc, ref, partAnchor(def, where));
  if (r.id === undefined) return void ed.toast(r.reason, 'err');
  const id = r.id;
  ed.edit(() => r.doc);
  ed.select({ parts: [id] });
  ed.toast(`A card reader holding ${deck.name} (${deck.cards.length} cards): Ctrl+Z removes it`);
}

// ---- the reader's properties ---------------------------------------------------------------------

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

const row = (label: string, ctl: Node, hint?: string) => h('label', { class: 'sb-row', title: hint ?? null }, h('span', null, label), ctl);
const btn = (label: string, title: string, f: () => void, ic?: string) => h('button', { class: 'btn sm', title, onclick: f }, ic ? icon(ic, 14) : null, label);

function num(value: number, min: number, max: number, commit: (v: number) => void, label: string): HTMLInputElement {
  const i = h('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: '1', 'aria-label': label }) as HTMLInputElement;
  i.addEventListener('change', () => {
    const v = Number(i.value);
    if (Number.isInteger(v) && v >= min && v <= max) commit(v);
    else i.value = String(value);
  });
  return i;
}

/** The card shown in each reader's panel, per editor (the panel is rebuilt after every edit). */
const picked = new WeakMap<Editor, Map<string, number>>();
const pickOf = (ed: Editor, id: string) => picked.get(ed)?.get(id) ?? 0;
function setPick(ed: Editor, id: string, i: number): void {
  let m = picked.get(ed);
  if (!m) picked.set(ed, (m = new Map()));
  m.set(id, i);
}

const hexW = (w: number, bits: number) => `0x${(w >>> 0).toString(16).toUpperCase().padStart(Math.ceil(bits / 4), '0')}`;

registerPropsSection({
  id: 'reader', order: 20,
  render(ed) {
    if (ed.selCount !== 1 || ed.sel.parts?.length !== 1) return null;
    const p = ed.doc.parts.find((q) => q.id === ed.sel.parts![0]);
    return p && 'reader' in p.ref ? readerProps(ed, p, p.ref.reader) : null;
  },
});

function readerProps(ed: Editor, p: PartDoc, r: ReaderRef): HTMLElement {
  const id = p.id;
  const deck = refDeck(r);
  const cards = deck.cards;
  const n = cards.length;
  const bits = r.mode === 'word' ? r.bits : 12;
  let sel = Math.max(0, Math.min(n - 1, pickOf(ed, id)));
  /** The reference as it is now (an action may run after other edits). */
  const now = (): ReaderRef | null => {
    const q = ed.doc.parts.find((x) => x.id === id);
    return q && 'reader' in q.ref ? q.ref.reader : null;
  };
  const set = (patch: Partial<ReaderRef>) => {
    const cur = now();
    if (cur) setPartRef(ed, id, { reader: { ...cur, ...patch } });
  };
  const setCards = (cs: Card[], pick?: number) => {
    if (cs.length > READER_MAX_CARDS) return void ed.toast(`A reader holds at most ${READER_MAX_CARDS} cards`, 'err');
    if (pick !== undefined) setPick(ed, id, pick);
    set({ cards: cs.map(cardDoc) });
  };

  // the selected card, drawn to scale: a click punches or clears a hole
  const view = cardView(cards[sel] ?? { cols: new Array<number>(80).fill(0), print: '' }, {
    label: 'The selected card: click a position to punch or clear a hole',
    onToggle: (col, rw) => {
      if (!n) return void ed.toast('The deck is empty: type a source card first', 'err');
      const cs = cards.slice();
      const c = cs[sel];
      cs[sel] = { ...c, cols: c.cols.map((m, k) => (k === col ? m ^ (1 << rw) : m)) };
      setCards(cs, sel);
    },
  });
  const caption = h('p', { class: 'sb-card-cap' });
  const showCard = () => {
    const c = cards[sel];
    if (!c) {
      view.show({ cols: new Array<number>(80).fill(0), print: '' });
      caption.textContent = 'No cards in the hopper.';
      return;
    }
    view.show(c);
    const s = seqOf(c);
    caption.replaceChildren(h('b', null, `Card ${sel + 1} of ${n}`), s !== null ? ` · seq ${s}` : '',
      r.mode === 'word' ? h('span', null, ' · word ', h('code', null, hexW(wordOf(c, bits), bits))) : h('span', null, ' · text ', h('code', null, textOf(c) || '(blank)')));
  };

  // the deck as a list: number, word (or the text a column-mode reader reads), print
  const body = h('tbody');
  const listEl = h('div', { class: 'sb-rom-list sb-deck-list' });
  let at: number | null = null, taken = 0;
  const makeRow = (i: number) => {
    const c = cards[i];
    const s = seqOf(c);
    const tr = h('tr', { class: [i === sel ? 'sel' : '', i === at ? 'cur' : '', i < taken && i !== at ? 'taken' : ''].join(' ').trim() || null, 'data-card': String(i) },
      h('td', { class: 'a' }, s !== null ? String(s).padStart(4, '0') : `#${i + 1}`),
      h('td', { class: 'w' }, r.mode === 'word' ? hexW(wordOf(c, bits), bits) : (textOf(c).slice(0, 10) || '·')),
      h('td', { class: 'd' }, cardSource(c) || textOf(c)));
    tr.addEventListener('click', () => pick(i));
    return tr;
  };
  if (n) listEl.append(h('table', { class: 'asm-table' }, body));
  else listEl.append(h('p', { class: 'sb-sum' }, 'Empty: type a source card, load a deck file, or punch one from a ROM.'));
  const rows = n ? virtualRows({ count: n, el: listEl, body, row: makeRow }) : null;
  const pick = (i: number) => {
    if (i < 0 || i >= n || i === sel) return;
    rows?.built.get(sel)?.classList.remove('sel');
    sel = i;
    setPick(ed, id, i);
    rows?.built.get(i)?.classList.add('sel');
    rows?.reveal(i);
    showCard();
    view.mark(r.mode === 'word' ? Array.from({ length: bits }, (_, k) => k) : null, 'word');
  };

  // type a source card: a line punched in the 029 code, after the selected card
  const typed = h('input', { type: 'text', maxlength: '80', spellcheck: 'false', placeholder: 'a line of source', 'aria-label': 'Source card text' }) as HTMLInputElement;
  const warn = h('p', { class: 'sb-card-warn', hidden: true });
  typed.addEventListener('input', () => {
    const bad = unpunchable(typed.value);
    warn.hidden = !bad.length;
    warn.textContent = bad.length ? `The 029 has no code for ${bad.map((c) => `“${c}”`).join(' ')}: punched as ?` : '';
  });
  const punch = () => {
    const i = n ? sel + 1 : 0;
    const cs = cards.slice();
    cs.splice(i, 0, textCard(typed.value));
    setCards(cs, i);
  };
  typed.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); punch(); } });

  // punch a ROM of this chip
  const roms = ed.doc.parts.filter((q) => 'rom' in q.ref);
  const fromRom = h('select', { 'aria-label': 'Punch a ROM\'s program', disabled: !roms.length, title: roms.length ? 'One object card per word of a ROM\'s program, printed with its source line' : 'No ROM in this chip' },
    h('option', { value: '' }, 'From a ROM…'), roms.map((q) => h('option', { value: q.id }, q.label ?? q.id))) as HTMLSelectElement;
  fromRom.addEventListener('change', () => {
    const q = ed.doc.parts.find((x) => x.id === fromRom.value);
    fromRom.value = '';
    if (!q || !('rom' in q.ref)) return;
    const d = romDeck(q.ref.rom, q.label ?? q.id);
    if ('error' in d) return void ed.toast(`${q.id}: ${d.error}`, 'err');
    setPick(ed, id, 0);
    set({ cards: d.cards.map(cardDoc), name: d.name, mode: 'word', bits: q.ref.rom.w });
    ed.toast(`Punched ${d.cards.length} cards from ${q.id}`);
  });

  const name = h('input', { type: 'text', value: r.name, maxlength: String(READER_NAME_MAX), 'aria-label': 'Deck name' }) as HTMLInputElement;
  name.addEventListener('change', () => { if (name.value.trim() && name.value !== r.name) set({ name: name.value.trim() }); });
  const status = h('p', { class: 'sb-rom-now' });

  const out = h('section', { class: 'sb-sec-props sb-io-props sb-reader' },
    h('h3', null, 'Card reader', h('small', null, ` ${n} card${n === 1 ? '' : 's'}`)),
    row('Mode', h('div', { class: 'seg sb-io-seg', role: 'group', 'aria-label': 'Mode' },
      ([['word', 'Word'], ['column', 'Column']] as const).map(([v, l]) => h('button', { class: v === r.mode ? 'on' : null, 'aria-pressed': String(v === r.mode), onclick: () => v !== r.mode && set({ mode: v }) }, l))),
    'Word: one word a card, punched in row 9 · Column: the 12 rows of one column at a time, 80 a card'),
    r.mode === 'word' ? row('Bits', num(r.bits, 1, MAX_WORD_BITS, (v) => set({ bits: v }), 'Bits a word'), `Row 9 of columns 1–${r.bits}: the width of data`) : null,
    row('Feed', h('span', { class: 'sb-io-vs' }, num(r.feed, 0, MAX_FEED, (v) => set({ feed: v }), 'Feed delay'), h('span', null, 'edges')),
      'Clock edges from taking a card to the next one reaching the read station (0: at once)'),
    row('Deck', name),
    status,
    view.el, caption,
    listEl,
    h('div', { class: 'sb-card-type' }, typed, h('button', { class: 'btn sm', title: 'Punch the line on a new card after the selected one (Enter)', onclick: punch }, 'Punch')),
    warn,
    h('div', { class: 'sb-btns' },
      btn('Load deck…', `Replace the deck with a ${DECK_EXT} file`, () => void pickDeck(ed).then((d) => {
        if (!d) return;
        setPick(ed, id, 0);
        // object cards say how wide their words are (most significant bit in column 1): read them at that width
        const w = deckBits(d);
        set({ cards: d.cards.slice(0, READER_MAX_CARDS).map(cardDoc), name: d.name.slice(0, READER_NAME_MAX) || 'deck', ...(w ? { bits: w } : {}) });
        if (w && w !== r.bits && r.mode === 'word') ed.toast(`Reading ${w}-bit words, as the deck's object cards hold`);
      }), 'open'),
      btn('Save deck', `Download the deck as a ${DECK_EXT} file`, () => saveDeck(ed, refDeck(now() ?? r))),
      fromRom),
    h('div', { class: 'sb-btns' },
      btn('Drop the deck', 'Shuffle the cards, as a deck dropped on the floor', () => n > 1 && setCards(dropDeck(cards, (Math.random() * 2 ** 32) >>> 0))),
      btn('Sort', 'Put the cards in the order of their sequence numbers (columns 73–80), as a card sorter would', () => n > 1 && setCards(sortDeck(cards))),
      btn('Delete card', 'Take the selected card out of the deck', () => n && setCards(cards.filter((_, i) => i !== sel), Math.max(0, sel - 1))),
      btn('Clear', 'Empty the hopper', () => n && setCards([], 0), 'close')));
  showCard();
  view.mark(r.mode === 'word' ? Array.from({ length: bits }, (_, k) => k) : null, 'word');

  // the reader in the simulation: the card at the station, cards taken; the view follows the station
  let key = '';
  live(out, () => {
    const sim = ed.sim.sim, li = sim?.design.root.children?.get(id)?.leafIndex;
    const st = sim && li !== undefined ? sim.leafState(li) as CardReaderState | undefined : undefined;
    const pr = st?.q ? readerProgress(st) : null;
    const k = pr ? `${pr.at}|${pr.taken}|${pr.column}|${pr.feeding}|${st!.over}` : sim ? 'none' : '';
    if (k === key) return;
    key = k;
    const moved = pr?.at !== at;
    at = pr?.at ?? null;
    taken = pr?.taken ?? 0;
    status.textContent = !pr ? (sim ? 'Not read by the simulation.' : 'Not simulated.')
      : pr.at === null ? `Hopper empty: all ${pr.cards} card${pr.cards === 1 ? '' : 's'} taken${st!.over ? ` · ${st!.over} read${st!.over === 1 ? '' : 's'} past the end` : ''}.`
      : `${pr.feeding ? `Feeding card ${pr.at + 1}` : `Card ${pr.at + 1} of ${pr.cards} at the read station`}${r.mode === 'column' && !pr.feeding ? `, column ${pr.column + 1}` : ''} · ${pr.taken} taken.`;
    if (moved && at !== null) pick(at);
    if (r.mode === 'column') view.mark(pr && at === sel && !pr.feeding ? [pr.column] : null, 'read');
    rows?.refresh();
  });
  return out;
}
