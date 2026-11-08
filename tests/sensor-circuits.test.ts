import { describe, expect, it } from 'vitest';
import { columnAdcRow, PIXEL_4T } from '../src/lib/sensor';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';
import { SwitchSim, weakTag } from '../src/sim/switchsim';
import type { Sim } from '../src/sim/sim';

const netOf = (sim: SwitchSim, name: string) => sim.design.root.nets![PIXEL_4T.netlist!().nets.findIndex((n) => n.name === name)][0];

/** Drive the pixel through reset, exposure and one CDS readout; return the column after the reset and after the transfer. */
function readPixel(lit: boolean) {
  const sim = new SwitchSim(flatten(PIXEL_4T, { mode: 'switch' }));
  const set = (k: Record<string, number>) => { for (const [p, v] of Object.entries(k)) sim.setInput(p, v); sim.settle(); };
  const col = netOf(sim, 'col'), fd = netOf(sim, 'FD'), pd = netOf(sim, 'PD');
  set({ rst: 1, tx: 1, light: 0, sel: 0 }); // empty the photodiode and FD
  const pdReset = sim.level(pd);
  set({ rst: 0, tx: 0 }); // exposure
  if (lit) { set({ light: 1 }); set({ light: 0 }); }
  set({ rst: 1, sel: 1 }); set({ rst: 0 }); // RST, then SHR
  const reset = { col: sim.get(col), tag: weakTag(sim.weakOf(col)) };
  set({ tx: 1 }); set({ tx: 0 }); // TX, then SHS
  return { pdReset, reset, signal: sim.get(col), fd: sim.level(fd) };
}

describe('the 4T pixel at switch level', () => {
  it('empties its photodiode with RST and TX together', () => {
    expect(readPixel(false).pdReset).toBe(1);
  });
  it('reads a dark pixel as H on the column, a threshold below the supply, before and after the transfer', () => {
    const r = readPixel(false);
    expect(r.reset.col).toBe(1);
    expect(r.reset.tag).toMatch(/^H/);
    expect(r.signal).toBe(1);
    expect(r.fd).toBe(1);
  });
  it('pulls FD below the 0 threshold when a full photodiode shares its charge, and the column drops to 0', () => {
    const r = readPixel(true);
    expect(r.reset.col).toBe(1);
    expect(r.fd).toBeLessThan(0.3);
    expect(r.signal).toBe(0);
  });
});

/** Run a row of column ADCs through a reset conversion (down) and a signal conversion (up). */
function convert(n: number, resets: number[], signals: number[]) {
  const def = columnAdcRow(n, resets.length);
  const sim: Sim = new GateSim(flatten(def));
  sim.reset('zero');
  const port = (p: string) => sim.design.root.ports[p];
  const set = (k: Record<string, number>) => { for (const [p, v] of Object.entries(k)) sim.setInput(p, v); sim.settle(); };
  const clock = () => { set({ clk: 1 }); set({ clk: 0 }); };
  set({ clk: 0, go: 0, start: 1, clr: 1, up: 0 });
  clock();
  set({ clr: 0 });
  for (const [phase, levels] of [[0, resets], [1, signals]] as const) {
    levels.forEach((v, c) => sim.setInput(`v${c}`, v));
    set({ up: phase, start: 1, go: 0 }); clock(); // ramp to 0
    set({ start: 0, go: 1 });
    for (let i = 0; i < 2 ** n; i++) clock();
    set({ go: 0 });
  }
  return resets.map((_, c) => {
    const raw = pack(sim.getBits(port(`d${c}`)));
    return raw >= 2 ** n ? raw - 2 ** (n + 1) : raw; // two's complement, n + 1 bits
  });
}

describe('column ADCs with digital CDS', () => {
  it('counts signal − reset in every column, whatever each column\'s reset level', () => {
    expect(convert(5, [3, 7, 0, 12], [20, 7, 31, 13])).toEqual([17, 0, 31, 1]);
  });
  it('cancels an offset common to both samples', () => {
    const plain = convert(4, [2], [9]), shifted = convert(4, [5], [12]);
    expect(plain).toEqual(shifted);
  });
});
