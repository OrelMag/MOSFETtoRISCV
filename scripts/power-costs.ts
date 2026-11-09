// The Power chapter's numbers (src/bench/powercosts.ts) printed, or saved with --write to src/bench/powercosts.json,
// which tests/power-costs.test.ts checks against a fresh computation.
import { writeFileSync } from 'node:fs';
import { powerCosts } from '../src/bench/powercosts';

const c = powerCosts();
const text = JSON.stringify(c, null, 1) + '\n';
if (process.argv.includes('--write')) writeFileSync(new URL('../src/bench/powercosts.json', import.meta.url), text);
console.log(text);
