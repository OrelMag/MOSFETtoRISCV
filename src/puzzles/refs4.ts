// Reference programs for the puzzles on the 4-bit CPU (4004 assembly, src/isa4) puzzle computer (computers.ts: its I/O). Each passes every
// test on the gates (tests/puzzles.test.ts); their cycles and sizes are the pars (refdata.json).

export const REFS_4: Record<string, string> = {
  echo: `; a word is two nibbles, high first: read both, stop on 00
loop:   RDR
        XCH  R0
        RDR
        XCH  R1
        LD   R0
        JCN  AN, out
        LD   R1
        JCN  AN, out
done:   JUN  done
out:    LD   R0
        WRR
        LD   R1
        WRR
        JUN  loop
`,
};
