// What the cipher hardware costs, measured from the circuits (never typed): NAND counts from sim/stats.ts, logic depth by the unit-delay model,
// the clock period of the cores from static timing, and the clocks from start to done counted on the simulator.
// scripts/secret-costs.ts --write saves it as gatecosts.json; tests/crypto-costs.test.ts holds the file equal to a fresh measurement.

import { aesCore, aesRound, aesSbox, gf256Inv, keyStep, mixColumn, subBytes } from '../lib/aes';
import { shaCore, shaK, shaRound, shaSchedule } from '../lib/sha256';
import { flatten } from '../sim/flatten';
import { simulate } from '../sim/harness';
import { logicDepth, stats } from '../sim/stats';
import { analyzeTiming } from '../sim/timing';
import type { ComponentDef } from '../sim/types';

export interface PartCost { nands: number; transistors: number; depth: number | null }
export interface CoreCost extends PartCost { cycles: number; period: number }
export interface GateCosts {
  note: string;
  parts: Record<string, PartCost>;
  cores: Record<string, CoreCost>;
}

const part = (d: ComponentDef): PartCost => { const s = stats(d); return { nands: s.nands, transistors: s.transistors, depth: logicDepth(d) }; };

/** Clocks from the edge that sees start = 1 to the first state with done = 1 (that edge counts), counted on the gates. */
function cyclesToDone(d: ComponentDef, limit: number): number {
  const sim = simulate(d), p = sim.design.root.ports;
  const zero = (port: string, n: number) => sim.setInputBits(port, new Array<number>(n).fill(0));
  for (const q of d.ports.filter((x) => x.dir === 'in' && x.width > 1)) zero(q.name, q.width);
  sim.setInput('clk', 0); sim.setInput('start', 0); sim.setInput('rst', 1); sim.settle();
  sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.setInput('rst', 0); sim.settle();
  sim.setInput('start', 1); sim.settle();
  for (let n = 1; n <= limit; n++) {
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.setInput('start', 0); sim.settle();
    if (sim.getBits(p.done)[0] === 1) return n;
  }
  throw new Error(`${d.id}: done never rose in ${limit} clocks`);
}

const core = (d: ComponentDef, limit: number): CoreCost => ({
  nands: stats(d).nands, transistors: stats(d).transistors, depth: null, cycles: cyclesToDone(d, limit),
  period: analyzeTiming(flatten(d, { mode: 'gate' }))?.period ?? 0,
});

export function measureSecretCosts(): GateCosts {
  return {
    note: 'NAND counts and transistors from sim/stats.ts; depth in NAND delays from logicDepth; period = clk-to-q + logic + setup of the critical register-to-register path (sim/timing.ts, NAND delays); cycles = clocks from the start edge to done, counted on a GateSim. Regenerate: npx vite-node scripts/secret-costs.ts --write',
    parts: {
      aes_gf256_inverse: part(gf256Inv()),
      aes_sbox: part(aesSbox()),
      aes_mixcolumn: part(mixColumn()),
      aes_subbytes: part(subBytes()),
      aes_round: part(aesRound()),
      aes_key_step: part(keyStep()),
      sha_k_rom: part(shaK()),
      sha_schedule: { nands: stats(shaSchedule()).nands, transistors: stats(shaSchedule()).transistors, depth: null },
      sha_round: part(shaRound()),
    },
    cores: {
      aes_core: core(aesCore(), 20),
      sha_core: core(shaCore(), 80),
    },
  };
}
