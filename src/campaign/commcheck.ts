// The benches of act 12 (Links, roadmap Phase 21 g). Each far end is a JS model that knows its rules and names the first
// one a circuit breaks: the destination's clock and the failure rate of a synchronizer (phys/metastable.ts), a UART receiver
// that samples a frame in the middle of each bit, an I²C bus wired as an AND with a rival controller on it, a CRC check on the
// frame's far end, a decoder that counts disparity, a receiver that must lock to a drifting stream. Lanes of a BitSim run one
// scenario each. No DOM.

import type { CustomRun } from '../editor/challenges';
import { BitSim } from '../sim/bitsim';
import { flatten } from '../sim/flatten';
import { analyzeTiming } from '../sim/timing';
import { PS_PER_NAND } from '../sim/timing';
import type { ComponentDef } from '../sim/types';
import { fmtLog10, log10Mtbf, resolutionTime, TAU_PS, T0_PS, windowRate } from '../phys/metastable';
import { rng } from './drills';

export const hex = (v: number, d = 2) => `0x${(v >>> 0).toString(16).padStart(d, '0')}`;

/** A BitSim for def, or why not (missing pins, cannot flatten). */
export function simOf(def: ComponentDef, pins: string[]): BitSim | string {
  const have = new Set(def.ports.map((p) => p.name));
  const missing = pins.filter((p) => !have.has(p));
  if (missing.length) return `missing pins: ${missing.join(', ')}`;
  try {
    return new BitSim(flatten(def, { mode: 'gate' }));
  } catch (e) {
    return `cannot simulate: ${(e as Error).message}`;
  }
}

export function periodOf(def: ComponentDef): number | undefined {
  try { return analyzeTiming(flatten(def, { mode: 'gate' }))?.period ?? undefined; } catch { return undefined; }
}

/** The failures (at most 6 shown) and, for a chip that passes, its period. */
export function finish(failures: string[], tested: number, def: ComponentDef, extra: Partial<CustomRun> = {}): CustomRun {
  return {
    failures: failures.slice(0, 6).concat(failures.length > 6 ? [`… and ${failures.length - 6} more fail`] : []), tested, ...extra,
    ...(failures.length ? {} : (() => { const p = periodOf(def); return p ? { period: p } : {}; })()),
  };
}

// ---- l_sync: a synchronizer for a fast port -------------------------------------------------------------------------------

/** The port the synchronizer serves: a 1.6 GHz receiver, data changing at up to 160 MHz, read by 8 NAND delays of logic, a failure at most once in 100 years. */
export const SYNC_PORT = { fclk: 1.6e9, fdata: 1.6e8, downstream: 8, years: 100 } as const;
const YEAR_S = 86400 * 365.25;

/** log10 of the MTBF (s) of `stages` flip-flops in a row with `between` NAND delays of logic inside the chain, on the port. */
export function syncLog10(stages: number, between = 0, port = SYNC_PORT): number {
  const T = 1e12 / port.fclk;
  const raw = resolutionTime(stages, T, stages <= 1 ? port.downstream * PS_PER_NAND : 0);
  const tr = Math.max(0, raw - (stages <= 1 ? 0 : between * PS_PER_NAND));
  return tr / TAU_PS / Math.LN10 - Math.log10(windowRate(port.fclk, port.fdata, T0_PS));
}
void log10Mtbf;

/** Seeded pulse trains for the lanes: runs of 3 to 8 cycles. */
function trains(lanes: number, len: number): number[][] {
  return Array.from({ length: lanes }, (_, l) => {
    const r = rng(40 + l), s: number[] = [];
    let v = 0;
    while (s.length < len) {
      const run = l === 0 ? (s.length < 6 ? 6 : 3 + Math.floor(r() * 3)) : 3 + Math.floor(r() * 6);
      for (let i = 0; i < run && s.length < len; i++) s.push(v);
      v ^= 1;
    }
    return s;
  });
}

export function runSync(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the synchronizer is gates and flip-flops'], tested: 0 };
  const sim = simOf(def, ['d', 'clk', 'q']);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const lanes = 8, len = 60, d = trains(lanes, len);
  const pre: number[][] = [], post: number[][] = [];
  for (let t = 0; t < len; t++) {
    sim.setInput('d', d.map((s) => s[t]));
    sim.settle();
    pre.push(sim.get('q', lanes));
    sim.cycle();
    post.push(sim.get('q', lanes));
  }
  // the latency: edges from the first rise of d (lane 0) to the first rise of q before the edge
  const t0 = d[0].indexOf(1), t1 = pre.findIndex((q) => q[0] === 1);
  if (t1 < 0) return { failures: [`q never rose: d rose at cycle ${t0} and was held for ${d[0].slice(t0).indexOf(0)} cycles`], tested: len };
  const L = t1 - t0;
  const fails: string[] = [];
  if (L === 0) fails.push(`q follows d in the same cycle (it rose before the edge that samples d): nothing on the receiving clock holds it. A change of d at any moment of the cycle would reach the logic behind q at any moment`);
  for (let t = 0; t < len && fails.length < 4; t++) {
    for (let l = 0; l < lanes; l++) {
      const want = t >= L ? d[l][t - L] : 0;
      if (pre[t][l] !== want) { fails.push(`cycle ${t}: q reads ${pre[t][l]}, but d was ${want} ${L} cycle${L === 1 ? '' : 's'} ago (pulse train ${l + 1}): q must be d delayed by the same ${L} cycles throughout`); break; }
    }
  }
  let between = 0;
  try { between = analyzeTiming(flatten(def, { mode: 'gate' }))?.logic ?? 0; } catch { /* no flip-flops: caught above */ }
  const need = Math.log10(SYNC_PORT.years * YEAR_S);
  if (!fails.length && L >= 1) {
    const l10 = syncLog10(L, Math.max(0, between));
    if (l10 < need) {
      fails.push(`at ${SYNC_PORT.fclk / 1e9} GHz with data changing at ${SYNC_PORT.fdata / 1e6} MHz, ${L === 1 ? 'one flip-flop read by the logic behind it' : `${L} flip-flops${between > 0 ? ` with ${between} NAND ${between === 1 ? 'delay' : 'delays'} of logic inside the chain` : ''}`} fails about once in ${fmtLog10(l10)}; the port needs ${SYNC_PORT.years} years. The first flip-flop has ${Math.round(Math.max(0, resolutionTime(L, 1e12 / SYNC_PORT.fclk, L <= 1 ? SYNC_PORT.downstream * PS_PER_NAND : 0) - (L <= 1 ? 0 : between * PS_PER_NAND)))} ps to decide, and each extra flip-flop adds a clock period.`);
    }
  }
  return finish(fails, len, def, { cycles: L });
}
