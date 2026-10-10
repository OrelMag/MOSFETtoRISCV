// Every top-level CPU the chapters show, in each variant. They are built by generators that do not
// register the top level itself (only its parts), so the schematic tests list them explicitly.

import {
  dualCore, multicycleCpu, pipelinedCpu, pipelinedFpCpu, singleCycleCpu, systemCpu,
} from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { CACHE_CPU_PROGRAMS } from '../src/riscv/cprograms';
import { PROGRAMS } from '../src/riscv/programs';
import type { ComponentDef } from '../src/sim/types';
import { wordRom } from '../src/editor/parts';
import { bigRam } from '../src/lib/bigmem';

export function cpuTops(): ComponentDef[] {
  const w = assemble(PROGRAMS[0].source).words, cw = assemble(CACHE_CPU_PROGRAMS[0].source).words;
  return [
    singleCycleCpu(w), singleCycleCpu(w, { adder: 'ks' }), singleCycleCpu(w, { fpu: true }),
    singleCycleCpu(cw, { dmemK: 6, dcache: true, adder: 'ks' }), singleCycleCpu(cw, { dmemK: 6, dcache: 'wb2', adder: 'ks' }),
    singleCycleCpu(cw, { icache: true, adder: 'ks' }), singleCycleCpu(cw, { dmemK: 6, dcache: 'wb', icache: true }),
    pipelinedCpu(w), pipelinedCpu(w, { adder: 'ks' }), pipelinedCpu(w, { adder: 'ks', balanced: true }),
    pipelinedCpu(w, { predictor: true }), pipelinedCpu(w, { adder: 'ks', balanced: true, predictor: true }),
    pipelinedCpu(cw, { adder: 'ks', dcache: 'wb2' }), pipelinedCpu(cw, { adder: 'ks', dcache: 'wt', predictor: true, balanced: true }),
    pipelinedCpu(w, { adder: 'ks', m: true }), pipelinedCpu(w, { adder: 'ks', balanced: true, predictor: true, m: true }),
    pipelinedFpCpu(w), systemCpu(w), systemCpu(w, { m: true }),
    multicycleCpu(w, { control: 'fsm' }), multicycleCpu(w, { control: 'micro' }), dualCore(w),
  ];
}

/**
 * Large memories at representative sizes (lib/bigmem.ts): every RAM level registers when built (so
 * the registry-wide tests see them); a large ROM's levels are not registered, so they are listed.
 */
export function bigMemTops(): ComponentDef[] {
  for (const [k, w] of [[7, 1], [8, 8], [9, 4], [11, 2], [16, 32], [16, 8]]) bigRam(k, w);
  // a short program (few distinct words: each is a constant chip), the rest filled: few distinct banks
  const words = Array.from({ length: 300 }, (_, i) => [0x13, 0x00500093, 0xfe0a8ae3, 0x0000006f][i % 4]);
  return [wordRom(16, 32, 'rv32', words), wordRom(13, 16, 'word', words.map((x) => x & 0xffff)), wordRom(9, 8, 'word', words.map((x) => x & 0xff))];
}
