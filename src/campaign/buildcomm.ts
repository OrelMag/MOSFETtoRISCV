// Act 12's build levels (Links, roadmap Phase 21 g): relays as repeaters and selectors, the synchronizer, a UART's two halves,
// an I²C controller, CRC-32, the 8b/10b encoder and clock recovery, each against the far end of its link on a bench
// (commcheck.ts). The reference answers are chapters 39–47's library circuits drawn as chips. No DOM.

import type { BuildChallenge, PinSpec } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc, PartRef } from '../editor/model';
import { syncN } from '../lib/sync';
import type { ComponentDef } from '../sim/types';
import { runSync, SYNC_PORT } from './commcheck';

export const pinsOf = (def: ComponentDef): PinSpec[] => def.ports.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in', width: p.width, ...(p.clock ? { clock: true } : {}) }));

const answers = new Map<string, ChipDoc[]>();
/** A reference answer: the top def drawn as a chip, and `subs` (def → chip) drawn as chips it places. */
export const refOf = (id: string, def: () => ComponentDef, name: string, subs: () => [ComponentDef, string][] = () => []) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (a) return a;
  const chips = new Map(subs().map(([d, n], i) => [d, { id: `u_ref_cp_${id}_${i}`, name: `${n} ref` }]));
  const refOfDef = (d: ComponentDef): PartRef | undefined => (chips.has(d) ? { chip: chips.get(d)!.id } : undefined);
  const docs: ChipDoc[] = [];
  for (const [d, c] of chips) {
    const doc = docFromDef(d, { ...c, refOf: refOfDef });
    if ('error' in doc) throw new Error(`reference ${id} (${d.id}): ${doc.error}`);
    docs.push({ ...doc, notes: `Part of the reference answer. ${d.summary ?? ''}`.trim() });
  }
  const top = docFromDef(def(), { id: `u_ref_cp_${id}`, name: `${name} ref`, refOf: refOfDef });
  if ('error' in top) throw new Error(`reference ${id}: ${top.error}`);
  answers.set(id, (a = [...docs, { ...top, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
  return a;
};

export const SYNC_REF = (): ComponentDef => syncN(2);

export const BUILDCOMM: Record<string, () => BuildChallenge> = {
  l_sync: () => ({
    id: 'l_sync', title: 'Synchronizer', level: 'sequential', allowed: 'nand',
    brief: `<b>d</b> comes from another clock domain and changes whenever it likes; <b>clk</b> is this domain's. Deliver it as <b>q</b>, the same signal some whole number of cycles later, for pulses of 3 cycles and up. The port is a ${SYNC_PORT.fclk / 1e9} GHz receiver; d changes up to ${SYNC_PORT.fdata / 1e6} million times a second, and ${SYNC_PORT.downstream} NAND delays of logic read q. `
      + `The bench does not race the gates (a gate-level simulation has no metastability): it counts the flip-flops from the latency and the logic you put between them, and computes the failure rate from the resolution time the first one gets (e<sup>t<sub>r</sub>/τ</sup> / (T0 · f<sub>clk</sub> · f<sub>data</sub>)). It must fail less than once in ${SYNC_PORT.years} years. Graded on latency (cycles).`,
    ports: pinsOf(SYNC_REF()),
    check: { kind: 'custom', describe: 'Eight pulse trains on d (runs of 3 to 8 cycles): q must be d delayed by one fixed whole number of cycles, never the same cycle; then the failure rate of that many flip-flops with the logic inside the chain, at the port\'s clock and data rates, against 100 years.', run: runSync },
    answer: refOf('l_sync', SYNC_REF, 'Synchronizer'),
  }),
};
