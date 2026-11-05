// Measures what the AES-128 and SHA-256 gates cost and prints a table; --write saves src/crypto/gatecosts.json.
//   npx vite-node scripts/secret-costs.ts [--write]
import { writeFileSync } from 'node:fs';
import { measureSecretCosts } from '../src/crypto/costs';

const c = measureSecretCosts();
const pad = (s: string | number | null, n: number) => String(s ?? '-').padStart(n);
console.log('part'.padEnd(20), pad('NANDs', 8), pad('transistors', 12), pad('depth', 7));
for (const [k, v] of Object.entries(c.parts)) console.log(k.padEnd(20), pad(v.nands, 8), pad(v.transistors, 12), pad(v.depth, 7));
console.log('core'.padEnd(20), pad('NANDs', 8), pad('transistors', 12), pad('cycles', 7), pad('period', 7), pad('latency', 8));
for (const [k, v] of Object.entries(c.cores)) console.log(k.padEnd(20), pad(v.nands, 8), pad(v.transistors, 12), pad(v.cycles, 7), pad(v.period, 7), pad(v.cycles * v.period, 8));
if (process.argv.includes('--write')) {
  writeFileSync('src/crypto/gatecosts.json', JSON.stringify(c, null, 2) + '\n');
  console.log('wrote src/crypto/gatecosts.json');
}
