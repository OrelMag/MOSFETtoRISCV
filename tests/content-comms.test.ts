// Numbers and claims the Communication track's first two chapters type into their text, pinned to the models and circuits.
import { numOf } from '../src/chapters/order';
import { describe, expect, it } from 'vitest';
import { chapters } from '../src/chapters';
import { chExchange, chTelegraph } from '../src/chapters/ch-comm-relays';
import { ITA2_LETTERS, SPACE } from '../src/comm/codes';
import { clos } from '../src/comm/exchange';
import { MARKED } from '../src/comm/limits';
import { UART_8N1, stopIndex } from '../src/comm/startstop';
import { relay } from '../src/lib/relays';
import { CROSSBAR3, DIAL_COUNTER, DIAL_SELECTOR, countStage } from '../src/lib/telegraph';
import { RELAY_STEP_MS, relaySim, relaySummary } from '../src/phys/relay';
import { PULL_I, loopCurrent, reachKm } from '../src/phys/telegraph';
import { stats } from '../src/sim/stats';
import type { Chapter } from '../src/chapters/types';

const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
const text = (c: Chapter) => plain(c.steps.map((s) => s.body + Object.values(s.more ?? {}).join(' ')).join(' ') + (c.recap?.keep ?? []).join(' '));

describe('chapter 39 content', () => {
  it('the release time the repeater step quotes is the relay model\'s', () => {
    const release = relaySummary(relaySim(24)).release! * 1e3;
    expect(release).toBeCloseTo(3.4, 1);
    expect(text(chTelegraph)).toContain(`releases in 3.4 ms`);
    expect(RELAY_STEP_MS).toBe(8.2);
  });

  it('a 240 V battery is some two hundred cells, and the typed reaches follow the model', () => {
    expect(240 / 1.1).toBeGreaterThan(200);
    expect(240 / 1.1).toBeLessThan(230);
    expect(reachKm(240, 'iron')).toBeGreaterThan(reachKm(24, 'iron') * 9);
  });

  it('the quiz line fails alone and works with a repeater half way', () => {
    expect(loopCurrent(48, 150, 'iron')).toBeLessThan(PULL_I);
    expect(loopCurrent(48, 75, 'iron')).toBeGreaterThan(PULL_I);
    expect(loopCurrent(24, 80, 'iron')).toBeLessThan(PULL_I);
  });

  it('E, T and the space have a single hole each in ITA2', () => {
    const ones = (n: number) => n.toString(2).replace(/0/g, '').length;
    expect([ones(ITA2_LETTERS.get('E')!), ones(ITA2_LETTERS.get('T')!), ones(SPACE)]).toEqual([1, 1, 1]);
    expect(text(chTelegraph)).toContain('E and T, and the space have a single 1');
  });

  it('the V.34 line is the published rate on a 3.1 kHz voice channel', () => {
    const m = MARKED.find((x) => x.name === 'V.34 modem')!;
    expect([m.rate, m.B]).toEqual([33600, 3100]);
  });

  it('the ladder agrees with the chapters that exist, and the first two are these', () => {
    const bySuffix = new Map(chapters.filter((c) => c.num > 0 && c.level === 'Communication').map((c) => [c.num, c.title]));
    expect(bySuffix.get(numOf('telegraph'))).toBe('Two machines, one wire');
    expect(bySuffix.get(numOf('exchange'))).toBe('The telephone exchange');
    const step = chTelegraph.steps.at(-1)!.body;
    for (const [n, title] of bySuffix) expect(step, `${n}`).toContain(`<td>${n}</td><td>${title.replace('&', '&amp;')}</td>`);
  });
});

describe('chapter 40 content', () => {
  it('the counter is three relays a bit and one to hang up; the selector the same', () => {
    expect(stats(countStage(0)).relays).toBe(3);
    expect(stats(DIAL_COUNTER).relays).toBe(10);
    expect(stats(DIAL_SELECTOR).relays).toBe(10);
    expect(text(chExchange)).toContain('three per bit and one to hang up');
  });

  it('the contact tree is 1 + 2 + 4 = 7 poles, and the last relay holds 2 + 4 = 6', () => {
    const poles = (extra: number) => (countStage(extra).ports.length - 3) / 3;
    expect([poles(1), poles(2), poles(4)]).toEqual([1, 2, 4]);
    expect(relay(6).ports.length).toBe(2 + 3 * 6);
    expect(() => relay(7)).toThrow();
  });

  it('the crossbar is nine crosspoints and twelve control relays', () => {
    expect(stats(CROSSBAR3).relays).toBe(21);
    expect(stats(CROSSBAR3).relays - 9).toBe(12);
    expect(text(chExchange)).toContain('nine crosspoints and twelve to control them');
  });

  it('the Clos example is a valid strictly non-blocking network', () => {
    const c = clos(36, 3, 5)!;
    expect(c.r).toBe(12);
    expect(c.strict).toBe(true);
    expect(text(chExchange)).toContain('n = 3, r = 12, m = 5');
  });

  it('the 8N1 frame has K = 9 units before the stop, as the text says', () => {
    expect(stopIndex(UART_8N1)).toBe(9);
    expect(text(chExchange)).toContain('(K = 9)');
  });
});

describe('audit fixes', () => {
  it('the counter settles in at most the typed relay steps over 16 pulses', async () => {
    const { flatten } = await import('../src/sim/flatten');
    const { SwitchSim } = await import('../src/sim/switchsim');
    const sim = new SwitchSim(flatten(DIAL_COUNTER, { mode: 'switch' }));
    let rise = 0, fall = 0;
    for (let i = 0; i < 16; i++) {
      sim.setInput('pulse', 1); let t0 = sim.time; sim.settle(); rise = Math.max(rise, sim.time - t0);
      sim.setInput('pulse', 0); t0 = sim.time; sim.settle(); fall = Math.max(fall, sim.time - t0);
    }
    expect([rise, fall]).toEqual([2, 6]);
    expect(text(chExchange)).toContain('at most 2 relay steps and one that falls in at most 6');
  });
  it('back to back, 8N1 tolerates -5.0 % slow, the sweep agrees, and isolated results are unchanged', async () => {
    const { toleranceClosedForm, tolerance, ITA2_START_STOP } = await import('../src/comm/startstop');
    expect(toleranceClosedForm(UART_8N1, 0.5, true).slow).toBeCloseTo(0.05, 9);
    expect(toleranceClosedForm(UART_8N1).slow).toBeCloseTo(0.5 / 9, 9);
    expect(tolerance(UART_8N1, { backToBack: true }).slow).toBeCloseTo(0.05, 3);
    expect(toleranceClosedForm(ITA2_START_STOP, 0.5, true)).toEqual(toleranceClosedForm(ITA2_START_STOP));
    expect(tolerance(ITA2_START_STOP, { backToBack: true }).slow).toBeCloseTo(0.5 / 6, 3);
  });
  it('+11.3 % on the teleprinter frame reads 10000 as 00000 with the stop fine', async () => {
    const { receive, ITA2_START_STOP } = await import('../src/comm/startstop');
    const r = receive(ITA2_START_STOP, 0b10000, { err: 0.113 });
    expect([r.word, r.stopOk]).toEqual([0, true]);
  });
});
