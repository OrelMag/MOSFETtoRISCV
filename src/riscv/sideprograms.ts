// The side-channels chapter's programs (RV32I), each with what it must leave behind computed here in TypeScript.
// They run on the out-of-order model in spec mode (riscv/ooomodel.ts): a 1 KB direct-mapped cache of 16-byte lines,
// a miss 20 cycles. Teaching code for a modelled machine: nothing here is aimed at a real processor.

import type { CacheConfig } from '../sim/cachemodel';
import { assemble } from './asm';
import type { OooConfig, SpecConfig } from './ooomodel';

/** The chapter's data cache: 64 lines of 16 bytes, direct-mapped (the cache chapter's organisation). */
export const SIDE_CACHE: CacheConfig = { size: 1024, line: 16, ways: 1, replacement: 'lru', write: 'wb' };
export const SIDE_MISS = 20;
export const SIDE_SPEC: SpecConfig = { cache: SIDE_CACHE, missLat: SIDE_MISS };
/** Data memory for the chapter's programs (4 KB). */
export const SIDE_OPTS = { dmemWords: 1024, imemWords: 1024 };

/** The memory map (byte addresses). Sets: probe 0–15, array1 32, the secret 33, len 48; the eviction lines share
 *  the probe's and len's sets and nothing else. */
export const MAP = { array1: 0x200, secret: 0x210, len: 0x300, probe: 0x400, out: 0x600, evict: 0x800 } as const;
/** Bytes of array1 the bounds check allows. */
export const LEN = 16;
/** A reload faster than this many cycles counts as a hit (the attacker's own threshold; a hit and a miss measure far apart). */
export const HIT_BELOW = 12;
/** What the attacker stores for a nibble when no probe line came back fast. */
export const NOTHING = 0xff;

export type Defence = 'none' | 'fence' | 'mask';

/** The victim: a bounds-checked read from array1 that touches one probe line chosen by the byte it read. */
function victim(defence: Defence): string {
  const check = `victim:                     # a0 = x
        lw   t1, 0(s6)          # len: evicted, so a miss
        bgeu a0, t1, vout       # out of bounds: skip the body`;
  const body = defence === 'mask' ? `
        sltu t5, a0, t1         # 1 when x < len
        neg  t5, t5             # all ones, or zero
        and  t2, a0, t5         # x, or 0 when out of bounds
        add  t2, s1, t2` : `${defence === 'fence' ? `
        fence                   # no speculation past here` : ''}
        add  t2, s1, a0         # &array1[x]`;
  return `${check}${body}
        lbu  t3, 0(t2)          # array1[x]
        slli t3, t3, 4          # · 16: a line per value
        add  t3, s2, t3
        lw   t4, 0(t3)          # touches probe line array1[x]
vout:   ret`;
}

/** The whole program: plant the data, then for each secret byte train, evict, attack and time the 16 probe lines;
 *  the fastest line (if fast enough) is stored at MAP.out + k. */
export function spectreSource(secret: readonly number[], defence: Defence = 'none'): string {
  const plant = [
    ...Array.from({ length: LEN }, (_, i) => `        li   t0, ${(i * 5 + 3) & 15}\n        sb   t0, ${i}(s1)`),
    ...secret.map((b, i) => `        li   t0, ${b & 15}\n        sb   t0, ${16 + i}(s1)`),
  ].join('\n');
  return `# Spectre variant 1 on the out-of-order model (spec mode). s1 array1, s2 probe, s3 eviction lines, s6 len.
        li   s1, ${MAP.array1}
        li   s2, ${MAP.probe}
        li   s3, ${MAP.evict}
        li   s6, ${MAP.len}
        li   s7, ${MAP.out}
        li   t0, ${LEN}
        sw   t0, 0(s6)
${plant}
        lbu  t0, 16(s1)         # the victim uses its secret: its line is in the cache
        li   s4, 0              # k: which secret byte
        li   s5, ${secret.length}
next:   li   a0, 0              # train: in-bounds calls, so the check predicts "in bounds"
        call victim
        li   a0, 1
        call victim
        li   t0, 0              # evict the 16 probe lines and len
evict:  slli t1, t0, 4
        add  t1, s3, t1
        lw   t2, 0(t1)
        addi t0, t0, 1
        li   t1, 16
        blt  t0, t1, evict
        lw   t2, ${MAP.len + SIDE_CACHE.size}(zero)   # len's set, another tag: len is out
        addi a0, s4, ${LEN}     # x = 16 + k: past the end of array1
        call victim
        li   t0, 0              # time each probe line
        li   s8, 1000           # fastest so far
        li   s9, ${NOTHING}     # its line
probe:  slli t1, t0, 4
        add  t1, s2, t1
        csrr t5, cycle
        lw   t2, 0(t1)
        csrr t6, cycle
        sub  t6, t6, t5
        bge  t6, s8, slower
        mv   s8, t6
        mv   s9, t0
slower: addi t0, t0, 1
        li   t1, 16
        blt  t0, t1, probe
        li   t1, ${HIT_BELOW}
        blt  s8, t1, found
        li   s9, ${NOTHING}
found:  add  t1, s7, s4
        sb   s9, 0(t1)
        addi s4, s4, 1
        blt  s4, s5, next
done:   j    done

${victim(defence)}
`;
}

/** The model configuration for a defence ('fill' is the hardware one: the program has none). */
export function sideConfig(defence: Defence | 'fill'): Partial<OooConfig> {
  return { spec: { ...SIDE_SPEC, fenceBarrier: defence === 'fence', fillAtCommit: defence === 'fill' } };
}

export const spectreWords = (secret: readonly number[], defence: Defence = 'none') => assemble(spectreSource(secret, defence)).words;
