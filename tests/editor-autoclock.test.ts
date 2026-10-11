import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ChipDoc, type PartRef } from '../src/editor/model';
import { AUTO_HZ, EditorSim } from '../src/editor/runtime';
import { B0, B1 } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { chip, compileLib, part, pin, wire } from './editorkit';

// The run loop only needs requestAnimationFrame to exist: these tests never let a frame run.
const g = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
beforeAll(() => {
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
});
afterAll(() => {
  g.requestAnimationFrame = saved.raf;
  g.cancelAnimationFrame = saved.caf;
});

/** A 4-bit counter (without its clock pin while `clocked` is false), optionally with an extra part. */
const counter = (clocked = true, extra?: PartRef): ChipDoc => chip('u_c', 'C', {
  pins: [...(clocked ? [{ ...pin('clk', 'in', [0, 10]), kind: 'clock' as const }] : []), { ...pin('en', 'in', [0, 2]), value: 1 }, pin('q', 'out', [40, 4], 4)],
  parts: [part('c', { lib: 'counter4' }, [10, 0]), ...(extra ? [part('x', extra, [30, 12])] : [])],
  wires: [wire('w1', 'pin:en', 'c.en'), ...(clocked ? [wire('w2', 'pin:clk', 'c.clk')] : []), wire('w3', 'c.q', 'pin:q')],
});

const simOf = (doc: ChipDoc) => {
  const es = new EditorSim({ debounceMs: 0 });
  es.update(compileLib(doc), doc.pins);
  return es;
};

describe('automatic clock', () => {
  it('starts a clocked chip once, at AUTO_HZ', () => {
    const es = simOf(counter());
    expect(es.autoStart()).toBe(true);
    expect(es.running).toBe(true);
    expect(es.hz).toBe(AUTO_HZ);
    es.pause();
    expect(es.autoStart()).toBe(false); // a pause sticks
    expect(es.running).toBe(false);
    es.destroy();
  });

  it('waits for a clock pin, and starts one added later even after Run / Step / Pause', () => {
    const doc = counter(false);
    const es = simOf(doc);
    expect(es.hasClock).toBe(false);
    expect(es.autoStart()).toBe(false);
    es.stepOnce();
    es.start();
    es.pause(); // the user has had the run bar: no auto start for this chip any more…
    expect(es.autoStart()).toBe(false);
    const wired = counter(true);
    es.update(compileLib(wired), wired.pins);
    expect(es.autoStart()).toBe(true); // …until a clock appears
    es.pause();
    es.update(compileLib(wired), wired.pins); // an edit keeping the clock: the pause sticks
    expect(es.autoStart()).toBe(false);
    es.update(compileLib(doc), doc.pins); // the clock deleted, then placed again
    es.update(compileLib(wired), wired.pins);
    expect(es.autoStart()).toBe(true);
    es.destroy();
  });

  it('a clock pin placed alone ticks on the board', () => {
    const lone = chip('u_k', 'K', { pins: [{ ...pin('clk', 'in', [0, 10]), kind: 'clock' }] });
    const es = simOf(lone);
    expect(es.autoStart()).toBe(true);
    es.advance(0.25, Infinity);
    expect(es.pinBits('clk')).toEqual([B1]);
    es.advance(0.25, Infinity);
    expect(es.pinBits('clk')).toEqual([B0]);
    es.destroy();
  });

  it('gives way to the user: Step, a clock clicked by hand, Run / Pause, a mode change, runCycles', () => {
    const acts: [string, (es: EditorSim) => void][] = [
      ['step', (es) => es.stepOnce()],
      ['clock pin', (es) => es.toggleClocks()],
      ['pause', (es) => es.pause()],
      ['mode', (es) => es.setMode('cycle')],
      ['runCycles', (es) => es.runCycles(1)],
    ];
    for (const [name, act] of acts) {
      const es = simOf(counter());
      act(es);
      expect(es.autoStart(), name).toBe(false);
      es.destroy();
    }
  });

  it('Step and a clock clicked by hand pause a running clock', () => {
    for (const act of [(es: EditorSim) => es.stepOnce(), (es: EditorSim) => es.toggleClocks()]) {
      const es = simOf(counter());
      es.autoStart();
      act(es);
      expect(es.running).toBe(false);
      es.destroy();
    }
  });

  it('Run shows the clock high for the first half of each period; Pause completes the cycle', () => {
    const es = simOf(counter());
    es.hz = 2;
    const clk = () => es.pinBits('clk')![0];
    const q = () => pack(es.pinBits('q')!);
    expect(es.advance(0.25, Infinity)).toBe(1); // the rising edge
    expect(clk()).toBe(B1);
    expect([es.cycles, q()]).toEqual([1, 1]);
    es.advance(0.25, Infinity); // the fall: no new edge
    expect(clk()).toBe(B0);
    expect([es.cycles, q()]).toEqual([1, 1]);
    es.advance(0.25, Infinity);
    expect(clk()).toBe(B1);
    es.start();
    es.pause();
    expect(clk()).toBe(B0);
    expect([es.cycles, q()]).toEqual([2, 2]);
    es.stepOnce(); // a whole cycle from low
    expect([clk(), es.cycles, q()]).toEqual([B0, 3, 3]);
    es.destroy();
  });

  it('stays off in gate mode and with a keyboard part', () => {
    const gate = simOf(counter());
    gate.mode = 'gate';
    expect(gate.autoStart()).toBe(false);
    gate.destroy();
    const kbd = simOf(counter(true, { keyboard: true }));
    expect(kbd.hasKeyboard).toBe(true);
    expect(kbd.autoStart()).toBe(false);
    kbd.destroy();
  });
});
