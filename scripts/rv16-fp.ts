// The RV16 fingerprints tests/rv16-custom.test.ts pins: every registered rv16_* part, and every campaign level's
// reference answer (its chip documents) whose level places an RV16 core. --write: tests/rv16-fingerprints.json.
import { writeFileSync } from 'node:fs';
import '../src/lib/index';
import { NODES } from '../src/campaign/nodes';
import { levelChallenge } from '../src/campaign/levels';
import { rv16Fingerprints } from '../tests/rv16fingerprint';
const out = rv16Fingerprints(NODES.map((n) => () => levelChallenge(n)));
const text = `${JSON.stringify(out, null, 1)}\n`;
if (process.argv.includes('--write')) writeFileSync('tests/rv16-fingerprints.json', text);
else console.log(text);
