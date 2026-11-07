// "A software radio": every step's prose is computed from code, so none of it may read NaN or undefined; the quizzes are well formed; the step that waits for the DSP core is listed, not built.

import { describe, expect, it } from 'vitest';
import { chSdr } from '../src/chapters/ch-dsp-sdr';
import { FS, receive, STATIONS, synthBand } from '../src/dsp/sdr';
import { BOOK_ORDER } from '../src/chapters/order';
import { dspRows } from '../src/chapters/dspladder';

describe('chapter "A software radio"', () => {
  it('keeps its receptions while the learner moves between steps and lets them go when the chapter is left', () => {
    const b = synthBand(FS), n = 4800;
    const r = receive(b, STATIONS[0].f, -20, n);
    expect(receive(b, STATIONS[0].f, -20, n)).toBe(r);
    chSdr.leave?.();
    expect(receive(b, STATIONS[0].f, -20, n)).not.toBe(r);
  });

  it('sits after Pictures, last of the level, and the ladder shows it', () => {
    const i = BOOK_ORDER.indexOf('sdr');
    expect(BOOK_ORDER[i - 1]).toBe('pictures');
    expect(dspRows().some((r) => r.id === 'sdr')).toBe(true);
  });
  it('its prose has no number that failed to compute', () => {
    expect(chSdr.steps.length).toBeGreaterThanOrEqual(8);
    for (const s of chSdr.steps) {
      expect(s.body.length).toBeGreaterThan(200);
      expect(s.body).not.toMatch(/NaN|undefined|Infinity|\[object/);
      expect(s.scene || s.widget).toBeTruthy();
      expect(s.challenge).toBeTruthy();
    }
  });
  it('every quiz has a reason for every wrong option and one right answer', () => {
    const quizzes = [...(chSdr.recap?.check ?? []), ...chSdr.steps.flatMap((s) => (s.challenge?.kind === 'quiz' ? [s.challenge] : []))];
    expect(chSdr.recap?.check?.length).toBe(3);
    for (const q of quizzes) {
      expect(q.options.length).toBe(4);
      const why = q.why ?? [];
      expect(why.length).toBe(q.options.length);
      why.forEach((w, i) => { if (i !== q.answer) expect(w.length).toBeGreaterThan(10); });
    }
  });
  it('lists the DSP core step as not built yet', () => {
    expect(chSdr.soon).toEqual(['The channel filter and the discriminator on the DSP core']);
  });
});
