// Chapter 45's typed numbers: what the prose states by hand is pinned here to the models and circuits it describes.

import { describe, expect, it } from 'vitest';
import { chModem } from '../src/chapters/ch-comm-modem';
import { chapterById } from '../src/chapters';
import { ADSL, BELL103, FS, ncoSnrDb, MODEMS } from '../src/comm/modem';
import { FSK_LINK, FSK_RX, FSK_TX, NCO, SINE_ROM } from '../src/lib';
import { stats } from '../src/sim/stats';
import { linkScene, ncoScene } from '../src/widgets/modem';

describe('chapter 45 typed numbers', () => {
  it('is chapter 45, nine steps, builds on earlier chapters, and has both kinds of explainer', () => {
    expect(chModem.num).toBe(45);
    expect(chModem.steps).toHaveLength(9);
    expect(chapterById('modem')).toBe(chModem);
    for (const id of chModem.builds ?? []) expect(chapterById(id)!.num).toBeLessThan(45);
    expect(chapterById('appendix-6502')!.num).toBeGreaterThan(45);
    for (const s of chModem.steps) expect(!!s.scene !== !!s.widget).toBe(true);
    expect(chModem.recap!.check).toHaveLength(3);
  });
  it('the scenes are the gate circuits the steps name', () => {
    expect(ncoScene().root).toBe(NCO);
    expect(linkScene().root).toBe(FSK_LINK);
    const names = FSK_LINK.netlist!().instances.map((i) => i.name);
    expect(names).toEqual(['tx', 'line', 'rx']);
    expect(NCO.netlist!().instances.map((i) => i.name)).toEqual(expect.arrayContaining(['acc', 'add', 'sine']));
  });
  it('step 3: the sine table is most of the oscillator, and the oscillator most of the transmitter', () => {
    expect(stats(SINE_ROM).nands / stats(NCO).nands).toBeGreaterThan(0.75);
    expect(stats(FSK_TX).nands).toBeGreaterThan(stats(NCO).nands);
    expect(stats(FSK_RX).nands).toBeLessThan(stats(NCO).nands / 5);
  });
  it('step 3: the oscillator\'s own SNR is 30 dB, below the 35 dB the chapter assumes for the line', () => {
    expect(ncoSnrDb()).toBeGreaterThan(29.5);
    expect(ncoSnrDb()).toBeLessThan(31);
  });
  it('step 2: cycles a bit of each tone', () => {
    expect(BELL103.originate.space / BELL103.baud).toBeCloseTo(3.57, 2);
    expect(BELL103.originate.mark / BELL103.baud).toBeCloseTo(4.23, 2);
  });
  it('step 4: the answering tones are less than a clock apart in period at 19 200 Hz', () => {
    expect(FS / BELL103.answer.space - FS / BELL103.answer.mark).toBeLessThan(1);
    expect(FS / BELL103.originate.space - FS / BELL103.originate.mark).toBeGreaterThan(2);
  });
  it('step 9: a symbol every 250 microseconds, ten dB is about three bits', () => {
    expect(1e6 / ADSL.symbolRate).toBe(250);
    expect(Math.log2(10)).toBeCloseTo(3.32, 2);
  });
  it('step 7: the table has Bell 103 to V.90 in order of rate', () => {
    const rates = MODEMS.map((m) => m.rate);
    expect(rates).toEqual([...rates].sort((a, b) => a - b));
  });
});
