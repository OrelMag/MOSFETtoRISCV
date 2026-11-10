// The machine hall's card reader (lib/hallcards.ts): the deck is the program the hall's CPU runs, the card each cycle fetches
// is the gate-level CPU's PC, and the ledger, the passes round the loop and the program store's price are pinned (the
// chapter's numbers come from here).
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { wordOf } from '../src/cards/card';
import { hallCpu, hallFacts, hallLayout, periodIn, STORE_BLOCK } from '../src/lib/hall';
import { CARD_S, defaultFeed, HallFeed, hallProgram, programStore, READER_711 } from '../src/lib/hallcards';
import { price } from '../src/lib/tech';
import { clockCycle } from '../src/riscv/cosim';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { pack } from '../src/sim/values';

describe('the hall\'s deck', () => {
  it('is the program the hall\'s CPU holds, a card a word', () => {
    for (const d of ['rv32i', 'cpu4'] as const) {
      const p = hallProgram(d);
      expect(p.deck.cards.map((c) => wordOf(c, p.bits))).toEqual(p.words.slice(0, p.deck.cards.length).map((w) => w >>> 0));
    }
    expect(hallProgram('rv32i').deck.cards.length).toBe(11);
    expect(hallProgram('cpu4').deck.cards.length).toBe(9);
  });

  it('fetches the card at the gate-level CPU\'s PC every cycle (RV32I)', () => {
    const d = flatten(hallCpu('rv32i').def), sim = new DualSim(d);
    for (const p of hallCpu('rv32i').def.ports) if (p.dir === 'in') sim.setInput(p.name, 0);
    sim.reset('zero'); sim.settle();
    const feed = new HallFeed('rv32i', 'stream', 1);
    for (let k = 0; k < 90; k++) {
      expect(feed.peek(), `cycle ${k}`).toBe(pack(sim.getBits(d.root.ports.pcOut)) / 4);
      feed.cycle();
      clockCycle(sim);
    }
  });
});

describe('the reader against the machine', () => {
  const runToHalt = (f: HallFeed) => { let last = -1; for (let i = 0; i < 1000 && !f.outOfCards; i++) { const k = f.peek(); if (k === last && f.instructions > 0) break; last = k; f.cycle(); } return f; };
  const per = (t: 'relay' | 'tube') => periodIn(hallFacts('rv32i').steps, t);

  it('keeps up with the relay machine: no waiting, the loop deck goes round 11 times', () => {
    const f = runToHalt(new HallFeed('rv32i', 'stream', per('relay')));
    expect(f.instructions).toBe(77);
    expect(f.passes).toBe(11);
    expect(f.read).toBe(77);
    expect(f.ledger.wait).toBe(0);
    expect(f.ledger.compute).toBeCloseTo(77 * 1.271, 6);
    expect(f.instrTime).toBeCloseTo(1.271, 6);
    expect(defaultFeed('relay')).toBe('stream');
  });

  it('idles the tube machine when read as it runs; loading first costs 4.4 s once', () => {
    const s = runToHalt(new HallFeed('rv32i', 'stream', per('tube')));
    expect(s.instrTime).toBe(CARD_S);
    expect(s.ledger.wait / (s.ledger.wait + s.ledger.compute)).toBeGreaterThan(0.9996);
    expect(Math.round(CARD_S / per('tube'))).toBe(2607);
    const l = runToHalt(new HallFeed('rv32i', 'load', per('tube')));
    expect(l.ledger.load).toBeCloseTo(11 * 0.4, 9);
    expect(l.ledger.wait).toBe(0);
    expect(l.read).toBe(11);
    expect(l.ledger.compute * 1000).toBeCloseTo(11.8, 1);
    expect(defaultFeed('tube')).toBe('load');
  });

  it('prices the program store and stands it in the hall as a block of its own', () => {
    expect(price(programStore('rv32i'), 'relay', null)!.devices).toBe(11082);
    expect(price(programStore('rv32i'), 'tube', null)!.devices).toBe(15147);
    expect(price(programStore('cpu4'), 'relay', null)!.devices).toBe(5606);
    for (const t of ['relay', 'tube'] as const) {
      const cpu = hallCpu('rv32i').def, plain = hallLayout(cpu, t), withStore = hallLayout(cpu, t, programStore('rv32i'));
      const store = withStore.blocks.find((b) => b.name === STORE_BLOCK)!;
      expect(store.devices).toBe(price(programStore('rv32i'), t, null)!.devices);
      expect(withStore.total.devices).toBe(plain.total.devices + store.devices);
      expect(withStore.cabinets.reduce((s, c) => s + c.devices, 0)).toBe(withStore.total.devices);
    }
  });

  it('draws the IBM 711 at its planning size', () => {
    expect(READER_711.w).toBeCloseTo(0.8128, 4);
    expect(READER_711.h).toBeCloseTo(0.8033, 4);
    expect(Math.round(READER_711.kg)).toBe(254);
  });
});
