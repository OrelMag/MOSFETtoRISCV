// Chapter 26's small programs: loops short enough to read in a timeline. Each ends in a jump to itself.

export interface OooProgram { id: string; name: string; blurb: string; source: string }

export const OOO_PROGRAMS: OooProgram[] = [
  {
    id: 'dot',
    name: 'Dot product',
    blurb: 'Two loads, a multiply and an add per element: the add waits for the multiply, the next element\'s loads do not.',
    source: `# dot product of two 8-word vectors at 0x00 and 0x20, the sum at 0x80
        li   a0, 0
        li   a1, 32
        li   t3, 8
        li   s0, 0
loop:   lw   t0, 0(a0)
        lw   t1, 0(a1)
        mul  t2, t0, t1
        add  s0, s0, t2
        addi a0, a0, 4
        addi a1, a1, 4
        addi t3, t3, -1
        bnez t3, loop
        sw   s0, 128(zero)
halt:   j    halt`,
  },
  {
    id: 'chains',
    name: 'Two chains',
    blurb: 'Two independent running sums, one fed by a divide per element: in order or not, the loop runs at the one divider\'s pace.',
    source: `# s0 += i / 3 and s1 += i, for i = 16 … 1
        li   t3, 16
        li   t4, 3
        li   s0, 0
        li   s1, 0
loop:   div  t0, t3, t4
        add  s0, s0, t0
        add  s1, s1, t3
        addi t3, t3, -1
        bnez t3, loop
        sw   s0, 0(zero)
        sw   s1, 4(zero)
halt:   j    halt`,
  },
  {
    id: 'names',
    name: 'Reused names',
    blurb: 'One register, t0, carries three unrelated values: without renaming each reuse waits for the last reader.',
    source: `# three independent computations that all use t0 as scratch
        li   a0, 5
        li   a1, 7
        li   a2, 9
        mul  t0, a0, a0
        sw   t0, 0(zero)
        mul  t0, a1, a1
        sw   t0, 4(zero)
        mul  t0, a2, a2
        sw   t0, 8(zero)
halt:   j    halt`,
  },
];

/**
 * Hennessy & Patterson's scoreboard example in RV32IM registers (L.D F6 / L.D F2 / MUL.D F0 / SUB.D F8 / DIV.D F10 /
 * ADD.D F6): a structural stall on the load unit, RAW waits, and the add's WAR on t1, which the divide still has to read.
 */
export const SCOREBOARD_SOURCE = `lw   t1, 0(a0)
lw   t2, 4(a1)
mul  t0, t2, s1
sub  t3, t1, t2
div  t4, t0, t1
add  t1, t3, t2`;
