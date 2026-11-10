// Prints GateSim's unit-delay fingerprints (tests/gatesimfingerprint.ts); --write pins them in tests/gatesim-fingerprints.json.
// Take them on main before changing the engine (docs/PLAN-FINEDELAY.md, stage 1).
import { writeFileSync } from 'node:fs';
import { stepFingerprints, traceFingerprints } from '../tests/gatesimfingerprint';

const text = `${JSON.stringify({ trace: traceFingerprints(), steps: stepFingerprints() }, null, 1)}\n`;
if (process.argv.includes('--write')) writeFileSync('tests/gatesim-fingerprints.json', text);
console.log(text.length > 4000 ? `${text.slice(0, 1500)}…` : text);
