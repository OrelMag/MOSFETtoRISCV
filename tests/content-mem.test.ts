// The memory chapters (32–35) and the appendices: numbers the text quotes that are typed, or computed in a way a later
// edit could break, held to the parts and files they describe.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chBus } from '../src/chapters/ch-bus';
import { chDram } from '../src/chapters/ch-dram';
import { chFlash } from '../src/chapters/ch-flash';
import { chAppendix6502, LEDGER } from '../src/chapters/ch-6502';
import { chAppendixDoom } from '../src/chapters/ch-doom';
import type { Chapter } from '../src/chapters/types';
import { CLOCK_NS } from '../src/dram/timing';
import { FLASH_REAL_US, FLASH_TIMES } from '../src/flash/model';
import { DMA_ENGINE } from '../src/lib/axi';
import { singleCycleCpu } from '../src/lib/cpu';
import { BITLINE_C, CELL_C } from '../src/lib/dram';
import { datapath, m6502 } from '../src/lib/m6502/chip';
import { OPCODES } from '../src/m6502/isa';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { VDD_VOLTS } from '../src/sim/switchsim';
import { stats } from '../src/sim/stats';
import { netlistOf } from '../src/sim/types';

/** Every string a chapter shows: step bodies, recap, questions and their explanations. */
const text = (c: Chapter) => JSON.stringify(c);
const T = (d: Parameters<typeof stats>[0]) => stats(d).transistors;

describe('memory chapters: quoted numbers', () => {
  it('ch 35: a full cell moves the bit line by the 110 mV the read challenge quotes', () => {
    const mv = Math.round(0.5 * CELL_C / (CELL_C + BITLINE_C) * VDD_VOLTS * 1000);
    expect(mv).toBe(110);
    expect(text(chDram)).toContain('+110 mV');
  });

  it('ch 35: the 3 GHz conflict pays three 13.75 ns intervals and a 2.5 ns BL8 burst', () => {
    const q = chDram.steps.find((s) => s.title === 'Bursts and timings')!.challenge!;
    expect(q.kind).toBe('quiz');
    if (q.kind === 'quiz') expect(q.options[q.answer]).toBe(String(3 * Math.ceil(13.75 * 3) + Math.ceil(2.5 * 3)));
  });

  it('ch 37: the flash times are a real page read scaled down, ratios about kept', () => {
    const real = Math.round((FLASH_REAL_US.read * 1000) / CLOCK_NS);
    expect(text(chFlash)).toContain(real.toLocaleString('en-US').replace(/,/g, ' '));
    const scale = real / FLASH_TIMES.read;
    for (const op of ['read', 'program', 'erase'] as const) {
      const ideal = (FLASH_REAL_US[op] * 1000) / CLOCK_NS / scale;
      expect(Math.abs(FLASH_TIMES[op] / ideal - 1), op).toBeLessThan(0.1);
    }
    expect(text(chFlash)).toContain('about 100×');
  });

  it('ch 38: the DMA engine\'s flip-flop share is what the text says', () => {
    const regs = new Set(['src', 'dst', 'len', 'data', 'rdr', 'st', 'bq', 'rq']);
    const n = (netlistOf(DMA_ENGINE)?.instances ?? []).filter((i) => regs.has(i.name)).reduce((s, i) => s + stats(i.def).nands, 0);
    const pct = Math.round((100 * n) / stats(DMA_ENGINE).nands);
    const dma = chBus.steps.find((s) => s.title === 'DMA')!.body;
    expect(dma).toContain(`${pct} % of them flip-flops`);
    expect(pct).toBeGreaterThan(45);
    expect(pct).toBeLessThan(60);
  });

  it('appendix A: the ledger figures match the circuits', () => {
    const rv = singleCycleCpu(assemble(PROGRAMS[0].source).words);
    const total = T(rv);
    const part = (name: string) => T(netlistOf(rv)!.instances.find((i) => i.name === name)!.def);
    const rfDm = part('rf') + part('dm'), store = rfDm + part('imem');
    expect(Math.round(total / 1000) * 1000).toBe(LEDGER.rv32i);
    expect(Math.round(T(m6502()) / 100) * 100).toBe(LEDGER.m6502);
    expect(Math.round((100 * store) / total)).toBe(LEDGER.storePct);
    expect(Math.round((100 * rfDm) / total)).toBe(LEDGER.rfDmPct);
    expect(Math.round(part('rf') / 1024 / 10) * 10).toBe(LEDGER.bitRf);
    const regBit = T(netlistOf(datapath())!.instances.find((i) => i.name === 'rega')!.def) / 8;
    expect(Math.round(regBit)).toBe(LEDGER.bit6502);
    expect(Math.round(total / T(m6502()))).toBe(50);
    expect(text(chAppendix6502)).not.toMatch(/three quarters/i);
  });

  it('appendix A: SingleStepTests covers the documented opcodes, 10 000 cases each', () => {
    const documented = OPCODES.filter(Boolean).length;
    expect(documented).toBe(151);
    expect(text(chAppendix6502)).toContain(`${(documented * 10000 / 1e6).toFixed(2)} million cases`);
  });

  it('appendix B: doomgeneric leaves six functions to the platform; a frame on silicon at the system CPU\'s period', () => {
    const header = readFileSync(new URL('../ports/doom/doomgeneric/doomgeneric.h', import.meta.url), 'utf8');
    const fns = [...header.matchAll(/^\w[\w\s*]*\bDG_\w+\s*\(/gm)].length;
    expect(fns).toBe(6);
    expect(text(chAppendixDoom)).toContain('leaves six functions');
    const s = text(chAppendixDoom);
    expect(s).toContain('about 6 ms');
    expect(s).not.toMatch(/about 4 ns|in 8 ms|about 8 ms/);
  });
});
