// Writes tests/fixtures/py-asm-snapshot.json: the hashes tests/pyasm-snapshot.test.ts compares. Run it on purpose only.
import { writeFileSync } from 'node:fs';
import { snapshotCases } from '../tests/pyasm-cases';

const cases = snapshotCases();
writeFileSync('tests/fixtures/py-asm-snapshot.json', JSON.stringify(cases, null, 0) + '\n');
console.log(Object.keys(cases).length, 'cases');
