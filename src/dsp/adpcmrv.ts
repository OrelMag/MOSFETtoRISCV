// IMA ADPCM's encoder as an RV32I program, run on the golden model (riscv/iss.ts): its codes equal dsp/speech.ts adpcmEncode, and its instruction count is what one sample costs
// on a single-cycle core (one instruction a cycle). The program reads its tables, its state and the samples from memory the harness fills.

import { assemble } from '../riscv/asm';
import { ISS } from '../riscv/iss';
import { IMA_INDEX, IMA_STEPS, type AdpcmState } from './speech';

/** Where things are, in bytes. */
export const ADPCM_MAP = { steps: 0x000, index: 0x100, state: 0x200, input: 0x400 };

/** The encoder. a0 walks the input (16-bit samples), a1 the output (one 4-bit code a byte), a2 counts down; s0 is the prediction and s1 the step index. */
export const ADPCM_ASM = `# IMA ADPCM encoder, RV32I: x[n] in, a 4-bit code out
        li   s2, 0x000          # step sizes, 89 halfwords
        li   s3, 0x100          # index changes, 8 words
        li   t0, 0x200          # count, prediction, index
        lw   a2, 0(t0)
        lw   s0, 4(t0)
        lw   s1, 8(t0)
        li   a0, 0x400          # samples
        lw   a1, 12(t0)         # where the codes go
loop:   beqz a2, done
        lh   t0, 0(a0)          # x
        slli t1, s1, 1
        add  t1, t1, s2
        lhu  t2, 0(t1)          # step
        sub  t3, t0, s0         # diff = x - prediction
        li   t4, 0              # code
        srli t5, t2, 3          # what the decoder will add: step / 8 to start
        bgez t3, pos
        li   t4, 8              # the sign bit
        neg  t3, t3
pos:    blt  t3, t2, bit2
        ori  t4, t4, 4
        sub  t3, t3, t2
        add  t5, t5, t2
bit2:   srli t2, t2, 1
        blt  t3, t2, bit1
        ori  t4, t4, 2
        sub  t3, t3, t2
        add  t5, t5, t2
bit1:   srli t2, t2, 1
        blt  t3, t2, bit0
        ori  t4, t4, 1
        add  t5, t5, t2
bit0:   andi t6, t4, 8
        beqz t6, plus
        sub  s0, s0, t5
        j    clamp
plus:   add  s0, s0, t5
clamp:  li   t6, 32767          # the prediction stays a 16-bit sample
        bge  t6, s0, lo
        mv   s0, t6
lo:     li   t6, -32768
        bge  s0, t6, step
        mv   s0, t6
step:   andi t6, t4, 7          # move the step index by the code's size
        slli t6, t6, 2
        add  t6, t6, s3
        lw   t6, 0(t6)
        add  s1, s1, t6
        bgez s1, top
        li   s1, 0
top:    li   t6, 88
        bge  t6, s1, out
        mv   s1, t6
out:    sb   t4, 0(a1)
        addi a0, a0, 2
        addi a1, a1, 1
        addi a2, a2, -1
        j    loop
done:   li   t0, 0x200          # the state, for the next block
        sw   s0, 4(t0)
        sw   s1, 8(t0)
halt:   j    halt
`;

let words: number[] | undefined;
const program = () => (words ??= assemble(ADPCM_ASM).words);

/** Encode a block on the golden model. Returns the codes, the state it leaves, and how many instructions it took. */
export function adpcmOnRv(x: readonly number[], s: AdpcmState = { pred: 0, index: 0 }): { codes: number[]; state: AdpcmState; steps: number; perSample: number } {
  const out = ADPCM_MAP.input + 2 * x.length, bytes = out + x.length, dmemWords = 2 ** Math.ceil(Math.log2(Math.ceil(bytes / 4) + 1));
  const iss = new ISS(program(), { dmemWords, imemWords: 128 });
  const half = (addr: number, v: number) => { const w = addr >> 2, sh = 8 * (addr & 3); iss.dmem[w] = (iss.dmem[w] & ~(0xffff << sh)) | ((v & 0xffff) << sh); };
  IMA_STEPS.forEach((v, i) => half(ADPCM_MAP.steps + 2 * i, v));
  IMA_INDEX.forEach((v, i) => { iss.dmem[(ADPCM_MAP.index >> 2) + i] = v >>> 0; });
  const st = ADPCM_MAP.state >> 2;
  iss.dmem[st] = x.length; iss.dmem[st + 1] = s.pred >>> 0; iss.dmem[st + 2] = s.index; iss.dmem[st + 3] = out;
  x.forEach((v, i) => half(ADPCM_MAP.input + 2 * i, v));
  while (!iss.halted) iss.step();
  const codes = Array.from({ length: x.length }, (_, i) => (iss.dmem[(out + i) >> 2] >>> (8 * ((out + i) & 3))) & 0xff);
  const before = 8; // the instructions before the loop, which a block pays once
  return { codes, state: { pred: iss.dmem[st + 1] | 0, index: iss.dmem[st + 2] }, steps: iss.steps, perSample: (iss.steps - before - 4) / Math.max(1, x.length) };
}
/** The program's length in instructions. */
export const adpcmProgramLength = (): number => program().length;
