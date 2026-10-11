// Reference programs for the puzzles on the RV16 (src/riscv/rv16) puzzle computer (computers.ts: its I/O). Each passes every
// test on the gates (tests/puzzles.test.ts); their cycles and sizes are the pars (refdata.json).

export const REFS_16: Record<string, string> = {
  echo: `loop:   lw   a0, -4(x0)
        beqz a0, done
        sw   a0, -3(x0)
        j    loop
done:   halt
`,
};
