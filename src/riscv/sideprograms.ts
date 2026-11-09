// The side-channels chapter's programs (RV32I), each with what it must leave behind computed here in TypeScript.
// They run on the out-of-order model in spec mode (riscv/ooomodel.ts): a 1 KB direct-mapped cache of 16-byte lines,
// a miss 20 cycles. Teaching code for a modelled machine: nothing here is aimed at a real processor.

import type { CacheConfig } from '../sim/cachemodel';
import { assemble } from './asm';
import { ISS } from './iss';
import { OOO_CORE, type OooConfig, type SpecConfig } from './ooomodel';

/** The chapter's data cache: 64 lines of 16 bytes, direct-mapped (the cache chapter's organisation). */
export const SIDE_CACHE: CacheConfig = { size: 1024, line: 16, ways: 1, replacement: 'lru', write: 'wb' };
export const SIDE_MISS = 20;
export const SIDE_SPEC: SpecConfig = { cache: SIDE_CACHE, missLat: SIDE_MISS };
/** Data memory for the chapter's programs (4 KB). */
export const SIDE_OPTS = { dmemWords: 1024, imemWords: 1024 };

/** The memory map (byte addresses). Sets: probe 0–15, the timings 24–27, the output 28, array1 32, the secret 33, len 48; the eviction lines share
 *  the probe's and len's sets and nothing else. */
export const MAP = { array1: 0x200, secret: 0x210, len: 0x300, probe: 0x400, times: 0x580, out: 0x5c0, evict: 0x800 } as const;
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

/** spectreSource's program with `pad` nops before the victim. */
function spectreBody(secret: readonly number[], defence: Defence, train: boolean, pad: number): string {
  const training = train ? `        li   a0, 0              # train: in-bounds calls, so the check predicts "in bounds"
        call victim
        li   a0, 1
        call victim` : '        # no training: after an attack commits, the check predicts "out of bounds"';
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
        li   s11, ${MAP.times}
        li   t0, ${LEN}
        sw   t0, 0(s6)
${plant}
        lbu  t0, 16(s1)         # the victim uses its secret: its line is in the cache
        li   s4, 0              # k: which secret byte
        li   s5, ${secret.length}
next:
${training}
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
        slli t3, t0, 2          # keep it: the last attack's 16 times
        add  t3, s11, t3
        sw   t6, 0(t3)
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

${'        nop                     # places the check in a BTB entry of its own\n'.repeat(pad)}${victim(defence)}
`;
}

/** The whole program: plant the data, then for each secret byte train, evict, attack and time the 16 probe lines; the
 *  fastest line (if fast enough) is stored at MAP.out + k. The victim is padded with nops so that its bounds check has a
 *  BTB entry no other branch or jump of the program shares: the predictor (16 entries, direct-mapped) then remembers
 *  "taken" after an attack, as the training step needs. Without it a loop's branch can evict that entry and do the
 *  training for the attacker. */
export function spectreSource(secret: readonly number[], defence: Defence = 'none', train = true): string {
  for (let pad = 0; pad < OOO_CORE.btb; pad++) {
    const src = spectreBody(secret, defence, train, pad), a = assemble(src), check = a.labels.get('victim')! + 4;
    const slot = (pc: number) => (pc >>> 2) % OOO_CORE.btb;
    const taken = a.words.flatMap((w, i) => {
      const op = w & 0x7f, pc = i * 4;
      const ret = op === 0x67 && ((w >>> 15) & 31) === 1 && ((w >>> 7) & 31) === 0; // returns: the return-address stack's
      return pc !== check && (op === 0x63 || op === 0x6f || (op === 0x67 && !ret)) ? [slot(pc)] : [];
    });
    if (!taken.includes(slot(check))) return src;
  }
  throw new Error('no BTB entry of its own for the bounds check');
}

/** The model configuration for a defence ('fill' is the hardware one: the program has none). */
export function sideConfig(defence: Defence | 'fill'): Partial<OooConfig> {
  return { spec: { ...SIDE_SPEC, fenceBarrier: defence === 'fence', fillAtCommit: defence === 'fill' } };
}

export const spectreWords = (secret: readonly number[], defence: Defence = 'none', train = true) => assemble(spectreSource(secret, defence, train)).words;

/** The victim called n times in bounds (x = 0, 1, … 15, 0, …), data planted and the cache warm: for cycles per call. */
export function callsSource(defence: Defence, n: number): string {
  return `        li   s1, ${MAP.array1}
        li   s2, ${MAP.probe}
        li   s6, ${MAP.len}
        li   t0, ${LEN}
        sw   t0, 0(s6)
        li   s4, 0
        li   s5, ${n}
loop:   andi a0, s4, 15
        call victim
        addi s4, s4, 1
        blt  s4, s5, loop
done:   j    done

${victim(defence)}
`;
}

// ---- step 1: a password check that stops early -------------------------------------------------------------------------

/** The password the step's widget hides: four letters from a–p (16 choices each). */
export const PASSWORD = 'jade';
export const PW_LETTERS = 'abcdefghijklmnop';
/** Where the guess and the password sit (byte addresses). */
const PW = { guess: 0x100, pass: 0x110, out: 0x120 } as const;

const PW_EARLY = `check:  li   t2, 4            # bytes left
loop:   lbu  t0, 0(a0)        # guess
        lbu  t1, 0(a1)        # password
        bne  t0, t1, no       # leaves at the first difference
        addi a0, a0, 1
        addi a1, a1, 1
        addi t2, t2, -1
        bnez t2, loop
        li   a0, 1
        ret
no:     li   a0, 0
        ret`;

const PW_CONST = `check:  li   t2, 4            # bytes left
        li   a2, 0            # every difference, ORed
loop:   lbu  t0, 0(a0)
        lbu  t1, 0(a1)
        xor  t0, t0, t1
        or   a2, a2, t0
        addi a0, a0, 1
        addi a1, a1, 1
        addi t2, t2, -1
        bnez t2, loop
        seqz a0, a2           # 1 only when nothing differed
        ret`;

/** The check routine's text (the step shows it). */
export const pwCheckText = (constantTime: boolean) => (constantTime ? PW_CONST : PW_EARLY);

function pwSource(guess: string, constantTime: boolean): string {
  const put = (s: string, at: number) => [...s].map((ch, i) => `        li   t0, ${ch.charCodeAt(0)}\n        sb   t0, ${at + i}(zero)`).join('\n');
  return `${put(guess.padEnd(4, '-').slice(0, 4), PW.guess)}
${put(PASSWORD, PW.pass)}
        li   a0, ${PW.guess}
        li   a1, ${PW.pass}
        call check
        sw   a0, ${PW.out}(zero)
done:   j    done

${pwCheckText(constantTime)}
`;
}

/** A guess run through the check on the golden model (one instruction a cycle, the single-cycle CPU): its answer and
 *  the cycles from the call into the check to its return, both included. */
export function pwRun(guess: string, constantTime = false): { ok: boolean; cycles: number } {
  const a = assemble(pwSource(guess, constantTime));
  const check = a.labels.get('check')!, iss = new ISS(a.words, { dmemWords: 256, imemWords: 256 });
  let cycles = 0, inside = false;
  while (!iss.halted && iss.steps < 10_000) {
    const pc = iss.pc, info = iss.step();
    if (pc === check) inside = true;
    if (inside) cycles++;
    if (inside && info.text.startsWith('ret')) inside = false;
  }
  return { ok: iss.dmem[PW.out >> 2] === 1, cycles };
}

// ---- step 2: evict, let the victim touch a line, reload and time ---------------------------------------------------------

/** The victim touches probe line s; the attacker had evicted all 16, now times each reload (stored at MAP.times). */
export function probeSource(s: number): string {
  return `        li   s2, ${MAP.probe}
        li   s3, ${MAP.evict}
        li   s11, ${MAP.times}
        li   t0, 0              # evict the 16 probe lines
evict:  slli t1, t0, 4
        add  t1, s3, t1
        lw   t2, 0(t1)
        addi t0, t0, 1
        li   t1, 16
        blt  t0, t1, evict
        lw   t2, ${s * 16}(s2)       # the victim: one line, chosen by its secret
        li   t0, 0              # the attacker: time each reload
probe:  slli t1, t0, 4
        add  t1, s2, t1
        csrr t5, cycle
        lw   t2, 0(t1)
        csrr t6, cycle
        sub  t6, t6, t5
        slli t3, t0, 2
        add  t3, s11, t3
        sw   t6, 0(t3)
        addi t0, t0, 1
        li   t1, 16
        blt  t0, t1, probe
done:   j    done
`;
}

/** The 16 reload times a program left at MAP.times. */
export const timesIn = (dmem: Uint32Array) => Array.from({ length: 16 }, (_, i) => dmem[(MAP.times >> 2) + i]);

// ---- step 10: what fill-at-commit costs ---------------------------------------------------------------------------------

/** Words the streaming loop sums: 4 KB, four times the cache, so most of its lines are not there when it reads them. */
export const STREAM_WORDS = 1024;

/** Write STREAM_WORDS words, then sum them: a load a word, four words a line. Each line's first load misses; with
 *  fill-at-commit the next loads to that line, issued before the first has committed, miss too. */
export const STREAM_SOURCE = `        li   t0, 0
        li   t1, ${STREAM_WORDS * 4}
fill:   sw   t0, 0(t0)
        addi t0, t0, 4
        blt  t0, t1, fill
        li   t0, 0
        li   a0, 0
sum:    lw   t2, 0(t0)
        add  a0, a0, t2
        addi t0, t0, 4
        blt  t0, t1, sum
        sw   a0, ${STREAM_WORDS * 4 - 4}(zero)
done:   j    done
`;

// ---- step 3: the same bounds check on the gate-level out-of-order core ---------------------------------------------------

/** The secret word the gate-level step plants past its array. */
export const GATE_SECRET = 0x5ec;

/** For the gate-level core of the ooo chapter (word loads only, 2^6 data words, no cache): the bound comes out of a
 *  divide, 19 cycles, so the check resolves late; x = 4 is one word past a 4-word array. The wrong path loads the secret
 *  into the reorder buffer; the flush takes it out again. */
export const GATE_SOURCE = `# array1: words 16-19 (bytes 64-79); the secret is the word after it
        li   s1, 64
        li   t0, 11
        sw   t0, 0(s1)
        li   t0, 22
        sw   t0, 4(s1)
        li   t0, 33
        sw   t0, 8(s1)
        li   t0, 44
        sw   t0, 12(s1)
        li   t0, ${GATE_SECRET}
        sw   t0, 16(s1)         # the secret, at array1[4]
        li   t5, 12
        li   t6, 3
        li   a0, 4              # x = 4: out of bounds
        divu t1, t5, t6         # len = 4, after 19 cycles
        bgeu a0, t1, out        # predicted "in bounds": nothing has taught it otherwise
        slli t2, a0, 2
        add  t2, s1, t2
        lw   t3, 0(t2)          # array1[4]: the secret, on the wrong path
        add  t4, t3, t3
out:    j    out
`;
