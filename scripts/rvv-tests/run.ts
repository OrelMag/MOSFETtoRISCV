// Run built riscv-vector-tests images (scripts/rvv-tests/build.mjs output) on the golden model.
//
//   npx vite-node scripts/rvv-tests/run.ts [<dir with v128 / v128-gates .json + .bin.br>] [--only <substring>]
//
// v128.json on ISS({ v: { vlen: 128 } }) (Zve32x as specified); v128-gates.json on that and on ISS({ v: { gates: true } })
// (the gate-level unit's subset), where no vector instruction may be an illegal no-op: a narrowed test must not pass
// by skipping work. Prints failures by test, totals by instruction, and exits 1 on any failure. The directory defaults
// to the checked-in suite (tests/verify/rvv-tests); another build's output can be named instead.
import { resolve } from 'node:path';
import { instrOf as instr, runRvv, rvvSuite, RVV_DIR, type RvvSuite } from '../../tests/verify/rvvtests';

const args = process.argv.slice(2);
const dir = resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--only') ?? RVV_DIR);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : '';



const images = (f: RvvSuite) => f.names.filter((n) => n.includes(only)).map((n) => f.image(n));

const failures: string[] = [];
const byInstr = new Map<string, { tests: number; cases: number }>();
const t0 = performance.now();
const full = rvvSuite('v128', dir);
for (const img of images(full)) {
  const r = runRvv(img, false);
  if (!r.pass) failures.push(`${img.name} (as generated, golden model): ${r.text}`);
  if (!img.cases) failures.push(`${img.name}: no TEST_CASE`);
  const s = byInstr.get(instr(img.name)) ?? { tests: 0, cases: 0 };
  byInstr.set(instr(img.name), { tests: s.tests + 1, cases: s.cases + img.cases });
}
const gates = rvvSuite('v128-gates', dir);
let gateTests = 0, gateCases = 0;
for (const img of images(gates)) {
  for (const g of [false, true]) {
    const r = runRvv(img, g);
    if (!r.pass) failures.push(`${img.name} (gate copy, ${g ? 'gate subset' : 'golden model'}): ${r.text}`);
    if (g && r.illegal) failures.push(`${img.name} (gate copy): ${r.illegal} vector instructions were illegal no-ops`);
  }
  gateTests++; gateCases += img.cases;
}
const s = (performance.now() - t0) / 1000;
console.log(`${dir}: ${[...byInstr.values()].reduce((a, b) => a + b.tests, 0)} tests of ${byInstr.size} instructions (${[...byInstr.values()].reduce((a, b) => a + b.cases, 0)} checks) as generated; ${gateTests} gate copies (${gateCases} checks); ${Object.keys(gates.index.notApplicable ?? {}).length} not applicable to the gates; ${s.toFixed(0)} s`);
if (failures.length) {
  console.log(`${failures.length} failures:\n${failures.slice(0, 60).join('\n')}${failures.length > 60 ? '\n…' : ''}`);
  process.exit(1);
}
console.log('all pass');
