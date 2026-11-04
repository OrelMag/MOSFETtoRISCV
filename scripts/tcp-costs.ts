// Runs the Python TCP on the model-speed bench and writes what chapter 52 quotes to src/net/tcpcosts.json (--write). tests/net-tcp-costs.test.ts holds the file to the code.

import { writeFileSync } from 'node:fs';
import { TCP } from '../src/comm/stack/tcp';
import { measureBench, tcpBench } from '../src/net/tcpbench';

const RUNS = {
  fast: { bytes: 8000, o: { queue: 8, byteClocks: 32, delay: 2000 } },
  saw: { bytes: 6000, o: { queue: 4, byteClocks: 200, delay: 20000 } },
  small: { bytes: 3000, o: { queue: 3, byteClocks: 400, delay: 10000 } },
} as const;

const out: Record<string, unknown> = {};
for (const [k, r] of Object.entries(RUNS)) {
  const t0 = Date.now();
  const m = await measureBench(r.bytes, r.o);
  out[k] = { ...r, ...m };
  console.log(k, JSON.stringify({ clocks: m.clocks, frames: m.frames, drops: m.drops, misses: m.misses, fast: m.fast, timeouts: m.timeouts, a: m.console.a, b: m.console.b, layers: m.layers }), `${Date.now() - t0} ms`);
  console.log(' cwnd', m.cwnd.map((p) => p.cwnd / 64).join(' ').slice(0, 300));
}
const t = tcpBench(1000);
out.words = { a: t.a.compiled.words.length, b: t.b.compiled.words.length };
out.lines = TCP.py.split('\n').length;
if (process.argv.includes('--write')) writeFileSync('src/net/tcpcosts.json', `${JSON.stringify(out, null, 1)}\n`);
process.exit(0);
