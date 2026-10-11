// Reference programs for the puzzles on the RV32I (src/riscv/asm.ts) puzzle computer (computers.ts: its I/O). Each passes every
// test on the gates (tests/puzzles.test.ts); their cycles and sizes are the pars (refdata.json).

export const REFS_32: Record<string, string> = {
  echo: `        lui  s0, 0x80000
loop:   lw   a0, 0(s0)
        beqz a0, done
        sw   a0, 4(s0)
        j    loop
done:   j    done
`,
};
