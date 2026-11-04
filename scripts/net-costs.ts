// npx vite-node scripts/net-costs.ts [--write]   measures chapter 50's ping on the gates (about a minute) and prints it; --write saves src/comm/stack/netcosts.json

import { writeFileSync } from 'node:fs';
import { measureLan } from './netcosts-lib';

const t0 = Date.now();
const r = await measureLan(1);
console.log(JSON.stringify({ clocksToFirstReply: r.clocksToFirstReply, rtt: r.rtt, words: r.words, dma: r.dma, pollPass: r.pollPass, console: r.console }, null, 1));
for (const c of ['a', 'b'] as const) {
  console.log(`computer ${c}`);
  for (const [k, v] of Object.entries(r.layers[c])) console.log(`  ${k.padEnd(8)} instr ${String(v.instr).padStart(6)}  clocks ${String(v.clocks).padStart(6)}  loads ${String(v.loads).padStart(5)}  stores ${String(v.stores).padStart(5)}`);
}
for (const w of r.windows) console.log(`${w.computer} ${w.entry.padEnd(12)} ${String(w.start).padStart(6)}..${String(w.end).padStart(6)}  instr ${w.total.instr} clocks ${w.total.clocks} loads ${w.total.loads} stores ${w.total.stores}  ${Object.entries(w.layers).map(([k, v]) => `${k} ${v.instr}/${v.clocks}`).join(' ')}  [${w.visited.join(' ')}]`);
console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s`);
if (process.argv.includes('--write')) writeFileSync(new URL('../src/comm/stack/netcosts.json', import.meta.url), JSON.stringify(r, null, 1) + '\n');
