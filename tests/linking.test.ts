// Chapter 'linking': the kernel's exec (osprograms.ts kernelSource({ disk })) loads a linked ELF file, on the golden model and on the gates
// in lock step; text runs in place and is never writable, data is never executable; the kernel without a disk is the one it was.
import { describe, expect, it } from 'vitest';
import { execImage, MAIN_OUTPUT, MAIN_S, UTIL_S, type SourceFile } from '../src/riscv/execprograms';
import { EXEC_SYS, OS_DMEM_K, OS_IMEM_K, SYS, kernelSource } from '../src/riscv/osprograms';
import { runOs, tripsOf } from '../src/riscv/osrun';
import { WALK_CYCLES } from '../src/riscv/vmprograms';
import { lockstep } from './verify/vmlock';
import { tick } from './yieldtick';

const ROGUE_STORE: SourceFile = { name: 'rogue.s', text: `.globl main\nmain:\n  la t0, main\n  li t1, 0x13\n  sw t1, 0(t0)       # into its own code\n  li a7, ${SYS.exit}\n  ecall\n` };
const ROGUE_JUMP: SourceFile = { name: 'jump.s', text: `.globl main\nmain:\n  la t0, buf\n  jr t0              # into its own data\n.data\nbuf:\n  .word 0x13\n` };

describe('exec on the golden model', () => {
  it('the linked program runs and prints what it should', () => {
    const r = runOs(execImage([MAIN_S, UTIL_S]), 100000);
    expect(r.halted).toBe(true);
    expect(r.output).toBe(`${MAIN_OUTPUT}all done\n`);
    expect(tripsOf(r, EXEC_SYS)).toHaveLength(1);
  });

  it('a store into the text is a store page fault (15), a jump into the data an instruction page fault (12)', () => {
    expect(runOs(execImage([ROGUE_STORE]), 100000).output).toContain('!A killed, cause 15\n');
    expect(runOs(execImage([ROGUE_JUMP]), 100000).output).toContain('!A killed, cause 12\n');
  });

  it('without a disk the kernel is unchanged, with or without threads', async () => {
    const { readFileSync } = await import('node:fs');
    expect(kernelSource().includes('sys_exec')).toBe(false);
    expect(kernelSource({ threads: true }).includes('sys_exec')).toBe(false);
    expect(readFileSync('src/riscv/osprograms.ts', 'utf8')).toContain('disk?: number[]');
  });
});

describe('exec on the gates, in lock step with the golden model', () => {
  it.each([['the linked program', [MAIN_S, UTIL_S]], ['a store into its text', [ROGUE_STORE]], ['a jump into its data', [ROGUE_JUMP]]] as const)('%s', async (_n, files) => {
    const img = execImage([...files]);
    const r = await lockstep(img.words, { imemK: OS_IMEM_K, dmemK: OS_DMEM_K, maxCycles: 40000, pause: tick });
    expect(r.why).toBe('');
    expect(r.halted).toBe(true);
    const m = runOs(img, 100000);
    expect(r.iss.console).toBe(m.output);
    expect(r.stalls).toBe(WALK_CYCLES * m.walks);
  }, 300_000);
});
