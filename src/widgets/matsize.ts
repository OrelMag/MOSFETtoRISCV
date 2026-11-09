// Chapter 22's mat-size explorer: a megabyte of SRAM cut into mats of R rows × C columns, and what the shape costs. The
// delays are relative to a 256 × 256 mat and follow two textbook first-order rules: a word line is a distributed RC line
// (resistance and capacitance both grow with its length, so its delay with the square of the columns it crosses), and the
// selected cell discharges its bit line with a roughly constant current, so the time to the sense amplifier's ~100 mV grows
// with the line's capacitance, the rows on it. The area model is illustrative and said so on the panel.

import { groupDigits } from '../sim/numfmt';
import { h } from '../ui/dom';
import type { ScenePanel, Stage, Widget } from '../view/stage';

/** A megabyte, in bits. */
export const MB_BITS = 8 * 2 ** 20;
/** Bits read per access (the scene's memory is 1M × 8). */
export const MAT_WORD = 8;
/** The reference mat the delays are relative to. */
export const MAT_REF = 256;
/** Illustrative periphery, in cell pitches: the row decoder and word-line drivers beside a mat, precharge, column mux and sense amplifiers below it. */
export const DEC_STRIP = 12, SENSE_STRIP = 24;
export const MAT_MIN_LOG = 6, MAT_MAX_LOG = 12;

export interface MatShape {
  rows: number; cols: number;
  /** Mats in the megabyte (0 when one mat would hold more). */
  mats: number;
  /** Address bits: the mat, the row in it, the word's column group. */
  matBits: number; rowBits: number; colBits: number;
  /** Relative to a 256 × 256 mat. */
  wordLine: number; bitLine: number; charge: number;
  /** Cells over cells + the mat's decoder and sense strips. */
  cellShare: number;
}

export function matShape(rowsLog: number, colsLog: number): MatShape {
  const rows = 2 ** rowsLog, cols = 2 ** colsLog;
  const per = rows * cols, mats = per > MB_BITS ? 0 : MB_BITS / per;
  return {
    rows, cols, mats,
    matBits: mats ? Math.log2(mats) : 0, rowBits: rowsLog, colBits: colsLog - Math.log2(MAT_WORD),
    wordLine: (cols / MAT_REF) ** 2,
    bitLine: rows / MAT_REF,
    // the selected mat precharges and swings every bit line it has, each as long as its rows
    charge: per / (MAT_REF * MAT_REF),
    cellShare: per / ((rows + SENSE_STRIP) * (cols + DEC_STRIP)),
  };
}

const times = (x: number) => `${x < 1 ? x.toFixed(2) : x < 10 ? x.toFixed(1) : Math.round(x)}×`;
const group = groupDigits;

export const matSizePanel: ScenePanel = (_stage: Stage): Widget => {
  const slider = (label: string, value: number) => {
    const input = h('input', { type: 'range', min: MAT_MIN_LOG, max: MAT_MAX_LOG, value, 'aria-label': label }) as HTMLInputElement;
    const out = h('b', null, '');
    return { input, out, row: h('label', { class: 'mat-slider' }, h('span', null, label, ' ', out), input) };
  };
  const r = slider('Rows per mat', 8), c = slider('Columns per mat', 8);
  const split = h('div', { class: 'mat-split' });
  const table = h('table', { class: 'mat-table', 'aria-live': 'polite' });
  const title = h('h4', null, 'Cut a megabyte into mats', h('span', { class: 'fold-hint' }));
  const note = h('p', { class: 'mat-note' },
    `Delays relative to ${MAT_REF} × ${MAT_REF}. Area: a ${DEC_STRIP}-cell decoder strip beside each mat and a ${SENSE_STRIP}-cell sense strip below it, an illustrative model.`);
  const el = h('div', { class: 'mem-panel mat-panel', 'data-dock': 'right', 'data-fold': 'narrow' }, title, r.row, c.row, split, table, note);
  const bar = (x: number, warn: boolean) => h('div', { class: 'mat-meter' + (warn ? ' warn' : '') }, h('i', { style: `width:${Math.min(100, x * 100)}%` }));
  const row = (k: string, v: string, fill?: number, warn = false) =>
    h('tr', { class: warn ? 'warn' : '' }, h('td', null, k, fill === undefined ? null : bar(fill, warn)), h('td', null, v));
  const update = () => {
    const s = matShape(Number(r.input.value), Number(c.input.value));
    r.out.textContent = group(s.rows); c.out.textContent = group(s.cols);
    if (!s.mats) {
      split.textContent = 'One mat that size holds more than the megabyte.';
      table.replaceChildren();
      return;
    }
    split.textContent = `Address: ${s.matBits} mat + ${s.rowBits} row + ${s.colBits} column bits = ${s.matBits + s.rowBits + s.colBits}`;
    // a meter is full at 16× (and the share at 100 %); past 4× or under 70 % it is marked
    table.replaceChildren(
      row('Mats', group(s.mats)),
      row('Word-line delay', times(s.wordLine), s.wordLine / 16, s.wordLine > 4),
      row('Bit line to 100 mV', times(s.bitLine), s.bitLine / 16, s.bitLine > 4),
      row('Bit-line charge per read', times(s.charge), s.charge / 16, s.charge > 4),
      row('Cells in the mat area', `${Math.round(s.cellShare * 100)} %`, s.cellShare, s.cellShare < 0.7),
    );
  };
  r.input.addEventListener('input', update);
  c.input.addEventListener('input', update);
  update();
  return { el };
};
