// Random vm programs (riscv/randprog32.ts, the `vm` option: page tables built by the program itself, a window of pages in
// every state, probe pages, U and S, a handler that logs and maps) on the virtual-memory CPU in lock step with the golden
// model. Seeds run in chunks; VM_FUZZ=n sets how many (default 12), VM_FUZZ_FROM the first seed.
import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { randomProgram32 } from '../src/riscv/randprog32';
import { tick } from './yieldtick';
import { lockstep } from './verify/vmlock';
import { DATA, VM_WINDOW } from './verify/spike';

const N = Number(process.env.VM_FUZZ ?? 12), FROM = Number(process.env.VM_FUZZ_FROM ?? 1);

describe('random vm programs in lock step', () => {
  it.each(Array.from({ length: N }, (_, i) => FROM + i))('seed %i', async (seed) => {
    const src = randomProgram32(seed, { n: 60, sub: true, system: true, dmemWords: 4096, dataBase: VM_WINDOW, timer: false, vm: { code: 0, data: DATA } });
    const a = assemble(src);
    expect(a.errors.map((e) => `line ${e.line}: ${e.message}`)).toEqual([]);
    const imemK = Math.max(8, Math.ceil(Math.log2(a.words.length)));
    const r = await lockstep(a.words, { imemK, dmemK: 14, maxCycles: 20_000, pause: tick });
    console.log(`seed ${seed}: ${a.words.length} words, ${r.steps} steps, ${r.cycles} cycles (${r.stalls} stalled), U/S/M ${r.byPriv[0]}/${r.byPriv[1]}/${r.byPriv[3]}, ${r.walks} walks, ${JSON.stringify(r.causes)}`);
    expect(r.why).toBe('');
    expect(r.halted).toBe(true);
  }, 300_000);
});
