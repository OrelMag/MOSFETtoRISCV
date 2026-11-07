// Measures the DSP core: NANDs per block (stats), the clock period (static timing of the computer, the way tests/verify/bench.ts times the
// RV32 machines) and cycles per benchmark (the golden model, which tests/dsp-core-lockstep.test.ts holds equal to the gates every clock).
//   node node_modules/vite-node/vite-node.mjs scripts/dsp/dspcore-bench.ts [--write]     writes src/bench/dspcore.json
import { writeFileSync } from 'node:fs';
import '../../src/lib';
import { assemble24 } from '../../src/dsp/asm24';
import { Iss24 } from '../../src/dsp/iss24';
import { BENCH24 } from '../../src/dsp/programs24';
import { DSP24_AGU, DSP24_AGU_STEP } from '../../src/lib/dsp24agu';
import { DSP24_ALU, DSP24_DECODE } from '../../src/lib/dsp24';
import { DSP24_MAC, DSP24_REGS, dsp24Computer, dsp24Core, rom24 } from '../../src/lib/dsp24core';
import { DSP24_LOOP, DSP24_SEQ } from '../../src/lib/dsp24seq';
import { macUnit } from '../../src/lib/macunit';
import { treeMul } from '../../src/lib/muldiv';
import { bigRam } from '../../src/lib/bigmem';
import { flatten } from '../../src/sim/flatten';
import { stats } from '../../src/sim/stats';
import { analyzeTiming } from '../../src/sim/timing';

const n = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const b0 = BENCH24[0];
const w0 = assemble24(b0.src).words;
const computer = dsp24Computer(w0, b0.x, b0.y);
const core = dsp24Core();
const timing = analyzeTiming(flatten(computer, { mode: 'gate' }));

const out = {
  nands: {
    core: n(core),
    decode: n(DSP24_DECODE), regs: n(DSP24_REGS), alu: n(DSP24_ALU), agu: n(DSP24_AGU), aguStep: n(DSP24_AGU_STEP),
    seq: n(DSP24_SEQ), loop: n(DSP24_LOOP), mac: n(DSP24_MAC), macUnit: n(macUnit()), secondMultiplier: n(treeMul(16, true)),
    rom: n(rom24(w0)), ram: n(bigRam(8, 16)),
    computer: n(computer),
  },
  period: timing?.period ?? null,
  cycles: Object.fromEntries(BENCH24.map((b) => {
    const iss = new Iss24(assemble24(b.src).words, b.x, b.y);
    iss.run();
    return [b.id, { cycles: iss.steps, outs: iss.out.length, macs: b.macs, words: assemble24(b.src).words.length }];
  })),
};
console.log(JSON.stringify(out, null, 1));
if (process.argv.includes('--write')) {
  writeFileSync('src/bench/dspcore.json', JSON.stringify(out, null, 1) + '\n');
  console.log('wrote src/bench/dspcore.json');
}
