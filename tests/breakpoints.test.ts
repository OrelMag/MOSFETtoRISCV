// Breakpoints (editor/breakpoints.ts): Run, runCycles and Step against conditions on a chip's signals; kept on the chip,
// outside the compile hash.

import { describe, expect, it } from 'vitest';
import { Breakpoints, resolveName } from '../src/editor/breakpoints';
import { type BreakDoc, type ChipDoc } from '../src/editor/model';
import { EditorSim, simKey } from '../src/editor/runtime';
import { sanitizeChip } from '../src/editor/store';
import { UserLibrary } from '../src/editor/library';
import { SCHEMA } from '../src/editor/model';
import { pack } from '../src/sim/values';
import { chip, compileLib, part, pin, wire } from './editorkit';

/** A 4-bit counter: q out, the counter's own carry-less outputs readable as c.q. */
const counter = (breaks?: BreakDoc[]): ChipDoc => chip('u_c', 'C', {
  pins: [{ ...pin('clk', 'in', [0, 10]), kind: 'clock' }, { ...pin('en', 'in', [0, 2]), value: 1 }, pin('q', 'out', [40, 4], 4)],
  parts: [part('c', { lib: 'counter4' }, [10, 0])],
  wires: [wire('w1', 'pin:en', 'c.en'), wire('w2', 'pin:clk', 'c.clk'), wire('w3', 'c.q', 'pin:q')],
  ...(breaks ? { breaks } : {}),
});

const setup = (doc: ChipDoc) => {
  const es = new EditorSim({ debounceMs: 0, budgetMs: 10_000 });
  es.update(compileLib(doc), doc.pins);
  const bp = new Breakpoints(es);
  bp.bind(doc);
  es.hz = Infinity;
  return { es, bp, count: () => pack(es.pinBits('q')!) };
};

describe('breakpoints', () => {
  it('resolve pins, part.port and paths into a part', () => {
    const doc = counter();
    const { es } = setup(doc);
    const root = es.sim!.design.root;
    expect(resolveName('q', doc, es.built!, root)?.length).toBe(4);
    expect(resolveName('c.q', doc, es.built!, root)).toEqual(root.ports.q);
    expect(resolveName('nothing', doc, es.built!, root)).toBeNull();
  });

  it('stop Run on the cycle where the condition holds, in cycle mode', () => {
    const { es, bp, count } = setup(counter([{ id: 'b1', cond: 'q == 5' }]));
    es.advance(1);
    expect(es.stoppedOnHalt).toBe(true);
    expect(es.stopReason).toBe('q == 5');
    expect(count()).toBe(5);
    expect(es.cycles).toBe(5);
    expect(bp.status('b1')).toMatchObject({ hits: 1, unknown: false, missing: [] });
    // Run again: the next time it holds (the counter wraps at 16)
    es.advance(1);
    expect(es.cycles).toBe(21);
    expect(bp.status('b1')!.hits).toBe(2);
  });

  it('stop runCycles (Step ×n, the CPU drawer\'s Run to halt) on the same cycle', () => {
    const { es } = setup(counter([{ id: 'b1', cond: 'q == 5' }]));
    expect(es.runCycles(100)).toBe(5);
    expect(es.stopReason).toBe('q == 5');
  });

  it('stop on the same cycle in gate mode', () => {
    const { es, count } = setup(counter([{ id: 'b1', cond: 'q[2] && q[0]' }]));
    es.setMode('gate');
    for (let i = 0; i < 100 && !es.stoppedOnHalt; i++) es.advance(1);
    expect(es.stoppedOnHalt).toBe(true);
    expect(count()).toBe(5);
    expect(es.cycles).toBe(5);
  });

  it('"every change" stops between two edges in gate mode, the moment the condition holds', () => {
    const run = (gate: boolean) => {
      const { es, count } = setup(counter([{ id: 'b1', cond: 'q == 5', ...(gate ? { gate: true as const } : {}) }]));
      es.setMode('gate');
      for (let i = 0; i < 500 && !es.stoppedOnHalt; i++) es.advance(1);
      return { stopped: es.stoppedOnHalt, q: count(), t: es.time };
    };
    const edge = run(false), fine = run(true);
    expect(fine).toMatchObject({ stopped: true, q: 5 });
    expect(fine.t).toBeLessThan(edge.t);
    // in cycle mode it is checked after each edge like the others
    const { es, count } = setup(counter([{ id: 'b1', cond: 'q == 5', gate: true }]));
    es.advance(1);
    expect([es.stoppedOnHalt, count(), es.cycles]).toEqual([true, 5, 5]);
  });

  it('rose() holds once per edge of its signal; a switched-off one and an unknown name never stop', () => {
    const { es, bp } = setup(counter([{ id: 'r', cond: 'rose(q[1])' }, { id: 'off', cond: 'q == 1', off: true }, { id: 'm', cond: 'nope == 1' }]));
    expect(es.runCycles(100)).toBe(2);
    expect(es.runCycles(100)).toBe(4);
    expect(bp.status('off')!.hits).toBe(0);
    expect(bp.status('m')).toMatchObject({ missing: ['nope'], unknown: true });
  });

  it('Step reports a hit but never stops; Run afterwards starts clean', () => {
    const { es, bp } = setup(counter([{ id: 'b1', cond: 'q == 1' }]));
    es.stepOnce();
    expect(bp.status('b1')!.hits).toBe(1);
    es.advance(1);
    expect(es.cycles).toBe(17);
  });

  it('a condition that does not parse says where', () => {
    const { bp } = setup(counter([{ id: 'b1', cond: 'q ==' }]));
    expect(bp.status('b1')!.error).toMatch(/at 5/);
  });

  it('PC breakpoints stop when the CPU drawer reports that instruction retired', () => {
    const { es, bp } = setup(counter([{ id: 'p', pc: 0x40 }]));
    expect(es.runCycles(3, () => { bp.pcRetired(es.cycles === 2 ? 0x40 : 0); return false; })).toBe(3);
    expect(es.stopReason).toBe('pc == 0x40');
  });

  it('are kept on the chip, survive the sanitizer, and are not compiled', () => {
    const a = counter(), b = counter([{ id: 'b1', cond: 'q == 5', gate: true }, { id: 'p', pc: 64, off: true }]);
    expect(sanitizeChip(JSON.parse(JSON.stringify(b)))).toEqual(b);
    expect(sanitizeChip({ ...b, breaks: [{ id: 'x' }, { id: 'y', pc: -1 }, { id: 'z', cond: 'a'.repeat(5000) }] } as unknown as ChipDoc)?.breaks).toBeUndefined();
    const lib = (d: ChipDoc) => new UserLibrary({ schema: SCHEMA, chips: { [d.id]: d }, open: [d.id] }).compiled(d.id)!;
    expect(lib(a).connKey).toBe(lib(b).connKey);
    expect(simKey(lib(a))).toBe(simKey(lib(b)));
  });
});
