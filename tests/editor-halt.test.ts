import { describe, expect, it } from 'vitest';
import { compileChip } from '../src/editor/compile';
import { type ChipDoc, type PartRef } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { loadWorkspace, saveWorkspace, type KV } from '../src/editor/store';
import { pack } from '../src/sim/values';
import { chip, compileLib, part, pin, wire, workspace } from './editorkit';

/** A 4-bit counter whose q[3] (count 8) or a whole-bus halt stops Run. */
const counter = (halt: PartRef = { display: 'halt' }, bus = false): ChipDoc => chip('u_c', 'C', {
  pins: [{ ...pin('clk', 'in', [0, 10]), kind: 'clock' }, { ...pin('en', 'in', [0, 2]), value: 1 }, pin('q', 'out', [40, 4], 4)],
  parts: [part('c', { lib: 'counter4' }, [10, 0]), part('s', { split: [3, 1] }, [26, 2]), part('h', halt, [34, 10])],
  wires: [
    wire('w1', 'pin:en', 'c.en'), wire('w2', 'pin:clk', 'c.clk'), wire('w3', 'c.q', 'pin:q'),
    wire('w4', { wire: 'w3', at: [24, 4] }, 's.in'),
    bus ? wire('w5', { wire: 'w3', at: [30, 4] }, 'h.a') : wire('w5', 's.o1', 'h.a'),
  ],
});

const count = (es: EditorSim) => pack(es.pinBits('q')!);

describe('halt part', () => {
  it('is a zero-cost view that survives a save', () => {
    const d = partDef({ display: 'halt' }, () => undefined);
    expect('error' in d).toBe(false);
    if ('error' in d) return;
    expect(d.prim).toBe('alias');
    expect(d.alias).toEqual([]);
    const m = new Map<string, string>();
    const kv: KV = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
    saveWorkspace(workspace(counter()), kv);
    expect(loadWorkspace(kv).chips.u_c.parts[2].ref).toEqual({ display: 'halt' });
  });

  it('stops Run after the cycle where its input goes high, and again after each step while high', () => {
    const doc = counter();
    const es = new EditorSim({ debounceMs: 0 });
    es.update(compileLib(doc), doc.pins);
    expect(es.hasHalt).toBe(true);
    expect(es.halted).toBe(false);
    es.hz = Infinity;
    es.advance(1);
    expect(es.stoppedOnHalt).toBe(true);
    expect(count(es)).toBe(8);
    expect(es.cycles).toBe(8);
    expect(es.halted).toBe(true);
    // Level sensitive: Run again advances one cycle (count 9, q[3] still 1) and stops.
    es.advance(1);
    expect(es.stoppedOnHalt).toBe(true);
    expect(count(es)).toBe(9);
    // Step ignores it; past 15 the counter wraps to 0 and Run goes on to the next 8.
    for (let i = 0; i < 7; i++) es.stepOnce();
    expect(count(es)).toBe(0);
    expect(es.halted).toBe(false);
    es.advance(1);
    expect(es.cycles).toBe(24);
  });

  it('stops runCycles too', () => {
    const doc = counter();
    const es = new EditorSim({ debounceMs: 0 });
    es.update(compileLib(doc), doc.pins);
    expect(es.runCycles(100)).toBe(8);
  });

  it('on a bus halts on any 1 bit', () => {
    const doc = counter({ display: 'halt', width: 4 }, true);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(compileLib(doc), doc.pins);
    expect(es.runCycles(100)).toBe(1);
  });

  it('halts from inside a placed chip, at any depth', () => {
    const inner = counter();
    const mid = chip('u_m', 'M', {
      pins: [{ ...pin('clk', 'in', [0, 0]), kind: 'clock' }, { ...pin('en', 'in', [0, 2]), value: 1 }],
      parts: [part('i', { chip: 'u_c' }, [10, 0])],
      wires: [wire('a', 'pin:clk', 'i.clk'), wire('b', 'pin:en', 'i.en')],
    });
    const top = chip('u_t', 'T', {
      pins: [{ ...pin('clk', 'in', [0, 0]), kind: 'clock' }, { ...pin('en', 'in', [0, 2]), value: 1 }],
      parts: [part('m', { chip: 'u_m' }, [10, 0])],
      wires: [wire('a', 'pin:clk', 'm.clk'), wire('b', 'pin:en', 'm.en')],
    });
    const defs = new Map<string, ReturnType<typeof compileChip>>();
    const comp = (d: ChipDoc) => {
      const c = compileChip(d, (ref) => partDef(ref, (id) => defs.get(id)?.def));
      defs.set(d.id, c);
      return c;
    };
    comp(inner);
    comp(mid);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(comp(top), top.pins);
    expect(es.hasHalt).toBe(true);
    expect(es.runCycles(100)).toBe(8);
    expect(es.halted).toBe(true);
  });
});
