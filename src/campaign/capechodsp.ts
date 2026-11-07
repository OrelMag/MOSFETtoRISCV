// The echo capstone on the DSP core (DSP24, dsp/iss24.ts), DOM-free: the bench's side of the sample protocol, and the core's starter and reference programs.
//
// The core has no input instruction, so the bench uses two reserved words: x[n] sits in X[254] and d[n] in Y[255]. The program reads x, computes ŷ and executes
// `out`, which ends the sample; only then does the bench write d[n] into Y[255] and x[n + 1] into X[254]. d is not there to read before the out (a read of Y[255]
// gives the last sample's d, which is the learning signal and allowed), and the next x does not help ŷ[n]. Cycles are DSP24 steps from one out to the next.

import { groupDigits } from '../sim/numfmt';
import { assemble24 } from '../dsp/asm24';
import { Iss24, s16 } from '../dsp/iss24';
import { decode24, ROM24_WORDS } from '../dsp/isa24';
import type { EchoPath, PathFault } from './capecho';

/** The bench's words (a program that writes them is overwritten at the next out). */
export const DSP_IO = { x: 254, d: 255 } as const;

/** What a run leaves for scoring. clears / accumulations: how often the accumulator was cleared and used, for the diagnosis "never cleared". */
export interface RawRun { y: number[]; fault: PathFault | null; worst: number; total: number; clears?: number; accumulations?: number; /** What clears the accumulator on this machine, for the message. */ clearWith?: string }

const g = groupDigits;

export function assembleDsp(src: string): { words: number[]; errors: { line: number; message: string }[] } {
  const r = assemble24(src);
  const errors = [...r.errors];
  if (!errors.length && r.words.length > ROM24_WORDS) errors.push({ line: 1, message: `${r.words.length} words of code, the core's ROM holds ${ROM24_WORDS}` });
  return { words: r.words, errors };
}

/** Run a DSP24 program on one path: the protocol above, the budget per sample, a fault with a message. */
export function runDsp(words: number[], path: EchoPath, budget: number, setup: number): RawRun {
  const m = new Iss24(words), n = path.x.length;
  const y: number[] = [];
  let fault: PathFault | null = null, last = -1, worst = 0, total = 0, readX = false, clears = 0, accumulations = 0;
  // which instructions read X (an ld from X, a mac) and through which pointer, found once per ROM word
  const xp = new Int8Array(words.length || 1).fill(-1), isClear = new Uint8Array(words.length || 1), isMac = new Uint8Array(words.length || 1);
  words.forEach((w, i) => { const d = decode24(w); if (d.name === 'mac' || (d.name === 'ld' && !d.bus)) xp[i] = d.xp; isMac[i] = d.name === 'mac' ? 1 : 0; isClear[i] = d.name === 'clr' || d.name === 'rndc' ? 1 : 0; });
  m.x[DSP_IO.x] = path.x[0] & 0xffff;
  while (y.length < n && !fault) {
    const pc = m.pc;
    if (pc < xp.length) {
      if (xp[pc] >= 0 && m.p[xp[pc]] === DSP_IO.x) readX = true;
      accumulations += isMac[pc];
      clears += isClear[pc];
    }
    const st = m.step();
    if (st.out !== undefined) {
      const k = y.length;
      if (!readX) { fault = { kind: 'protocol', message: k === 0 ? `the first out came before any read of X[${DSP_IO.x}]: ŷ must follow the x of its sample` : `sample ${k}: two outs with no read of x between them (X[${DSP_IO.x}]): one out per x` }; break; }
      readX = false;
      y.push(s16(st.out));
      if (last >= 0) {
        const took = m.steps - last;
        total += took;
        if (took > worst) worst = took;
        if (took > budget) fault = { kind: 'budget', message: `sample ${k - 1} took ${g(took)} cycles, ${g(took - budget)} over the budget of ${g(budget)}` };
      } else if (m.steps > setup) fault = { kind: 'setup', message: `${g(m.steps)} cycles before the first out, over the ${g(setup)} allowed` };
      last = m.steps;
      m.y[DSP_IO.d] = path.d[k] & 0xffff;
      if (k + 1 < n) m.x[DSP_IO.x] = path.x[k + 1] & 0xffff;
    } else if (m.halted) {
      fault = { kind: 'protocol', message: y.length ? `the program halted after sample ${y.length - 1} of ${g(n)}: it must keep answering until the last` : 'the program halted before answering any sample' };
    } else if (m.steps - Math.max(last, 0) > budget + setup) {
      fault = y.length ? { kind: 'budget', message: `sample ${y.length - 1} never reached its out: ${g(m.steps - last)} cycles and counting, over the budget of ${g(budget)}` } : { kind: 'setup', message: `no out in ${g(m.steps)} cycles (set-up allows ${g(setup)})` };
    }
  }
  return { y, fault, worst, total, clears, accumulations, clearWith: 'clr clears it, and so does rndc' };
}

// ---- the starter and the reference --------------------------------------------------------------------

export const DSP_STARTER = `; Cancel the echo on the DSP core. One sample at a time, forever:
;   ld  r1, x(p1)     x[n] (16-bit, Q15) is in X[254]: point an X pointer at it first (ldi p1, 254)
;   out r2            your estimate ŷ of the echo of x in the microphone; it ends the sample
;   ld  r3, y(p6)     after the out, d[n] (echo + noise) is in Y[255] (ldi p6, 255), and the next x in X[254]
; X and Y are 256 words each. The bench owns X[254] and Y[255]: a program that writes them is overwritten at
; the next out, so keep your circular windows clear of them. A read of Y[255] before the out gives the last d.
        ldi   p1, 254
        ldi   p6, 255
loop:   ld    r1, x(p1)
        ldi   r2, 0          ; ŷ = 0: nothing cancelled yet
        out   r2
        ld    r3, y(p6)      ; d[n]
        ; ... move the weights toward the echo path ...
        jmp   loop
`;

export interface DspRefOpts {
  taps?: number;
  /** The rndc shift that scales the step: 9 is the reference, 7 is too large a step. */
  gshift?: number;
  /** false: the weights are read but never stored. */
  update?: boolean;
  /** −1 flips the update's sign. */
  sign?: 1 | -1;
  /** Executes out twice per sample. */
  twice?: boolean;
  /** Idle loop iterations (two cycles each) at the end of every sample. */
  busy?: number;
  /** Never clear the accumulator: rnd in place of rndc, and no clr. */
  noClr?: boolean;
  /** No normalization: the step's power of two is this constant whatever the signal's level (plain LMS). */
  plain?: number;
}

export const DSP_REF_SHIFT = 9;
/** The rndc shifts at which the reference passes (tests/capstone-echo-machines.test.ts pins both ends, and that the next shift on either side fails): a window of 8 in the step. */
export const DSP_PASSING_SHIFTS = [8, 11] as const;

/** The reference canceller: NLMS on 96 taps with 16-bit Q15 weights, and no divide: the step is a power of two read off the bit length of a leaky mean of x². */
export function dspReference(o: DspRefOpts = {}): string {
  const N = o.taps ?? 96, G = o.gshift ?? DSP_REF_SHIFT, up = o.update ?? true, op = o.sign === -1 ? 'sub' : 'add';
  const text = `; NLMS echo canceller on the DSP core: ${N} taps, weights in Y (Q15), the x history in X, both circular windows of ${N}.
; x is read from X[254], d from Y[255]; the normalization has no divide: the step is a power of two found from the bit length of a leaky mean of x².
        ldi   xl, ${N}          ; circular windows
        ldi   yl, ${N}
        ldi   p0, 0             ; x history (the oldest sample) / weights
        ldi   p4, 0
        ldi   p1, 254           ; the bench's x
        ldi   p2, 250           ; X scratch: x, then e
        ldi   p5, 250           ; Y: the step g
        ldi   p6, 255           ; the bench's d
        ldi   p7, 252           ; Y scratch: x, then the step's power of two
        ldi   r0, 0             ; leaky mean of x² (>> 14)
loop:   ld    r1, x(p1)         ; x[n]
        st    x(p0)+c, r1       ; over the oldest sample; p0 now points at the window's oldest
        clr
        loop  ${N}, tap
tap:    mac   x(p0)+c, y(p4)+c  ; one tap a cycle
        rndc  r2, 15            ; ŷ in Q15, rounded once, saturated once
        out   r2${o.twice ? '\n        out   r2' : ''}
        ld    r3, y(p6)         ; d[n], there only after the out
        sub   r3, r3, r2        ; e = d - ŷ
        st    x(p2), r1         ; x² through the accumulator
        st    y(p7), r1
        mac   x(p2), y(p7)
        rndc  r4, 14
        sub   r4, r4, r0        ; mean += (x² - mean) / 64
        ldi   r5, 6
        sar   r4, r4, r5
        add   r0, r0, r4
        addi  r4, r0, 4         ; + a floor
        ldi   r5, 0
        ldi   r6, 1
lz:     addi  r5, r5, 1         ; r5 = the bit length of the mean
        shr   r4, r4, r6
        jnz   r4, lz
        ldi   r6, 16
        sub   r6, r6, r5
        ldi   r7, 1
        shl   r7, r7, r6        ; P = 2^(16 - bit length)
        st    y(p7), r7
        st    x(p2), r3
        mac   x(p2), y(p7)      ; e · P
        rndc  r4, ${G}           ; g = e · P >> ${G}, saturated at 16 bits
        st    y(p5), r4
        loop  ${N}, upd
        mac   x(p0)+c, y(p5)    ; x_k · g
        rndc  r4, 15
        ld    r5, y(p4)${up ? '' : '+c'}
        ${op}   r5, r5, r4
${up ? 'upd:    st    y(p4)+c, r5' : 'upd:    addi  r5, r5, 0'}
${o.busy ? `        ldi   r6, ${o.busy}
idle:   addi  r6, r6, -1
        jnz   r6, idle
` : ''}        jmp   loop
`;
  const lines = text.split('\n');
  if (o.noClr) return lines.filter((l) => !/^ {8}clr$/.test(l)).join('\n').replace(/rndc/g, 'rnd ');
  if (o.plain !== undefined) {
    const from = lines.findIndex((l) => l.includes('; x² through the accumulator')), to = lines.findIndex((l) => l.includes('; P = 2^(16 - bit length)'));
    lines.splice(from, to - from + 1, `        ldi   r7, ${o.plain}            ; plain LMS: the step is a constant, whatever the level`);
  }
  return lines.join('\n');
}
