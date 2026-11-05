// Steps moved after going live keep the learner's progress with them. The table starts empty, so the mechanism is tested on rows of its
// own (pushed for one test), and the real table's rows are held to the book. Moving a step in the three chapters below needs a row.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX } from '../src/campaign/codex';
import { moreOf } from '../src/campaign/codexmore';
import { chapters } from '../src/chapters';
import { movedAddress, moveKey, moveProgress, moveStep, STEP_MOVES, type StepMove } from '../src/chapters/stepmoves';
import { BACKUP_FORMAT, mergeBackup, MapKV, SETTINGS_KEY } from '../src/ui/backup';
import { mergeNotes, sanitizeNotes } from '../src/ui/notes';
import { mergeReview, sanitizeReview } from '../src/ui/review';

/** The steps of the chapters with moves planned, as they went live. A later rename here must keep the row's title too. */
const LIVE: Record<string, string[]> = {
  modem: ['A channel built for voices', 'Tones: FSK', 'An oscillator from an adder', 'FSK in gates', 'Phase and amplitude', 'Noise decides how many points', '300 b/s to 56 kb/s', 'Many tones, one FFT', 'ADSL: many carriers'],
  serial: ['No clock on the wire', '8b/10b and running disparity', 'Scrambling instead', 'A SerDes in gates', 'Finding the clock in the data', 'A wave is a sum of sines', 'The eye diagram', 'Equalization', 'PAM4', 'Fibre'],
  errors: ['One extra bit', 'Locating the error', 'A remainder as a check', 'How good is a check?', 'CRC in gates, a bit a clock', 'A byte at a time', 'Where a frame starts', 'Asking again', 'Correcting instead of asking', 'A code with memory', 'The Viterbi decoder', 'Reed-Solomon: errors in bytes', 'Bursts: interleaving', 'How far from Shannon'],
};

const title = (id: string, i: number) => chapters.find((c) => c.id === id)?.steps[i]?.title;

describe('the table of moves', () => {
  it('each row names the step now at its target', () => {
    for (const batch of STEP_MOVES) {
      // a later batch may have moved it again: the title stands for the place it reached
      for (const m of batch) {
        const at = moveStep(m.to, m.toStep, STEP_MOVES.indexOf(batch) + 1);
        expect(title(at.chapter, at.step), `${m.from}:${m.step}`).toBe(m.title);
      }
    }
  });
  it('a step of a chapter that went live is where it was, or has a row', () => {
    for (const [id, steps] of Object.entries(LIVE)) steps.forEach((t, i) => {
      const at = moveStep(id, i);
      expect(title(at.chapter, at.step), `${id}:${i} "${t}" moved with no row in chapters/stepmoves.ts`).toBe(t);
    });
  });
});

describe('links to steps', () => {
  it('a codex entry\'s link into a chapter with moves planned names the step it opens', () => {
    for (const e of CODEX) for (const l of moreOf(e.id)?.chapters ?? []) {
      if (l.chapter in LIVE) expect(title(l.chapter, l.step ?? 0), `${e.id}: ${l.chapter}:${l.step}`).toBe(l.label);
    }
  });
});

describe('moving progress', () => {
  const rows: StepMove[] = [
    { from: 'serial', step: 5, to: 'signals', toStep: 0, title: 'sines' },
    { from: 'serial', step: 6, to: 'serial', toStep: 5, title: 'eye' },
    { from: 'errors', step: 9, to: 'codes', toStep: 0, title: 'memory' },
  ];
  const table = STEP_MOVES as StepMove[][], shipped = table.length;
  beforeEach(() => { table.push(rows); });
  afterEach(() => { table.length = shipped; });

  it('a step goes to its row, a batch at a time, and a shift does not chain within a batch', () => {
    expect(moveStep('serial', 6)).toEqual({ chapter: 'serial', step: 5 });
    expect(moveStep('serial', 5)).toEqual({ chapter: 'signals', step: 0 });
    expect(moveStep('serial', 4)).toEqual({ chapter: 'serial', step: 4 });
    expect(moveStep('serial', 6, shipped + 1)).toEqual({ chapter: 'serial', step: 6 });
  });
  it('keys follow their step; a recap, a codex entry and a chapter with no row stay', () => {
    expect(moveKey('serial:6')).toBe('serial:5');
    expect(moveKey('errors:9:read:2')).toBe('codes:0:read:2');
    expect(moveKey('predict:serial:5:1')).toBe('predict:signals:0:1');
    for (const k of ['serial:recap:0', 'codex:crc:6', 'mosfet:6', 'drill:serial']) expect(moveKey(k)).toBe(k);
  });
  it('settings: ticks, steps seen and the last step follow, once', () => {
    const st = moveProgress({ visited: { serial: [4, 5, 6], errors: [9] }, solved: { 'serial:6': true, 'serial:recap:1': true }, last: { chapter: 'errors', step: 9 }, theme: 'dark' });
    expect(st.visited).toEqual({ serial: [4, 5], signals: [0], codes: [0] });
    expect(st.solved).toEqual({ 'serial:5': true, 'serial:recap:1': true });
    expect(st.last).toEqual({ chapter: 'codes', step: 0 });
    expect(st.theme).toBe('dark');
    expect(JSON.parse(JSON.stringify(moveProgress(JSON.parse(JSON.stringify(st)))))).toEqual(st);
  });
  it('notes, bookmarks and review memos follow; what has seen the batch stays', () => {
    const item = { id: 'n1', type: 'note', text: 'hi', at: 1, edited: 1, place: { kind: 'step', chapter: 'serial', step: 6 } };
    expect(sanitizeNotes({ items: { n1: item } }).items.n1.place).toEqual({ kind: 'step', chapter: 'serial', step: 5 });
    const again = JSON.parse(JSON.stringify(sanitizeNotes({ items: { n1: item } })));
    expect(sanitizeNotes(again).items.n1.place).toEqual({ kind: 'step', chapter: 'serial', step: 5 });
    const memo = { n: 1, last: 1, streak: 1, due: 2 };
    const rv = sanitizeReview({ memos: { 'serial:6': memo, 'codex:crc:0': memo } });
    expect(Object.keys(rv.memos).sort()).toEqual(['codex:crc:0', 'serial:5']);
    expect(Object.keys(sanitizeReview(JSON.parse(JSON.stringify(rv))).memos).sort()).toEqual(['codex:crc:0', 'serial:5']);
  });
  it('a merge of two stores counts as up to date', () => {
    expect(mergeNotes(sanitizeNotes({ items: {} }), sanitizeNotes({ items: {} })).moved).toBe(shipped + 1);
    expect(mergeReview(sanitizeReview({ memos: {} }), sanitizeReview({ memos: {} })).moved).toBe(shipped + 1);
  });
  it('an old backup file is brought up to date before it merges with what is here', () => {
    const here = new MapKV([[SETTINGS_KEY, JSON.stringify({ visited: { serial: [5] }, solved: {}, moved: shipped + 1 })]]);
    const old = { format: BACKUP_FORMAT as typeof BACKUP_FORMAT, schema: 1, keys: { [SETTINGS_KEY]: JSON.stringify({ visited: { serial: [6] }, solved: { 'serial:6': true } }) } };
    const st = JSON.parse(mergeBackup(old, here).writes[SETTINGS_KEY]);
    expect(st.visited.serial).toEqual([5]);
    expect(st.solved).toEqual({ 'serial:5': true });
  });
  it('an old backup file on an empty store is brought up to date too, and merged again counts nothing twice', () => {
    const empty = new MapKV();
    const old = { format: BACKUP_FORMAT as typeof BACKUP_FORMAT, schema: 1, keys: { [SETTINGS_KEY]: JSON.stringify({ visited: { serial: [6] }, solved: {} }) } };
    const w = mergeBackup(old, empty).writes[SETTINGS_KEY];
    expect(JSON.parse(w).visited).toEqual({ serial: [5] });
    empty.setItem(SETTINGS_KEY, w);
    expect(JSON.parse(mergeBackup(old, empty).writes[SETTINGS_KEY]).visited).toEqual({ serial: [5] });
  });
  it('an old address past the chapter\'s end goes to the step; within the chapter it stays today\'s', () => {
    expect(movedAddress('errors', 9, 8)).toEqual({ chapter: 'codes', step: 0 });
    expect(movedAddress('errors', 9, 9)).toBeNull();
    expect(movedAddress('serial', 6, 9)).toBeNull();
    expect(movedAddress('errors', 40, 8)).toBeNull();
  });
});
