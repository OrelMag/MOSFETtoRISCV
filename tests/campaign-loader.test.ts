// Act P's card loader (h_loader): the bench passes the reference with its par, and fails a loader that never raises
// run, one that writes the cards to the wrong addresses, one that hard-codes the first deck's length (one card short on
// the second), and one whose run rises at the rising edge (the gated CPU clock then starts with half a pulse). The
// relay price leaves the given parts out. The CPU core is cpu4() without its ROM.

import { describe, expect, it } from 'vitest';
import { loaderDecks, loaderParts, loaderRelays, LOADER_PORTS, runLoader } from '../src/campaign/buildcard';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { checkChallenge } from '../src/editor/challenges';
import { UserLibrary } from '../src/editor/library';
import { Iss4 } from '../src/isa4/iss4';
import { constWord } from '../src/lib/alu';
import { Builder } from '../src/lib/builder';
import { busMux2, equal } from '../src/lib/combinational';
import { CPU4_CORE, IO4_OUTS } from '../src/lib/cpu4';
import { AND, NOT } from '../src/lib/gates';
import { counter, DFF } from '../src/lib/sequential';
import { TIE0, TIE1 } from '../src/lib/transistors';
import { stats } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';
import { workspace } from './editorkit';

interface Variant { run?: 'empty' | 'never' | 'count23'; runEdge?: 'falling' | 'rising'; countEn?: 'ready' | 'always'; spareRam?: boolean }

/** The reference loader's structure with one thing changed, as a user chip (so the relay count opens it). */
function loader(v: Variant = {}): ComponentDef {
  const { reader, ram, zero4 } = loaderParts();
  const b = new Builder(10, 12, 6);
  b.pins('clk');
  const one = b.op1(TIE1, []);
  const nclk = b.op1(NOT, ['clk']);
  b.next();
  const rd = b.op(reader, [one, 'clk'], undefined, 'reader');
  b.next();
  const cnt = b.op(counter(8), [v.countEn === 'always' ? one : `${rd}.ready`, 'clk']);
  const d = v.run === 'never' ? b.op1(TIE0, []) : v.run === 'count23' ? b.op1(equal(8), [`${cnt}.q`, b.op1(constWord(8, 23), [])]) : `${rd}.empty`;
  const run = b.op1(DFF, [d, v.runEdge === 'rising' ? 'clk' : nclk]);
  const gclk = b.op1(AND, ['clk', run]);
  b.next();
  const mux = b.op(busMux2(8), [`${cnt}.q`, '', run]);
  const mem = b.op(ram, [`${mux}.y`, `${rd}.data`, `${rd}.ready`, 'clk'], undefined, 'ram');
  const cpu = b.op(CPU4_CORE, [gclk, b.op1(TIE0, []), b.op1(zero4, []), `${mem}.dout`], undefined, 'cpu');
  b.wire(`${cpu}.pc`, `${mux}.b`);
  if (v.spareRam) b.op(ram, [`${mux}.y`, `${rd}.data`, `${rd}.ready`, 'clk'], undefined, 'ram2');
  b.wire(run, 'run');
  b.wire(`${cpu}.halt`, 'halt');
  for (const p of IO4_OUTS) b.wire(`${cpu}.${p}`, p);
  return {
    id: 'u_test_loader', name: 'loader', category: 'custom',
    ports: LOADER_PORTS.map((p) => ({ name: p.name, width: p.width, dir: p.dir, ...(p.clock ? { clock: true } : {}) })),
    symbol: { kind: 'box', label: 'LOADER' },
    netlist: () => ({ pins: {}, instances: b.instances, nets: b.nets() }),
  };
}

describe('the card loader level', () => {
  it('runs two decks of different lengths that halt, each with every output port written', () => {
    const [a, m] = loaderDecks();
    expect(a.words.length).not.toBe(m.words.length);
    for (const d of [a, m]) {
      const iss = new Iss4(d.words);
      iss.run(10000);
      expect(iss.halted, d.name).toBe(true);
      expect(d.ref.cards.length).toBe(d.words.length);
    }
  });

  it('passes the reference at par: 182 cycles to load both decks, its logic priced in relays without the given parts', () => {
    const n = nodeById('h_loader')!;
    const ch = levelChallenge(n)!;
    const chips = ch.answer();
    const main = chips[chips.length - 1];
    const c = new UserLibrary(workspace(main)).compiled(main.id)!;
    const r = checkChallenge(ch, c);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.score.cycles).toBe(n.par!.cycles);
    expect(r.score.relays).toBe(n.par!.relays);
    // A card every 4 edges: 1 + (n − 1)·4 cycles per deck.
    expect(r.score.cycles).toBe(loaderDecks().reduce((s, d) => s + 1 + (d.words.length - 1) * 4, 0));
    // The CPU alone is thousands of NANDs; the loader a couple of hundred relays.
    expect(stats(CPU4_CORE).nands).toBeGreaterThan(3000);
    expect(r.score.relays!).toBeLessThan(300);
    // The same structure built here passes too, at the same price.
    const v = runLoader(loader(), 'gate');
    expect(v.failures).toEqual([]);
    expect(v.cycles).toBe(r.score.cycles);
    expect(loaderRelays(loader())).toBe(r.score.relays);
  });

  it('fails a loader that never raises run', () => {
    const r = runLoader(loader({ run: 'never' }), 'gate');
    expect(r.failures.join('\n')).toMatch(/run never rose/);
    expect(r.failed).toEqual([0, 1]);
  });

  it('fails a loader that writes the cards to the wrong addresses', () => {
    // The counter counts every edge, not every card: card 1 lands in word 4.
    const r = runLoader(loader({ countEn: 'always' }), 'gate');
    expect(r.failures[0]).toMatch(/RAM word 1 holds .*card 2/);
    expect(r.failed).toEqual([0, 1]);
  });

  it('fails a loader that counts the first deck\'s cards: one card short on the second', () => {
    const r = runLoader(loader({ run: 'count23' }), 'gate');
    expect(r.failed).toEqual([1]);
    expect(r.failures.join('\n')).toMatch(/multiply.*run = 1 after \d+ cycles with 1 card still in the reader/);
  });

  it('fails a run taken at the rising edge: the gated clock clocks the CPU before its first word', () => {
    const r = runLoader(loader({ runEdge: 'rising' }), 'gate');
    expect(r.failures.length).toBeGreaterThan(0);
  });

  it('takes the given CPU and RAM once each: a second RAM is not free', () => {
    expect(runLoader(loader({ spareRam: true }), 'gate').failures.join()).toContain('one program memory (256 × 16 RAM), please');
  });

  it('refuses a switch-level chip (relay parts would price only themselves)', () => {
    expect(runLoader(loader(), 'switch').failures.join()).toMatch(/logic/);
  });
});

describe('the 4-bit CPU core', () => {
  it('is cpu4() without its ROM: an instruction port and the PC out', () => {
    const io = CPU4_CORE.ports.map((p) => `${p.dir} ${p.name}:${p.width}`);
    expect(io).toEqual(['in clk:1', 'in test:1', 'in sw:4', 'in instr:16', 'out pc:8', 'out d0:4', 'out d1:4', 'out d2:4', 'out d3:4', 'out leds:4', 'out halt:1']);
  });
});
