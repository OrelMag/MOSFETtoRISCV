// The Vectors chapter's numbers (src/bench/vectorcosts.ts) printed, or saved with --write to src/bench/vectorcosts.json,
// which tests/vectors-chapter.test.ts checks against a fresh computation.
import { writeFileSync } from 'node:fs';
import { vectorCosts } from '../src/bench/vectorcosts';

const c = vectorCosts();
const text = JSON.stringify(c, null, 1) + '\n';
if (process.argv.includes('--write')) writeFileSync(new URL('../src/bench/vectorcosts.json', import.meta.url), text);
console.log(text);
