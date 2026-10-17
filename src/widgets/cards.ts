// Prologue P3's widgets: Jacquard's loom (a chain of cards weaving a pattern), Hollerith's tabulator (a pin press
// counting a stack of census cards on dials, one count through relay contacts), the card editor (type and it punches
// the 029 code; click a position to punch it by hand), a program deck with the card sorter (a radix sort on the
// sequence columns, a pass per column), and the panel beside the card reader's scene.

import {
  type Card, COLUMNS, SEQ_FROM, SEQ_LEN, blankCard, dropDeck, inSequence, programDeck, sorterColumns, sorterPass, textCard, textOf, unpunchable, wordOf,
} from '../cards/card';
import { CHARSET, charOf, punchOf, rowsOf } from '../cards/hollerith';
import { type CardReaderState, readerLeaves, readerProgress } from '../cards/reader';
import { assemble } from '../riscv/asm';
import { PROGRAMS } from '../riscv/programs';
import { h, s } from '../ui/dom';
import type { Stage, Widget } from '../view/stage';
import { cardView } from './carddraw';

const hex8 = (w: number) => (w >>> 0).toString(16).padStart(8, '0');

/** A deterministic LCG in [0, 1). */
function lcg(seed: number) {
  let x = seed >>> 0 || 1;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
}

/** Run `f` every `ms` until it returns false or stop() is called. */
function ticker(ms: number) {
  let t: number | null = null;
  return {
    get on() { return t !== null; },
    start(f: () => boolean) { this.stop(); t = window.setInterval(() => { if (!f()) this.stop(); }, ms); },
    stop() { if (t !== null) { clearInterval(t); t = null; } },
  };
}

const btn = (label: string, onclick: () => void, title?: string) => h('button', { type: 'button', class: 'btn sm', onclick, title }, label);

// ---- Jacquard's loom ----------------------------------------------------------------------------
// A card is a row of hook positions: a hole lets its hook through and the hook lifts its warp threads; a blank
// stops it. The harness ties each hook to every HOOKS-th thread across the cloth, so the pattern repeats across
// the width; the chain of cards loops, so it repeats down the length. One card, one pick (one pass of the weft).

const HOOKS = 8, WARP = 32, PICKS = 32;

const LOOM_PRESETS: Record<string, { name: string; cards: string[] }> = {
  diamond: { name: 'Diamond', cards: ['00011000', '00100100', '01000010', '10000001', '10000001', '01000010', '00100100', '00011000'] },
  twill: { name: 'Twill', cards: ['11000000', '01100000', '00110000', '00011000', '00001100', '00000110', '00000011', '10000001'] },
  plain: { name: 'Plain weave', cards: ['10101010', '01010101'] },
  check: { name: 'Check', cards: ['11110000', '11110000', '11110000', '11110000', '00001111', '00001111', '00001111', '00001111'] },
};

export function loomWidget(): Widget {
  let cards: boolean[][] = [];
  let pick = 0;
  const run = ticker(90);
  const setPreset = (k: string) => { cards = LOOM_PRESETS[k].cards.map((r) => r.split('').map((c) => c === '1')); pick = PICKS; };
  setPreset('diamond');

  const CW = 14, chainX = 10, clothX = 210, CELL = 9;
  const svg = s('svg', { viewBox: `0 0 ${clothX + WARP * CELL + 10} ${PICKS * CELL + 30}`, class: 'loom', role: 'img', 'aria-label': 'A chain of punched cards and the cloth it weaves' });
  const chain = svg.appendChild(s('g'));
  const cloth = svg.appendChild(s('g'));
  svg.append(
    s('text', { x: chainX, y: PICKS * CELL + 24, class: 'loom-cap' }, 'the chain of cards: click a hole'),
    s('text', { x: clothX, y: PICKS * CELL + 24, class: 'loom-cap' }, 'the cloth, a row per card read'));
  const info = h('p', { class: 'sub' });

  const paint = () => {
    chain.replaceChildren(), cloth.replaceChildren();
    const at = pick > 0 ? (pick - 1) % cards.length : -1;
    cards.forEach((row, r) => {
      const y = 4 + r * 22;
      chain.append(s('rect', { x: chainX, y, width: HOOKS * CW + 12, height: 18, rx: 2, class: `loom-card${r === at ? ' at' : ''}` }));
      row.forEach((on, c) => {
        const hole = s('rect', { x: chainX + 6 + c * CW + 2, y: y + 5, width: CW - 4, height: 8, rx: 2, class: `loom-hole${on ? ' on' : ''}` });
        hole.addEventListener('click', () => { cards[r][c] = !cards[r][c]; paint(); });
        hole.appendChild(s('title', null, `card ${r + 1}, hook ${c + 1}`));
        chain.append(hole);
      });
    });
    for (let p = 0; p < Math.min(pick, PICKS); p++) {
      const row = cards[p % cards.length];
      for (let w = 0; w < WARP; w++) {
        // pick 0 at the bottom: cloth grows up from the breast beam
        cloth.append(s('rect', { x: clothX + w * CELL, y: (PICKS - 1 - p) * CELL, width: CELL - 0.6, height: CELL - 0.6, class: row[w % HOOKS] ? 'loom-up' : 'loom-dn' }));
      }
    }
    const lifted = at >= 0 ? cards[at].map((on, c) => (on ? c + 1 : 0)).filter(Boolean) : [];
    info.textContent = pick === 0 ? 'Nothing woven yet.'
      : `Pick ${Math.min(pick, PICKS)}: card ${at + 1} of ${cards.length}; hooks ${lifted.length ? lifted.join(', ') : 'none'} lifted, so ${lifted.length * (WARP / HOOKS)} of ${WARP} warp threads ride over the weft (coloured).`;
  };

  const presets = h('select', { 'aria-label': 'Pattern' }, ...Object.entries(LOOM_PRESETS).map(([k, p]) => h('option', { value: k }, p.name))) as HTMLSelectElement;
  presets.addEventListener('change', () => { run.stop(); setPreset(presets.value); paint(); });
  const weave = () => { run.stop(); pick = 0; paint(); run.start(() => { pick++; paint(); return pick < PICKS; }); };
  const el = h('div', { class: 'widget cards-w' },
    h('div', { class: 'panel' }, h('h3', null, 'Jacquard\'s loom: one card, one pass of the weft'), svg, info),
    h('div', { class: 'panel cards-ctl' }, presets,
      btn('Weave', weave),
      btn('Add a card', () => { if (cards.length < 12) { cards.push(new Array<boolean>(HOOKS).fill(false)); paint(); } }),
      btn('Remove the last', () => { if (cards.length > 1) { cards.pop(); pick = Math.min(pick, PICKS); paint(); } })));
  paint();
  return { el, destroy: () => run.stop() };
}

// ---- Hollerith's tabulator --------------------------------------------------------------------
// A census card holds one person as holes in fields. The pin press drops a grid of spring pins onto the card: a
// pin that finds a hole dips into a cup of mercury and closes a circuit, and that circuit steps a dial on. A count of
// a combination (married women) runs through relay contacts, one per condition, in series.

const FIELDS: { name: string; opts: string[] }[] = [
  { name: 'Sex', opts: ['M', 'F'] },
  { name: 'Age', opts: ['0–19', '20–39', '40–59', '60+'] },
  { name: 'Married', opts: ['yes', 'no'] },
  { name: 'Born', opts: ['US', 'abroad'] },
];
const STACK = 60;

export function censusWidget(): Widget {
  const rnd = lcg(1890);
  const people = Array.from({ length: STACK }, () => {
    const age = Math.floor(rnd() * 4);
    return [rnd() < 0.51 ? 0 : 1, age, age > 0 && rnd() < 0.62 ? 0 : 1, rnd() < 0.85 ? 0 : 1];
  });
  let fed = 0;
  const counts = FIELDS.map((f) => f.opts.map(() => 0));
  let combo = 0;
  const run = ticker(140);

  const CW = 64, x0 = 70, y0 = 26;
  const card = s('svg', { viewBox: `0 0 ${x0 + 4 * CW + 20} ${y0 + FIELDS.length * 26 + 14}`, class: 'census-card', role: 'img', 'aria-label': 'The census card under the press' });
  const dials = h('div', { class: 'census-dials' });
  const info = h('p', { class: 'sub' });

  const paint = () => {
    card.replaceChildren(s('rect', { x: 2, y: 2, width: x0 + 4 * CW + 16, height: y0 + FIELDS.length * 26 + 8, rx: 4, class: 'census-body' }));
    const p = fed > 0 ? people[fed - 1] : null;
    card.append(s('text', { x: 10, y: 17, class: 'census-t' }, p ? `card ${fed} of ${STACK}, under the press` : 'the stack, waiting'));
    FIELDS.forEach((f, i) => {
      const y = y0 + i * 26;
      card.append(s('text', { x: 10, y: y + 13, class: 'census-t' }, f.name));
      f.opts.forEach((o, j) => {
        const on = p !== null && p[i] === j;
        card.append(s('rect', { x: x0 + j * CW, y: y + 2, width: 12, height: 14, rx: 6, class: `census-hole${on ? ' on' : ''}` }),
          s('text', { x: x0 + j * CW + 16, y: y + 13, class: 'census-o' }, o));
      });
    });
    dials.replaceChildren(...FIELDS.flatMap((f, i) => f.opts.map((o, j) => dial(`${f.name} ${o}`, counts[i][j], p !== null && p[i] === j))),
      dial('married women (two relays)', combo, p !== null && p[0] === 1 && p[2] === 0, true));
    info.textContent = fed === STACK ? `All ${STACK} cards counted: ${counts[0][1]} women, ${combo} of them married. The dials are the census.`
      : `${STACK - fed} cards left in the hopper.`;
  };
  const dial = (label: string, n: number, lit: boolean, relay = false) => {
    const a = (n / STACK) * 2 * Math.PI;
    return h('div', { class: `census-dial${lit ? ' lit' : ''}${relay ? ' relay' : ''}` },
      s('svg', { viewBox: '0 0 40 40', width: 40, height: 40 },
        s('circle', { cx: 20, cy: 20, r: 17, class: 'face' }),
        s('line', { x1: 20, y1: 20, x2: 20 + 14 * Math.sin(a), y2: 20 - 14 * Math.cos(a), class: 'hand' })),
      h('b', null, String(n)), h('span', null, label));
  };
  const press = () => {
    if (fed >= STACK) return false;
    const p = people[fed++];
    p.forEach((v, i) => { counts[i][v]++; });
    if (p[0] === 1 && p[2] === 0) combo++;
    paint();
    return fed < STACK;
  };
  const el = h('div', { class: 'widget cards-w' },
    h('div', { class: 'panel census' }, h('h3', null, 'The pin press and its dials'), card, dials, info),
    h('div', { class: 'panel cards-ctl' },
      btn('Press one card', () => { run.stop(); press(); }),
      btn('Run the stack', () => run.start(press)),
      btn('Reset', () => { run.stop(); fed = 0; combo = 0; counts.forEach((c) => c.fill(0)); paint(); })));
  paint();
  return { el, destroy: () => run.stop() };
}

// ---- the card editor --------------------------------------------------------------------------

export function cardEditorWidget(initial = 'HELLO, 1890 CENSUS'): Widget {
  let card = textCard(initial);
  const input = h('input', { type: 'text', maxlength: COLUMNS, value: initial, spellcheck: 'false', autocomplete: 'off', class: 'card-text', 'aria-label': 'Type a line to punch' }) as HTMLInputElement;
  const col = h('p', { class: 'sub card-col' });
  const warn = h('p', { class: 'sub bad' });
  const describe = (c: number) => {
    const m = card.cols[c];
    const ch = charOf(m);
    col.textContent = `Column ${c + 1}: ${m === 0 ? 'blank (a space)' : `holes in rows ${rowsOf(m)}`}${m === 0 ? '' : ch === null ? ', which is no character in the 029 code' : `, the character ${ch === ' ' ? 'space' : ch}`}.`;
  };
  const view = cardView(card, {
    label: 'The card being punched',
    onToggle: (c, r) => {
      card.cols[c] ^= 1 << r;
      card = { cols: card.cols, print: textOf(card) };
      input.value = card.print.replace(/·/g, '?');
      view.show(card);
      describe(c);
      warn.textContent = '';
    },
  });
  input.addEventListener('input', () => {
    card = textCard(input.value);
    view.show(card);
    const bad = unpunchable(input.value);
    warn.textContent = bad.length ? `The 029 has no code for ${bad.map((b) => `“${b}”`).join(' ')}: punched as ?` : '';
    describe(Math.max(0, Math.min(COLUMNS - 1, input.value.length - 1)));
  });
  // the code chart: every character with its holes
  const chart = h('div', { class: 'card-chart' }, ...CHARSET.filter((c) => c !== ' ').map((c) => {
    const b = h('button', { type: 'button', title: `punch ${c}` }, h('b', null, c), h('span', null, rowsOf(punchOf(c)!)));
    b.addEventListener('click', () => { if (input.value.length < COLUMNS) { input.value += c; input.dispatchEvent(new Event('input')); } });
    return b;
  }));
  describe(0);
  const el = h('div', { class: 'widget cards-w' },
    h('div', { class: 'panel' }, h('h3', null, 'An IBM card: 80 columns, 12 rows'),
      h('label', { class: 'card-type' }, h('span', null, 'Type'), input), warn, view.el, col),
    h('div', { class: 'panel' }, h('h3', null, 'The 029 code: a click punches the character'), chart));
  return { el };
}

// ---- a program on cards, and the card sorter ---------------------------------------------------

const SORT = PROGRAMS.find((p) => p.id === 'sort')!;

/** The bubble-sort sample as an object deck: one card a word, the source line printed. */
export function sampleDeck() {
  const a = assemble(SORT.source);
  return programDeck('sort.s', a.lines.map((l) => ({ word: l.word, source: l.text })));
}

export function deckWidget(): Widget {
  const deck = sampleDeck();
  let cards = deck.cards.slice();
  let sel = 0;
  const run = ticker(900);
  const list = h('div', { class: 'deck-list', role: 'listbox', 'aria-label': 'The deck, top card first' });
  const view = cardView(cards[0], { plain: false, label: 'The selected card' });
  const status = h('p', { class: 'sub' });
  const sorter = h('div', { class: 'sorter' });

  const paint = () => {
    list.replaceChildren(...cards.map((c, i) => {
      const b = h('button', { type: 'button', 'aria-selected': String(i === sel) },
        h('span', null, c.print.slice(SEQ_FROM)), h('span', null, hex8(wordOf(c))), h('span', null, c.print.slice(0, 38).trim().toLowerCase()));
      b.addEventListener('click', () => { sel = i; paint(); });
      return b;
    }));
    view.show(cards[sel]);
    view.mark([...Array.from({ length: 32 }, (_, k) => k), ...Array.from({ length: SEQ_LEN }, (_, k) => SEQ_FROM + k)], 'word');
    const ok = inSequence(cards);
    status.textContent = ok ? `${cards.length} cards in order: read top to bottom, they are the program.`
      : `${cards.length} cards out of order: loaded like this, the program is garbage.`;
    status.classList.toggle('bad', !ok);
  };

  const showPockets = (pockets: Card[][] | null, c: number | null, note: string) => {
    sorter.replaceChildren(h('p', { class: 'sub' }, note));
    if (!pockets) return;
    const max = Math.max(1, ...pockets.map((p) => p.length));
    sorter.append(h('div', { class: 'pockets' }, ...pockets.map((p, d) => h('div', { class: 'pocket' },
      h('div', { class: 'bar', style: `height:${(p.length / max) * 60}px` }), h('b', null, String(p.length)), h('span', null, d < 10 ? String(d) : 'R')))));
    if (c !== null) view.mark([c], 'read');
  };
  const sort = () => {
    run.stop();
    const todo = sorterColumns(cards);
    if (!todo.length) { showPockets(null, null, 'Nothing to sort.'); return; }
    let k = 0;
    showPockets(null, null, `Of the sequence columns 73–80, only ${todo.map((c) => c + 1).reverse().join(', ')} differ between the cards: the operator sorts on those, the rightmost first.`);
    run.start(() => {
      const c = todo[k];
      const pockets = sorterPass(cards, c);
      cards = pockets.flat();
      sel = 0;
      paint();
      showPockets(pockets, c, `Pass ${k + 1} of ${todo.length}: column ${c + 1} drops each card into the pocket of its digit; the pockets are stacked back 0 to 9.`);
      k++;
      if (k === todo.length) window.setTimeout(() => sorter.append(h('p', { class: 'sub' }, `Sorted in ${todo.length} passes of ${cards.length} cards: a radix sort, least significant digit first.`)), 50);
      return k < todo.length;
    });
  };

  const el = h('div', { class: 'widget cards-w' },
    h('div', { class: 'panel' }, h('h3', null, `${deck.name}: ${deck.cards.length} object cards`), view.el, status, sorter),
    h('div', { class: 'panel deck-side' }, h('div', { class: 'cards-ctl' },
      btn('Drop the deck', () => { run.stop(); cards = dropDeck(cards, (Date.now() & 0xffff) | 1); sel = 0; paint(); showPockets(null, null, 'Picked up off the floor.'); }),
      btn('Sort on the sorter', sort)), list));
  paint();
  return { el, destroy: () => run.stop() };
}

// ---- the card reader's panel -------------------------------------------------------------------

/** The card at the reader's station, its word columns marked, and where the reader is in its deck. */
export function readerPanel(stage: Stage): Widget {
  const view = cardView(blankCard(), { plain: true, label: 'The card at the read station' });
  const line = h('p', { class: 'sub' });
  const title = h('h4', null, 'The card at the read station', h('span', { class: 'fold-hint' }));
  const el = h('div', { class: 'mem-panel card-reader-panel', 'data-dock': 'left' }, title, view.el, line);
  title.addEventListener('click', () => el.classList.toggle('collapsed'));
  const update = () => {
    const sim = stage.sim;
    const r = sim ? readerLeaves(sim)[0] : undefined;
    if (!sim || !r) { line.textContent = ''; return; }
    const st = sim.leafState(r.li) as CardReaderState;
    const p = readerProgress(st);
    const at = p.at === null ? null : st.q[p.at];
    view.show(at === null ? blankCard() : textlessObject(at, p.at!));
    view.mark(p.at === null || p.feeding ? null : Array.from({ length: 32 }, (_, k) => k), 'word');
    line.textContent = p.at === null ? `Hopper empty: all ${p.cards} cards read.`
      : p.feeding ? `Feeding card ${p.at + 1} of ${p.cards} into the station…` : `Card ${p.at + 1} of ${p.cards} at the station: 0x${hex8(at!)}.`;
  };
  update();
  return { el, update };
}

/** An object card for a word alone (the reader holds words, not the printed source). */
function textlessObject(word: number, i: number): Card {
  const c = programDeck('', [{ word, source: ' ' }]).cards[0];
  const seq = String((i + 1) * 10).padStart(SEQ_LEN, '0');
  for (let k = 0; k < SEQ_LEN; k++) c.cols[SEQ_FROM + k] = punchOf(seq[k]) ?? 0;
  return { cols: c.cols, print: `${hex8(word).toUpperCase()}`.padEnd(SEQ_FROM) + seq };
}
