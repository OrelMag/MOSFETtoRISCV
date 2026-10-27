// SAP-1 sample programs, each with the values OUT shows in order (checked against the golden model by
// tests/sap-iss.test.ts, and against the gate-level computer by tests/sap.test.ts).

export interface SapProgram { id: string; name: string; src: string; outs: number[] }

export const SAP_PROGRAMS: SapProgram[] = [
  {
    id: 'add', name: 'Add two numbers',
    src: `; 28 + 14 on the display
        LDA a
        ADD b
        OUT
        HLT
a:      .byte 28
b:      .byte 14`,
    outs: [42],
  },
  {
    id: 'countup', name: 'Count up',
    src: `; count up by 15 until the adder carries out of bit 7
        LDI 0
loop:   OUT
        ADD step
        JC done         ; past 255: stop
        JMP loop
done:   HLT
step:   .byte 15`,
    outs: Array.from({ length: 18 }, (_, i) => i * 15),
  },
  {
    id: 'countdown', name: 'Count down to zero',
    src: `; count down from 10; JZ ends the loop when SUB leaves zero
        LDA n
loop:   OUT
        SUB one
        JZ done
        JMP loop
done:   OUT             ; show the 0
        HLT
one:    .byte 1
n:      .byte 10`,
    outs: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  },
  {
    id: 'fib', name: 'Fibonacci',
    src: `; x and y leapfrog: x = x + y, y = x + y, until a sum carries
loop:   LDA x
        OUT
        ADD y
        JC done
        STA x
        LDA y
        OUT
        ADD x
        JC done
        STA y
        JMP loop
done:   HLT
x:      .byte 0
y:      .byte 1`,
    outs: [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144],
  },
  {
    id: 'mul', name: 'Multiply',
    src: `; Ben's multiply: product += y, x times (x - 1 carries while x >= 1)
top:    LDA x
        SUB one
        JC more         ; no borrow: x was at least 1
        LDA product
        OUT
        HLT
more:   STA x
        LDA product
        ADD y
        STA product
        JMP top
        .byte 0
one:    .byte 1
product: .byte 0
x:      .byte 3
y:      .byte 29`,
    outs: [87],
  },
];
