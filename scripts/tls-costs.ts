// Measures the TLS client (size, RAM, cycles per primitive and per handshake phase) and writes src/crypto/tls/costs.json with --write.
//   vite-node scripts/tls-costs.ts [--write]

import { writeFileSync } from 'node:fs';
import { measureCosts } from './tls-costs-measure';

const c = await measureCosts();
console.log(JSON.stringify(c, null, 1));
if (process.argv.includes('--write')) writeFileSync('src/crypto/tls/costs.json', `${JSON.stringify(c, null, 1)}\n`);
process.exit(0);
