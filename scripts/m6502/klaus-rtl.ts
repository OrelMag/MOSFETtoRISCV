// Klaus Dormann's functional test on the RTL model (npx vite-node scripts/m6502/klaus-rtl.ts; needs the cache:
// node scripts/m6502/fetch-tests.mjs). Success is the trap at $3469.
import { readFileSync } from 'node:fs';
import { Ram64 } from '../../src/m6502/iss';
import { Rtl6502 } from '../../src/m6502/rtl';
const ram = new Ram64(); ram.mem.set(readFileSync('tests/m6502/.cache/6502_functional_test.bin'));
const cpu = new Rtl6502(ram); cpu.boundary({ pc: 0x400 });
const t0 = performance.now(); let last = -1, same = 0;
for (let i = 0; ; i++) {
  cpu.cycle();
  if (cpu.sync) { if (cpu.addr === last) { if (++same > 3) break; } else { same = 0; last = cpu.addr; } }
}
console.log('trap at', last.toString(16), 'cycles', cpu.cycles, 'Mc/s', (cpu.cycles / (performance.now() - t0) / 1000).toFixed(2));
