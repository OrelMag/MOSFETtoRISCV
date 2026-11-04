// Act 12's build levels (Links, roadmap Phase 21 g): relays as repeaters and selectors, the synchronizer, a UART's two halves,
// an I²C controller, CRC-32, the 8b/10b encoder and clock recovery, each against the far end of its link on a bench
// (commcheck.ts). The reference answers are chapters 39–47's library circuits drawn as chips. No DOM.

import type { BuildChallenge, PinSpec } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc, PartRef } from '../editor/model';
import { syncN } from '../lib/sync';
import { UART_RX, UART_TX } from '../lib/uart';
import type { ComponentDef } from '../sim/types';
import { runSync, runUartRx, runUartTx, RX_SCENARIOS, SYNC_PORT, TX_CASES } from './commcheck';

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
  l_uarttx: () => ({
    id: 'l_uarttx', title: 'UART transmitter', level: 'sequential', allowed: 'nand',
    brief: 'A byte in, a frame out. The baud generator is on the bench: <b>tick</b> is high one clock in every <i>div</i> (it is div = ' + TX_CASES.map((k) => k.div).join(', ') + ' in turn), and a bit lasts 16 ticks. '
      + 'With <b>go</b> = 1 while <b>busy</b> = 0 the byte on <b>din</b> is accepted, and <b>taken</b> is 1 in that very cycle. Then tx carries a frame: the start bit (0), the eight data bits least significant first, the stop bit (1), each exactly 16 ticks long, the line changing only on a tick; it idles at 1. <b>busy</b> is 1 while the frame is on the line, and a go while it is 1 must be ignored. '
      + 'The far end counts clocks: it names the first bit that is the wrong level or the wrong length, at any divisor.',
    ports: pinsOf(UART_TX),
    check: { kind: 'custom', describe: `Two bytes at each of ${TX_CASES.length} divisors, with a go in the middle of the first frame that must be ignored and the second byte offered as soon as busy falls: taken, every bit's level and length, busy.`, run: runUartTx },
    answer: refOf('l_uarttx', () => UART_TX, 'UART transmitter'),
  }),
  l_uartrx: () => ({
    id: 'l_uartrx', title: 'UART receiver', level: 'sequential', allowed: 'nand',
    brief: '<b>rx</b> carries frames from a sender whose clock is not yours, and <b>tick</b> (on the bench) is high one clock in every <i>div</i>; 16 ticks make a nominal bit. A low on rx at a tick may be the start of a frame. Confirm it in the middle of the start bit (a glitch is not a frame), then sample a bit every 16 ticks: eight data bits, least significant first, into <b>data</b>, and a ninth sample for the stop bit. '
      + 'A stop of 1 gives <b>push</b> for one clock with the byte on data; a stop of 0 gives <b>ferr</b> for one clock and no push, and the receiver waits for the line to go high (a break is one error, not a stream of zero bytes). <b>busy</b> is 0 when it is idle. rx is asynchronous. '
      + 'Be back to idle in the middle of the stop bit: the next start edge may come early. The far end is a sender up to 4% fast or slow, with its start edge anywhere between two ticks.',
    ports: pinsOf(UART_RX).filter((p) => p.name !== 'state'),
    check: { kind: 'custom', describe: `${RX_SCENARIOS.length} lines: back-to-back frames, gaps, senders 2 to 4% fast and slow, glitches of a few ticks on an idle line, a framing error and a break: every byte pushed once and in order, ferr counted, busy.`, run: runUartRx },
    answer: refOf('l_uartrx', () => UART_RX, 'UART receiver'),
  }),
};
