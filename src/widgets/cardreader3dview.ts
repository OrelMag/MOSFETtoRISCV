// The card reader in 3D (loaded on demand, modelhost.ts), feeding a computer. The reader is the chapter's leaf
// (cards/reader.ts) stepped edge by edge through its own behaviour (cardreader3dparts.ts ReaderRun): the card at the
// station, the feed delay, data / ready / empty are that leaf's. The computer is a loader that holds next (or not, as the
// learner sets it) and keeps each item it takes; the motion between edges is a drawing.

import '../styles/cardreader3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { COLUMNS, type Deck } from '../cards/card';
import { readerProgress, type ReaderMode } from '../cards/reader';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import { ReaderRun, readerAnchors, readerLayout, readerParts, type ReaderPalette } from './cardreader3dparts';
import type { OrbitView } from '../gl/camera';

/** The rows by bit (bit 0 row 12 … bit 11 row 9). */
const ROW_NAMES = ['12', '11', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
/** Edges a second on Run: a card a second or so row by row; column by column, about two seconds a card. */
const RATE: Record<ReaderMode, number> = { word: 2, column: 40 };
/** The share of a period the motion takes, and a stepped edge's motion. */
const MOVE = 0.75, STEP_MS = 420;
const VIEWS: Record<ReaderMode, OrbitView> = {
  word: { target: [-2, 16, -8], yaw: 0.32, pitch: 0.55, dist: 290 },
  column: { target: [14, 10, -10], yaw: 0.72, pitch: 0.58, dist: 410 },
};
/** The read station up close. */
const CLOSE: Record<ReaderMode, OrbitView> = {
  word: { target: [-4, 10, 10], yaw: 0.55, pitch: 0.62, dist: 95 },
  column: { target: [0, 10, 0], yaw: 0.65, pitch: 0.55, dist: 85 },
};
const hex = (w: number, d = 8) => `0x${(w >>> 0).toString(16).padStart(d, '0')}`;

export function readerView(deck: Deck, feed: number, sources: readonly string[]): Widget {
  let mode: ReaderMode = 'word', run = new ReaderRun(deck, mode, feed), next: 0 | 1 = 1, running = false;
  // u: how far the motion since the last edge has gone (1 settled); tau: the running clock's phase within a period.
  let u = 1, tau = 0, stepT = -1;
  // The station close-up (the button is made with the controls below; a draw can come first, from the renderer).
  let close = false, closeBtn: HTMLButtonElement | null = null;

  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    aria: 'A card reader in 3D feeding a computer: a hopper of punched cards, a picker knife, feed rolls, the read station and a stacker, and the computer’s panel of lamps',
    camera: { ...VIEWS.word },
    limits: { minDist: 70, maxDist: 800 },
    note: 'Sizes are the card’s; the brushes, rolls and timing are drawn, not modelled: here a card waits at the station until it is taken, as the reader part does, where a real reader read it on the move against a timing wheel.',
    draw: () => paint(),
  });
  const palette = (): ReaderPalette => ({
    frame: stage.rgb('--m3-si'), bed: stage.rgb('--cr-bed'), card: stage.rgb('--cr-card'), hole: stage.rgb('--cr-hole'), metal: stage.rgb('--m3-metal'),
    brass: stage.rgb('--cr-brass'), live: stage.rgb('--m3-charge'), lampOff: stage.rgb('--cr-lamp'), panel: stage.rgb('--cr-panel'),
    beam: stage.rgba('--cr-beam', 0.55), rubber: stage.rgb('--cr-rubber'),
  });
  function paint(): void {
    const L = readerLayout(run, u);
    if (closeBtn) closeBtn.hidden = stage.isFlat(); // the flat view has one fixed view
    stage.paint(readerParts(run, L, next, palette()), readerAnchors(run, L));
  }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), mem = h('ol', { class: 'cr-mem' });
  const memHead = h('h4', null, 'The computer’s memory');
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);

  /** The item the computer took last of the current card's columns: row 9 of columns 1–32 shifted into a word. */
  const columnWord = (): { word: number; got: number } => {
    const p = readerProgress(run.st), n = run.taken.length;
    let k = p.at ?? p.cards;
    if (n - k * COLUMNS <= 0 && k > 0) k--; // between cards: the one just read
    const cols = run.taken.slice(k * COLUMNS, k * COLUMNS + 32);
    let w = 0;
    for (const c of cols) w = w * 2 + ((c >> 11) & 1);
    return { word: (w * 2 ** (32 - cols.length)) >>> 0, got: cols.length };
  };

  function status(): string {
    const p = readerProgress(run.st), [data, ready, empty] = run.out;
    if (empty) return `Hopper empty: all ${p.cards} cards read in ${run.edges} edges.`;
    if (p.feeding) return `Feeding card ${p.at! + 1} of ${p.cards}: ${run.st.wait} more edge${run.st.wait > 1 ? 's' : ''} before it is at the station.`;
    const what = mode === 'word' ? `card ${p.at! + 1} of ${p.cards} at the station, data ${hex(data)}` : `card ${p.at! + 1}, column ${p.column + 1} under the cells, data ${hex(data, 3)}`;
    return `${ready ? 'Ready' : 'Waiting'}: ${what}.${next ? '' : ' next is 0: the computer takes nothing.'}`;
  }

  function readout(announce = false): void {
    const p = readerProgress(run.st), [data, ready, empty] = run.out;
    chip.textContent = empty ? 'Empty' : p.feeding ? 'Feeding' : ready ? (next ? 'Ready: taken at the next edge' : 'Ready, waiting for next') : '';
    chip.className = `r3-chip ${empty ? '' : p.feeding ? 'warn' : 'good'}`;
    const rows: [string, string][] = [['Clock edges', String(run.edges)]];
    if (mode === 'word') {
      rows.push(['Card at the station', p.at === null ? 'none' : p.feeding ? `card ${p.at + 1} on its way` : `${p.at + 1} of ${p.cards}`]);
      rows.push(['data (row 9, columns 1–32)', hex(data)]);
    } else {
      rows.push(['Card', p.at === null ? 'none' : `${p.at + 1} of ${p.cards}${p.feeding ? ', on its way' : ''}`]);
      rows.push(['Column at the station', p.at === null || p.feeding ? '–' : `${p.column + 1} of ${COLUMNS}`]);
      const holes = ROW_NAMES.filter((_, r) => (data >> r) & 1);
      rows.push(['data (12 rows)', `${hex(data, 3)}${holes.length ? ` · rows ${holes.join(', ')}` : ' · no hole'}`]);
      const cw = columnWord();
      rows.push(['Row 9 of columns 1–32', cw.got ? `${hex(cw.word)} (${cw.got} of 32)` : '–']);
    }
    rows.push(['ready · empty · next', `${ready} · ${empty} · ${next}`], [mode === 'word' ? 'Cards taken' : 'Columns taken', String(run.taken.length)]);
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    if (mode === 'word') {
      memHead.textContent = 'The computer’s memory';
      const last = run.taken.slice(-4), base = run.taken.length - last.length;
      mem.replaceChildren(...(last.length ? last.map((w, i) => h('li', null, h('code', null, `${hex(0x400 + 4 * (base + i), 3)}: ${hex(w)}`), ` ${sources[base + i] ?? ''}`))
        : [h('li', { class: 'cr-none' }, 'Nothing taken yet.')]));
    } else {
      memHead.textContent = 'Cards the computer has words from';
      const done = Math.floor(run.taken.length / COLUMNS);
      mem.replaceChildren(...(done ? Array.from({ length: Math.min(done, 4) }, (_, i) => {
        const k = done - Math.min(done, 4) + i, cols = run.taken.slice(k * COLUMNS, k * COLUMNS + 32);
        let w = 0; for (const c of cols) w = w * 2 + ((c >> 11) & 1);
        return h('li', null, h('code', null, `card ${k + 1}: ${hex(w >>> 0)}`), ` ${sources[k] ?? ''}`);
      }) : [h('li', { class: 'cr-none' }, 'No whole card yet.')]));
    }
    runBtn.textContent = running ? 'Pause' : 'Run';
    runBtn.setAttribute('aria-pressed', String(running));
    runBtn.disabled = stepBtn.disabled = empty === 1;
    takeBtn.setAttribute('aria-pressed', String(next === 1));
    // Read out on a step or a stop, not at every edge of a run (the line still follows it on screen).
    live.setAttribute('aria-live', running && !announce ? 'off' : 'polite');
    const text = status();
    if (live.textContent !== text) live.textContent = text;
  }

  function edge(): void { run.edge(next); }
  const loop = frameLoop((now, dt) => {
    if (running) {
      tau += dt * RATE[mode];
      while (tau >= 1 && !run.out[2]) { tau -= 1; edge(); }
      u = reducedMotion() ? 1 : Math.min(1, tau / MOVE);
      if (run.out[2]) { u = 1; if (run.leftEdge < run.st.e || tau >= MOVE) { running = false; readout(true); } }
    } else if (stepT >= 0) {
      u = Math.min(1, (now - stepT) / STEP_MS);
      if (u >= 1) stepT = -1;
    }
    readout(); paint();
  }, () => running || stepT >= 0);
  const kick = () => { readout(); paint(); loop.kick(); };

  const runBtn = h('button', { type: 'button', class: 'btn sm primary', 'aria-pressed': 'false' }, 'Run') as HTMLButtonElement;
  runBtn.addEventListener('click', () => {
    if (run.out[2]) return;
    running = !running; tau = 0; stepT = -1; u = 1;
    if (!running) readout(true);
    kick();
  });
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step one edge') as HTMLButtonElement;
  stepBtn.addEventListener('click', () => {
    if (run.out[2]) return;
    running = false; edge();
    if (reducedMotion()) { u = 1; stepT = -1; } else { u = 0; stepT = performance.now(); }
    readout(true); kick();
  });
  const takeBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'true' }, 'next = 1: take cards') as HTMLButtonElement;
  takeBtn.addEventListener('click', () => { next = next ? 0 : 1; takeBtn.textContent = next ? 'next = 1: take cards' : 'next = 0: hold'; readout(true); kick(); });
  const resetBtn = h('button', { type: 'button', class: 'btn sm' }, 'Deck back in the hopper');
  const restart = () => { run = new ReaderRun(deck, mode, feed); running = false; u = 1; tau = 0; stepT = -1; readout(true); kick(); };
  resetBtn.addEventListener('click', restart);
  const modeBtns = (['word', 'column'] as const).map((m) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(m === mode) }, m === 'word' ? 'Row by row (711)' : 'Column by column (2501)') as HTMLButtonElement;
    b.addEventListener('click', () => {
      if (mode === m) return;
      mode = m;
      modeBtns.forEach((x, i) => { const on = (['word', 'column'] as const)[i] === m; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
      stage.setView({ ...(close ? CLOSE : VIEWS)[m] });
      restart();
    });
    if (m === mode) b.classList.add('on');
    return b;
  });
  const cb = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false' }, 'Close-up of the station') as HTMLButtonElement;
  closeBtn = cb;
  cb.addEventListener('click', () => {
    close = !close;
    cb.setAttribute('aria-pressed', String(close));
    cb.textContent = close ? 'Whole machine' : 'Close-up of the station';
    stage.setView({ ...(close ? CLOSE : VIEWS)[mode] });
  });

  panel.append(
    h('h3', { class: 'm3-title' }, 'The reader itself'),
    h('p', { class: 'm3-sub' }, `The same ${deck.cards.length}-card deck and the same reader part as the step before, ${feed} edges to feed each card. A picker knife slides the bottom card out of the hopper, feed rolls carry it to the read station and on to the stacker. Row by row, as on an IBM 711, the card goes 9 edge first under a brush over every column; a brush that finds a hole touches the contact roll below, and row 9 of columns 1–32 is the word. Column by column, as on an IBM 2501, a lamp shines through one column at a time onto twelve photocells, and each take moves the card on a column. The lamps behind are the wires to the computer: data, ready, empty, and its next.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' },
          h('div', { class: 'seg cr-seg', role: 'group', 'aria-label': 'Which reader' }, ...modeBtns),
          h('div', { class: 'r3-btns' }, runBtn, stepBtn, takeBtn, resetBtn, closeBtn, stage.resetBtn)),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('h4', null, 'This reader ', h('span', { class: 'r3-badge' }, 'the chapter’s part')), kv, memHead, mem)));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) { running = false; readout(true); kick(); } });
  readout(true);
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
