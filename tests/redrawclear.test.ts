import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib/cpu';
import { ethSegment } from '../src/lib/ethstation';
import { ethSwitch } from '../src/lib/ethswitch';
import { laneCore } from '../src/lib/lanes';
import { xlenCpu } from '../src/lib/cpu64';
import { warpCore } from '../src/lib/warps';
import { WARP_PROGRAMS } from '../src/riscv/warpprograms';
import { resolveComponent } from '../src/lib/resolve';
import { MC_FSM, MC_MICRO, multicycleCpu } from '../src/lib/multicycle';
import { pipelinedCpu } from '../src/lib/pipeline';
import { CSR_UNIT, systemCpu } from '../src/lib/system';
import { RELAY_BUZZER, RELAY_LATCH, RELAY_NAND } from '../src/lib/relays';
import { CATHODE_FOLLOWER, ECCLES_JORDAN, TUBE_BUF, TUBE_INV, TUBE_NAND, TUBE_NOR } from '../src/lib/tubes';
import { assemble } from '../src/riscv/asm';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { routeNetlist } from '../src/view/route';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';

// A wire is drawn under a part's body: run through one, it seems to vanish and come back somewhere else. The tests that
// check routing compare nets with nets, so a hand-drawn level is held to this here.
const w = assemble('j .').words;
const saxpy = WARP_PROGRAMS.find((p) => p.id === 'saxpy64')!;
const levels: [string, () => ComponentDef][] = [
  ['single-cycle', () => singleCycleCpu(w)],
  ['single-cycle, fast adders', () => singleCycleCpu(w, { adder: 'ks' })],
  ['single-cycle, write-through cache', () => singleCycleCpu(w, { adder: 'ks', dmemK: 6, dcache: true })],
  ['single-cycle, write-back cache', () => singleCycleCpu(w, { adder: 'ks', dmemK: 6, dcache: 'wb2' })],
  ['single-cycle, instruction cache', () => singleCycleCpu(w, { adder: 'ks', icache: true })],
  ['single-cycle, compressed', () => singleCycleCpu(w, { c: true })],
  ['pipeline', () => pipelinedCpu(w)],
  ['system', () => systemCpu(w)],
  ['CSR unit', () => CSR_UNIT],
  ['multicycle', () => multicycleCpu(w)],
  ['multicycle, microcode', () => multicycleCpu(w, { control: 'micro' })],
  ['state machine control', () => MC_FSM],
  ['microcode control', () => MC_MICRO],
  ['lane core', () => laneCore(w, 4)],
  // chapter 25's core at both widths, and the sandbox's RV64 cores (circuit eyeballing, phase 2)
  ['RV32I core, xlen drawing', () => xlenCpu(w, { xlen: 32 })],
  ['RV32IM core, xlen drawing', () => xlenCpu(w, { xlen: 32, m: true })],
  ['RV64I core', () => xlenCpu(w, { xlen: 64 })],
  ['RV64IM core', () => xlenCpu(w, { xlen: 64, m: true })],
  ['sandbox rv64i_core', () => resolveComponent('rv64i_core')!],
  ['sandbox rv64im_core', () => resolveComponent('rv64im_core')!],
  // the warp core: each lane's address, data and returning load straight between it and the memory under it
  ...([[4, 2], [4, 4], [8, 8]] as const).map(([W, n]): [string, () => ComponentDef] => [`warp core, ${W} warps × ${n} lanes`, () => warpCore(assemble(saxpy.source(n)).words, { warps: W, lanes: n, dmemK: 4 })]),
  // the prologue's relay and tube circuits (circuit eyeballing, phase 2a)
  ['relay NAND', () => RELAY_NAND],
  ['self-holding relay', () => RELAY_LATCH],
  ['relay buzzer', () => RELAY_BUZZER],
  ['tube inverter', () => TUBE_INV],
  ['two tube inverters', () => TUBE_BUF],
  ['tube NOR', () => TUBE_NOR],
  ['tube NAND', () => TUBE_NAND],
  ['cathode follower', () => CATHODE_FOLLOWER],
  ['Eccles–Jordan flip-flop', () => ECCLES_JORDAN],
  ['Ethernet segment', () => ethSegment(4)],
  ['Ethernet switch', () => ethSwitch({ cellK: 7 })],
];

describe('hand-drawn levels', () => {
  it.each(levels)('%s: no wire runs through a part', (_, make) => {
    const def = make();
    const nl = drawnNetlist(def, netlistOf(def)!);
    const hit = wiresThroughParts(nl, routeNetlist(def, nl).nets);
    expect([...hit].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0])).toEqual([]);
  });
});
