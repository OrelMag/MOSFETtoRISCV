// The DSP core's benchmark set, in its own assembly: FIR 16 and 64 taps, a two-section biquad cascade, a 128-element dot
// product and a 64-point FFT. Each is a program plus the X and Y memory images it starts from; the data are the oracle's
// (scripts/dsp/oracle.py, tests/dsp/vectors/dspcore.json), which also holds the answers the gates must give.

import { BIQUAD_DATA, DOT_DATA, FFT_DATA, FIR16_DATA, FIR64_DATA } from './bench24data';

export interface Bench24 {
  id: string;
  name: string;
  /** What the loop is, in one line (the chapter's table). */
  about: string;
  src: string;
  /** The X and Y memories at power-on (256 words each). */
  x: number[];
  y: number[];
  /** The number of `out` words a run produces. */
  outs: number;
  /** The inner multiply-accumulate steps (taps, or products) the run performs, for cycles per tap. */
  macs: number;
}

const image = (words: number[]): number[] => {
  const m = new Array<number>(256).fill(0);
  words.forEach((v, i) => { m[i] = v & 0xffff; });
  return m;
};

/** A streaming FIR: the delay line is a circular window of X, the newest sample overwrites the oldest, N taps in a loop. */
export function firBench(id: string, name: string, h: number[], xs: number[]): Bench24 {
  const N = h.length, M = xs.length;
  const xmem = new Array<number>(N + M).fill(0);
  xs.forEach((v, i) => { xmem[N + i] = v; });
  const src = `; ${name}: ${N} taps, ${M} samples. X[0..${N - 1}] is the delay line (a circular window), the input follows it.
; Y holds the taps backwards: the oldest sample meets h[${N - 1}] first.
        ldi   xl, ${N}          ; circular window of X: base 0, length ${N}
        ldi   yl, ${N}          ; and of Y
        ldi   p1, ${N}          ; input pointer
        ldi   r2, ${M}          ; samples to go
        clr
next:   ld    r1, x(p1)+        ; the next input sample
        st    x(p0)+c, r1       ; over the oldest one; the pointer lands on the oldest left
        loop  ${N}, tap
tap:    mac   x(p0)+c, y(p4)+c  ; one tap a cycle, no branch, both pointers stepping
        rndc  r3, 15            ; round once, saturate once, and clear for the next sample
        out   r3
        addi  r2, r2, -1
        jnz   r2, next
        halt
`;
  return { id, name, about: `${N}-tap FIR, circular delay line`, src, x: image(xmem), y: image([...h].reverse()), outs: M, macs: N * M };
}

/** Two direct-form I sections (Q3.13 coefficients), each run over the whole block as a stream. */
export function biquadBench(sections: number[][], xs: number[]): Bench24 {
  const L = xs.length, S = sections.length;
  const stride = L + 2;
  const xmem = new Array<number>(2 + stride * (S + 1)).fill(0);
  xs.forEach((v, i) => { xmem[2 + i] = v; });
  const ymem: number[] = [];
  for (const [b0, b1, b2, a1, a2] of sections) ymem.push(b2, b1, b0, -a2, -a1);
  let src = `; Biquad cascade: ${S} direct-form I sections of a 4th-order Butterworth low-pass, ${L} samples, Q3.13 coefficients.
; Every signal is an array in X with two zeros in front; a section reads three inputs and two outputs by sliding windows.
; Y holds each section's five coefficients in the order they are used (the feedback ones negated, so every step is a mac);
; the Y window is circular (length 5).
        ldi   yl, 5
        clr
`;
  for (let s = 0; s < S; s++) {
    const last = s === S - 1, n = s + 1;
    src += `; section ${n}
        ldi   p0, ${s * stride}
        ldi   p1, ${(s + 1) * stride}
        ldi   p2, ${(s + 1) * stride + 2}
        ldi   p4, ${5 * s}
        ldi   yb, ${5 * s}
        loop  ${L}, s${n}
        mac   x(p0)+, y(p4)+c   ; b2 · x[n-2]
        mac   x(p0)+, y(p4)+c   ; b1 · x[n-1]
        mac   x(p0)-, y(p4)+c   ; b0 · x[n]   (the window slides by one: + + -)
        mac   x(p1)+, y(p4)+c   ; −a2 · y[n-2]
        mac   x(p1), y(p4)+c    ; −a1 · y[n-1]  (+ then unchanged: it slides by one too)
        rndc  r1, 13
${last ? `        st    x(p2)+, r1
s${n}:    out   r1
` : `s${n}:    st    x(p2)+, r1
`}`;
  }
  src += '        halt\n';
  return { id: 'biquad', name: 'Biquad cascade', about: `${S} biquad sections, sliding windows`, src, x: image(xmem), y: image(ymem), outs: L, macs: 5 * S * L };
}

/** A dot product: one product a cycle under a loop of one instruction. */
export function dotBench(xs: number[], ys: number[]): Bench24 {
  const N = xs.length;
  const src = `; Dot product of two ${N}-word vectors, X · Y: the whole inner loop is one instruction. Two results: the sum shifted by 15 and by 13.
        clr
        loop  ${N}, dot
dot:    mac   x(p0)+, y(p4)+
        rnd   r1, 15
        out   r1
        rnd   r1, 13
        out   r1
        halt
`;
  return { id: 'dot', name: 'Dot product', about: `${N}-element dot product`, src, x: image(xs), y: image(ys), outs: 2, macs: N };
}

/** 64-point decimation-in-time FFT: the input copied into bit-reversed order by the address generator, six stages of butterflies. */
export function fftBench(re: number[], im: number[], wr: number[], wi: number[]): Bench24 {
  const N = 64;
  const xmem = new Array<number>(256).fill(0);
  re.forEach((v, i) => { xmem[128 + i] = v; });
  im.forEach((v, i) => { xmem[192 + i] = v; });
  let src = `; 64-point FFT, decimation in time. X[0..63] real, X[64..127] imaginary (the working arrays), the input in natural order at
; X[128..] and X[192..]. Y[0..31] holds cos, Y[32..63] -sin, Y[64..95] sin. The copy into bit-reversed order is done by the address
; generator: the reverse-carry modifier 0x20 counts 0, 32, 16, 48, ... Six stages; each is a loop of butterflies.
        clr
        ldi   xm, 32            ; reverse-carry modifier for 64 points
        ldi   p0, 0             ; destination, real (bit-reversed order)
        ldi   p2, 64            ; destination, imaginary
        ldi   p1, 128           ; source, real (natural order)
        ldi   p3, 192           ; source, imaginary
        loop  64, copy
        ld    r1, x(p1)+
        ld    r2, x(p3)+
        st    x(p0)+r, r1
copy:   st    x(p2)+r, r2
`;
  for (let s = 1; s <= 6; s++) {
    const half = 1 << (s - 1), groups = N / 2 / half, stride = 32 / half;
    src += `; stage ${s}: ${groups} group${groups > 1 ? 's' : ''} of ${half} butterfl${half > 1 ? 'ies' : 'y'}, twiddle stride ${stride}
        ldi   p0, 0
        ldi   p1, 64
        ldi   p2, ${half}
        ldi   p3, ${64 + half}
        ldi   ym, ${stride}
        ldi   r6, ${groups}
g${s}:     ldi   p4, 0
        ldi   p5, 32
        ldi   p6, 64
        loop  ${half}, b${s}
        mac   x(p2), y(p4)      ; b.re · cos
        mac   x(p3), y(p6)+m    ; + b.im · sin  (the third table holds sin, so a subtraction is a mac)
        rndc  r1, 15            ; t.re
        mac   x(p2), y(p5)+m    ; b.re · (−sin)
        mac   x(p3), y(p4)+m    ; + b.im · cos; the twiddle pointers step by the stride
        rndc  r2, 15            ; t.im
        ld    r3, x(p0)
        ld    r4, x(p1)
        add   r5, r3, r1        ; a + t
        sub   r3, r3, r1        ; a − t
        add   r1, r4, r2
        sub   r4, r4, r2
        st    x(p0)+, r5
        st    x(p2)+, r3
        st    x(p1)+, r1
b${s}:     st    x(p3)+, r4
`;
    src += `        mov   p0, p2            ; next group
        mov   p1, p3
        mov   r1, p2
        addi  r1, r1, ${half}
        mov   p2, r1
        mov   r1, p3
        addi  r1, r1, ${half}
        mov   p3, r1
        addi  r6, r6, -1
        jnz   r6, g${s}
`;
  }
  src += `; the 64 complex results, real part first
        ldi   p0, 0
        loop  128, out
        ld    r1, x(p0)+
out:    out   r1
        halt
`;
  return { id: 'fft', name: '64-point FFT', about: '64-point FFT, bit-reversed input addressing', src, x: image(xmem), y: image([...wr, ...wi, ...wi.map((v) => -v)]), outs: 128, macs: 4 * 32 * 6 };
}

export const BENCH24: Bench24[] = [
  firBench('fir16', 'FIR, 16 taps', FIR16_DATA.h, FIR16_DATA.x),
  firBench('fir64', 'FIR, 64 taps', FIR64_DATA.h, FIR64_DATA.x),
  biquadBench(BIQUAD_DATA.sections, BIQUAD_DATA.x),
  dotBench(DOT_DATA.x, DOT_DATA.y),
  fftBench(FFT_DATA.re, FFT_DATA.im, FFT_DATA.wr, FFT_DATA.wi),
];
