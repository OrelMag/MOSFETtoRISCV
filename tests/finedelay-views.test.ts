// Load-dependent delay reaching the sandbox and the readouts (docs/PLAN-FINEDELAY.md, stage 3): EditorSim rebuilds on the
// other model when the setting changes, keeping the state; the unit model's readouts and VCD stay exactly as they were.

import { describe, expect, it } from 'vitest';
import type { ChipDoc } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { fmtTime, nextStepTime } from '../src/sim/edge';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { PS_PER_UNIT } from '../src/sim/delay';
import { rca } from '../src/lib/combinational';
import { pack } from '../src/sim/values';
import { toVcd } from '../src/sim/vcd';
import { chip, compileLib, part, pin, wire } from './editorkit';

const counter = (): ChipDoc => chip('u_c', 'C', {
  pins: [{ ...pin('clk', 'in', [0, 10]), kind: 'clock' }, { ...pin('en', 'in', [0, 2]), value: 1 }, pin('q', 'out', [40, 4], 4)],
  parts: [part('c', { lib: 'counter4' }, [10, 0])],
  wires: [wire('w1', 'pin:en', 'c.en'), wire('w2', 'pin:clk', 'c.clk'), wire('w3', 'c.q', 'pin:q')],
});

describe('the sandbox under load-dependent delay', () => {
  it('a setting change rebuilds the gate-level simulation on the other model, the count carried; no change, no rebuild', () => {
    let model: 'unit' | 'load' = 'unit';
    const doc = counter();
    const es = new EditorSim({ debounceMs: 0, budgetMs: 10_000, delay: () => model });
    es.update(compileLib(doc), doc.pins);
    es.runCycles(5);
    const q = () => pack(es.pinBits('q')!);
    expect(q()).toBe(5);
    expect(es.sim!.ticksPerUnit ?? 1).toBe(1);
    const unitSim = es.sim;
    es.delayChanged();
    expect(es.sim).toBe(unitSim);
    model = 'load';
    es.delayChanged();
    expect(es.sim!.ticksPerUnit).toBe(10);
    expect(q()).toBe(5);
    es.runCycles(3);
    expect(q()).toBe(8);
    model = 'unit';
    es.delayChanged();
    expect(es.sim!.ticksPerUnit ?? 1).toBe(1);
    expect(q()).toBe(8);
  });
});

describe('readouts', () => {
  it('times read as before under the unit model, with one decimal under load', () => {
    expect(fmtTime({}, 12)).toBe('12');
    expect(fmtTime({ ticksPerUnit: 1 }, 7)).toBe('7');
    expect(fmtTime({ ticksPerUnit: 10 }, 12)).toBe('12.0');
    expect(fmtTime({ ticksPerUnit: 10 }, 2.3000000001)).toBe('2.3');
  });

  it('a step is one unit under the unit model, the next change under load', () => {
    const unit = new GateSim(flatten(rca(4), { mode: 'gate' }));
    unit.setInput('a', 15); unit.setInput('b', 1);
    expect(nextStepTime(unit)).toBe(unit.time + 1);
    const load = new GateSim(flatten(rca(4), { mode: 'gate' }), { delay: 'load' });
    load.setInput('a', 15); load.setInput('b', 1);
    const t = nextStepTime(load);
    expect(t).toBe(load.nextEventTime());
    expect(nextStepTime(load, load.time + 0.2)).toBeLessThanOrEqual(load.time + 0.2);
  });

  it('VCD: unchanged under the unit model; picoseconds under load, tenths kept apart', () => {
    const sig = [{ name: 'a', width: 1, t: [0, 3, 7], v: [0, 1, 0] }];
    expect(toVcd(sig, { scope: 's' })).toBe([
      '$version From Switch to CPU logic analyzer $end', '$comment 1 time unit = 1 NAND gate delay $end', '$timescale 1ns $end',
      '$scope module s $end', '$var wire 1 ! a $end', '$upscope $end', '$enddefinitions $end',
      '#0', '$dumpvars', '0!', '$end', '#3', '1!', '#7', '0!', '',
    ].join('\n'));
    const fine = toVcd([{ name: 'a', width: 1, t: [0, 1.2, 1.3], v: [0, 1, 0] }], { scope: 's', loaded: true });
    expect(fine).toContain('$timescale 1ps $end');
    expect(fine).toContain(`#${Math.round(1.2 * PS_PER_UNIT)}`);
    expect(fine).toContain(`#${Math.round(1.3 * PS_PER_UNIT)}`);
    expect(Math.round(1.2 * PS_PER_UNIT)).not.toBe(Math.round(1.3 * PS_PER_UNIT));
  });
});
