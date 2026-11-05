// Writes src/crypto/tls/rfc8448.json from scripts/tls-flight.ts (kept apart so that a test can import the flight without writing it).
//   vite-node scripts/tls-flight-write.ts

import { writeFileSync } from 'node:fs';
import { flight } from './tls-flight';

writeFileSync('src/crypto/tls/rfc8448.json', `${JSON.stringify(flight(), null, 1)}\n`);
console.log('wrote src/crypto/tls/rfc8448.json');
