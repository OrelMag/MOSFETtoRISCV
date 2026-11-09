// Feasibility of correlation power analysis (CPA) on our gate-level AES S-box (lib/aes.ts aesSbox, the tower-field
// circuit), the side-channels plan's decision 5. A trace = the switched capacitance (sim/power.ts PowerMeter, glitches
// included) of loading S(p ⊕ k) into an 8-bit register after it held S(0): the byte-serial setting of the textbooks.
// For N random plaintext bytes and 20 keys, the key's rank among the 256 guesses under two leakage models:
//   out: Hamming distance of the register's update, HW(S(p ⊕ g) ⊕ S(0)) (the textbook target);
//   in:  Hamming weight of the S-box's input, HW(p ⊕ g) (AddRoundKey's output: a weaker, linear target).
// npx vite-node scripts/sidechan-cpa.ts

import '../src/lib/index';
import { aesSbox } from '../src/lib/aes';
import { constWord } from '../src/lib/alu';
import { register } from '../src/lib/sequential';
import { xorshift32 } from '../src/riscv/benchprograms';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { PowerMeter } from '../src/sim/power';
import type { ComponentDef } from '../src/sim/types';

const sb = aesSbox(), S = (x: number) => sb.spec!([x])[0];
const def = {
  id: 'cpa_sbreg', name: 'S-box into a register', category: 'arithmetic', summary: '',
  ports: [{ name: 'x', width: 8, dir: 'in' }, { name: 'clk', width: 1, dir: 'in' }, { name: 'q', width: 8, dir: 'out' }],
  symbol: { kind: 'box', label: 'T' },
  netlist: () => ({
    pins: { x: [0, 1], clk: [0, 30], q: [80, 1] },
    instances: [{ name: 'sb', def: sb, at: [4, 0] }, { name: 'r', def: register(8), at: [50, 0] }, { name: 'one', def: constWord(1, 1), at: [40, 30] }],
    nets: [{ ends: ['x', 'sb.x'] }, { ends: ['sb.y', 'r.d'] }, { ends: ['clk', 'r.clk'] }, { ends: ['one.y', 'r.en'] }, { ends: ['r.q', 'q'] }],
  }),
} as unknown as ComponentDef;

const sim = new GateSim(flatten(def, { mode: 'gate' }));
const setx = (x: number) => { sim.setInputBits('x', Array.from({ length: 8 }, (_, i) => (x >> i) & 1)); sim.settle(); };
const pulse = () => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };
sim.setInput('clk', 0); setx(0); pulse();
const meter = new PowerMeter(sim);
const trace = (x: number) => { setx(0); pulse(); meter.reset(); setx(x); pulse(); return meter.totals().switched; };
const E = Array.from({ length: 256 }, (_, x) => trace(x));

const hw = (v: number) => { let c = 0; while (v) { c += v & 1; v >>>= 1; } return c; };
const corr = (a: number[], b: number[]) => {
  const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb || 1);
};
const MODELS: [string, (x: number) => number][] = [['out', (x) => hw(S(x) ^ S(0))], ['in', hw]];

console.log(`energy per load: ${Math.min(...E).toFixed(0)} to ${Math.max(...E).toFixed(0)} fF`);
for (const [name, f] of MODELS) {
  console.log(`${name}: correlation over all 256 inputs ${corr(E, E.map((_, x) => f(x))).toFixed(3)}`);
  for (const N of [16, 64, 256, 1024]) {
    let found = 0; const ranks: number[] = [];
    for (let trial = 1; trial <= 20; trial++) {
      const key = xorshift32(trial * 31, 1)[0] & 255, ps = xorshift32(trial * 977 + N, N).map((w) => w & 255);
      const tr = ps.map((p) => E[p ^ key]);
      const sc = Array.from({ length: 256 }, (_, g) => corr(tr, ps.map((p) => f(p ^ g))));
      const r = sc.filter((s) => s > sc[key]).length;
      ranks.push(r); if (r === 0) found++;
    }
    console.log(`  ${N} traces: key found ${found} / 20, median rank ${ranks.sort((a, b) => a - b)[10]}`);
  }
}
