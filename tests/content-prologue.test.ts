// Numbers the prologue and chapters 1–2 quote that are typed, not computed in place: each is read from the text and
// compared with a measurement, so a change to either side fails here.
import { describe, expect, it } from 'vitest';
import { chInverter } from '../src/chapters/ch-transistors';
import { chRelays } from '../src/chapters/ch-relays';
import { chTubes } from '../src/chapters/ch-tubes';
import { INV_CMOS, INV_PSEUDO } from '../src/lib';
import { cpu4 } from '../src/lib/cpu4';
import { RELAY_POWER, withoutParts } from '../src/lib/tech';
import { relaySim, relaySummary } from '../src/phys/relay';
import { stats } from '../src/sim/stats';
import type { Chapter } from '../src/chapters/types';

const step = (ch: Chapter, title: string) => {
  const s = ch.steps.find((x) => x.title === title);
  if (!s) throw new Error(`no step "${title}" in ${ch.id}`);
  return s;
};
const num = (text: string, re: RegExp) => {
  const m = text.match(re);
  if (!m) throw new Error(`${re} not found in: ${text.slice(0, 200)}`);
  return Number(m[1].replace(/\s/g, ''));
};
const quiz = (ch: Chapter, title: string) => {
  const c = step(ch, title).challenge;
  if (!c || c.kind !== 'quiz') throw new Error(`no quiz on "${title}"`);
  return c;
};

describe('prologue content', () => {
  it("the buzzer step quotes the relay model's release time", () => {
    const release = relaySummary(relaySim(24)).release! * 1e3;
    const quoted = num(step(chRelays, 'A relay that cannot stop').body, /releases\s+([\d.]+) ms after its current stops/);
    expect(quoted).toBeCloseTo(release, 1);
  });

  it('the 4-bit CPU is the size both prologue chapters say, and the relay quiz prices it right', () => {
    const n = stats(withoutParts(cpu4(new Array(256).fill(0)), ['rom'])).nands;
    const tubes = num(quiz(chTubes, 'What it costs').question, /about ([\d ]+) NANDs without its ROM/);
    expect(tubes).toBe(n);
    const relays = quiz(chRelays, 'What it costs');
    const relaysN = num(relays.question, /about ([\d ]+) NANDs without its ROM/);
    expect(Math.abs(relaysN - n) / n).toBeLessThan(0.05);
    const kw = num(relays.options[relays.answer], /([\d.]+) kW/);
    expect(kw).toBeCloseTo((relaysN * RELAY_POWER) / 1e3, 1);
  });
});

describe('chapter 2 content', () => {
  it('pseudo-NMOS: one transistor and a resistor here, as many devices as CMOS at one input', () => {
    const p = stats(INV_PSEUDO), c = stats(INV_CMOS);
    expect([p.transistors, p.resistors]).toEqual([1, 1]);
    expect(p.transistors + p.resistors).toBe(c.transistors);
    expect(step(chInverter, 'The cheaper, hotter way: a pull-up').body).toContain('no device saved at one input');
  });

  it("the three-input NOR question marks the textbook count (a grounded-gate PMOS load) right", () => {
    const q = chInverter.recap!.check!.find((x) => x.question.includes('three-input NOR'))!;
    expect(q.options[q.answer]).toMatch(/grounded-gate PMOS, so 4 transistors\), against 6/);
    q.options.forEach((o, i) => { if (i !== q.answer) expect(o).not.toMatch(/^4 transistors/); });
  });
});
