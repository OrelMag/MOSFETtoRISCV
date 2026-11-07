import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib/cpu';
import { ethSegment } from '../src/lib/ethstation';
import { ethSwitch } from '../src/lib/ethswitch';
import { laneCore } from '../src/lib/lanes';
import { MC_FSM, MC_MICRO, multicycleCpu } from '../src/lib/multicycle';
import { pipelinedCpu } from '../src/lib/pipeline';
import { CSR_UNIT, systemCpu } from '../src/lib/system';
import { skewPair } from '../src/lib/seqdeep';
import { clockDivider } from '../src/lib/seqparts';
import { bcdAdder } from '../src/lib/adders';
import { assemble } from '../src/riscv/asm';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { routeNetlist } from '../src/view/route';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';

// A wire is drawn under a part's body: run through one, it seems to vanish and come back somewhere else. The tests that
// check routing compare nets with nets, so a hand-drawn level is held to this here.
const w = assemble('j .').words;
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
  ['Ethernet segment', () => ethSegment(4)],
  ['Ethernet switch', () => ethSwitch({ cellK: 7 })],
  // short pointers wired (circuit eyeballing, phase 2a)
  ['clock skew pair, 0 buffers', () => skewPair(0)],
  ['clock skew pair, 2 buffers', () => skewPair(2)],
  ['ripple clock divider ÷8', () => clockDivider(3)],
  ['ripple clock divider ÷16', () => clockDivider(4)],
  ['BCD adder, 2 digits', () => bcdAdder(2)],
  ['BCD adder, 4 digits', () => bcdAdder(4)],
];

describe('hand-drawn levels', () => {
  it.each(levels)('%s: no wire runs through a part', (_, make) => {
    const def = make();
    const nl = drawnNetlist(def, netlistOf(def)!);
    const hit = wiresThroughParts(nl, routeNetlist(def, nl).nets);
    expect([...hit].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0])).toEqual([]);
  });
});
