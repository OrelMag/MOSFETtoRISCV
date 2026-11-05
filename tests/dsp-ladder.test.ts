// Every chapter of the signal processing level has a row in its ladder, in book order, and the first chapter draws what is built.
import { describe, expect, it } from 'vitest';
import { chapters } from '../src/chapters';
import { chFixed } from '../src/chapters/ch-dsp-fixed';
import { DSP_LADDER, DSP_LEVEL, dspRows } from '../src/chapters/dspladder';
import { BOOK_ORDER, numOf } from '../src/chapters/order';
import { SECTIONS } from '../src/chapters/sections';

const level = chapters.filter((c) => c.level === DSP_LEVEL);

describe('the signal processing ladder', () => {
  it('has a row for each chapter of the level, with its title, in book order', () => {
    const rows = dspRows();
    expect(rows.map((r) => r.id)).toEqual(level.map((c) => c.id));
    for (const c of level) expect(rows.find((r) => r.id === c.id)!.title, c.id).toBe(c.title);
    expect(rows.map((r) => r.num)).toEqual(level.map((c) => c.num));
    const ids = DSP_LADDER.map((r) => r.id).filter((id) => (BOOK_ORDER as readonly string[]).includes(id));
    expect([...ids].sort((a, b) => BOOK_ORDER.indexOf(a as never) - BOOK_ORDER.indexOf(b as never))).toEqual(ids);
  });
  it('comes after Communication and before the appendices, in a section of its own', () => {
    expect(numOf('fixed')).toBe(numOf('bench') + 1);
    expect(numOf('appendix-6502')).toBeGreaterThan(Math.max(...level.map((c) => c.num)));
    expect(SECTIONS.some((s) => s.first === 'fixed' && s.name.startsWith('Signal processing'))).toBe(true);
  });
  it('is drawn on the first step, every row linked', () => {
    for (const r of dspRows()) expect(chFixed.steps[0].body).toContain(`href="#/c/${r.id}/0"`);
  });
  it('types no chapter number', () => {
    const src = import.meta.glob('../src/chapters/ch-dsp-*.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
    for (const [f, text] of Object.entries(src)) expect(text, f).not.toMatch(/chapter \d/i);
  });
});
