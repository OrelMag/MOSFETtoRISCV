// Writes src/learn/reviewbank.json: questions the review queue asks beyond the authored quizzes (learn/bank.ts).
//   predict: a combinational tour's beat ("set a = 1, b = 0: what is c?"), its answer the beat's expect (pinned by
//            tests/tours.test.ts), distractors from the port's width
//   ablate:  a codex figure's part removed ("which outputs go wrong?"), answered by sim/ablate.ts
// Run after changing a tour or a codex figure: `node node_modules/vite-node/vite-node.mjs scripts/review-bank.ts`.
// tests/reviewbank.test.ts fails when the file is stale.

import { writeFileSync } from 'node:fs';
import { buildBank } from '../src/learn/bankgen';

const bank = buildBank();
writeFileSync('src/learn/reviewbank.json', JSON.stringify(bank, null, 0).replace(/\},\{/g, '},\n{') + '\n');
console.log(`${bank.length} questions: ${bank.filter((q) => q.kind === 'predict').length} predict, ${bank.filter((q) => q.kind === 'ablate').length} ablate`);
