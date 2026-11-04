// Act 12's build levels (Links, roadmap Phase 21 g): relays as repeaters and selectors, the synchronizer, a UART's two halves,
// an I²C controller, CRC-32, the 8b/10b encoder and clock recovery, each against the far end of its link on a bench
// (commcheck.ts). The reference answers are chapters 39–47's library circuits drawn as chips. No DOM.

import type { BuildChallenge, PinSpec } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc, PartRef } from '../editor/model';
import { syncN } from '../lib/sync';
import { crcNext, crcUnit } from '../lib/crc';
import { CDR, CDR_CTL, ENC34, ENC56, ENC8B10B } from '../lib/serdes';
import { UART_RX, UART_TX } from '../lib/uart';
import { netlistOf } from '../sim/types';
import type { ComponentDef } from '../sim/types';
import { run8b10b, runCdr, CDR_SCENARIOS, runCrc, runSync, runUartRx, runUartTx, RX_SCENARIOS, SYNC_PORT, TX_CASES } from './commcheck';

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

export const CRC_UNIT = (): ComponentDef => crcUnit(32, undefined, 8);
export const CRC_NEXT = (): ComponentDef => crcNext(32, undefined, 8);
/** The library ids the CRC reference is drawn from, its XOR network's gates included (the network itself is what the level builds). */
export const crcGives = (): string[] => [...new Set([...(netlistOf(CRC_UNIT())?.instances ?? []), ...(netlistOf(CRC_NEXT())?.instances ?? [])].map((i) => i.def.id).filter((id) => id !== CRC_NEXT().id))];

/** The library ids a reference is drawn from, its sub-chips' parts included (the sub-chips themselves are what the level builds). */
export const leafGives = (def: () => ComponentDef, subs: () => ComponentDef[]) => (): string[] => {
  const skip = new Set(subs().map((d) => d.id));
  return [...new Set([def(), ...subs()].flatMap((d) => netlistOf(d)?.instances ?? []).map((i) => i.def.id).filter((id) => !skip.has(id)))];
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
  l_crc: () => ({
    id: 'l_crc', title: 'CRC-32', level: 'sequential', allowed: 'nand',
    brief: 'The check at the end of an Ethernet frame. A register of 32 flip-flops holds the running remainder, <b>q</b>. <b>init</b> = 1 loads all ones at the next clock, whatever <b>en</b> says; with <b>en</b> = 1 each clock takes one byte on <b>d</b>, the first bit sent in d[0], through the generator 0xEDB88320 (the reflected form of 0x04C11DB7: each bit is a right shift, and a 1 shifted out XORs the generator in); with en = 0 it holds. '
      + '<b>fcs</b> is the complement of q: the check sequence as it goes on the wire, least significant byte first. After a frame and its own FCS, q is the constant 0xDEBB20E3. The far end is a sender: it checks q after every clock against a model, then appends the FCS of each frame and checks the residue. A byte is eight bit steps in one clock: build one bit step as a chip, or find which inputs each output bit is the XOR of.',
    ports: pinsOf(CRC_UNIT()),
    check: { kind: 'custom', describe: '16 frames (the check string "123456789", an empty frame, seeded frames of 1 to 24 bytes) with idle clocks that must be ignored and an init beating en: q after every clock, fcs = ~q, and the residue after each frame and its FCS.', run: runCrc },
    answer: refOf('l_crc', CRC_UNIT, 'CRC-32 byte unit', () => [[CRC_NEXT(), 'CRC-32 next state']]),
  }),
  l_8b10b: () => ({
    id: 'l_8b10b', title: '8b/10b encoder', level: 'sequential', allowed: 'nand',
    brief: 'A byte <b>d</b> (or, with <b>k</b> = 1, one of the twelve control codes) and the running disparity <b>rd</b> (0: more zeros sent so far, 1: more ones) become ten bits <b>code</b>, a first (bit 9), and <b>rdout</b>, the disparity after. The line must stay balanced: after every symbol the ones sent exceed the zeros by at most one, or the zeros the ones, with a 6-bit block and a 4-bit block each balanced or off by two in the direction that pulls back; and no more than five equal bits in a row, so the receiver can find the clock. '
      + 'The far end is a decoder that follows the running disparity: it checks every one of the 256 data bytes and 12 control codes at both disparities, then 32 streams of 40 symbols with rdout fed back.',
    ports: pinsOf(ENC8B10B),
    check: { kind: 'custom', describe: '268 symbols at both disparities (the sub-blocks stay within ±1, no run over five, rdout right, the symbol decodes to its byte), then 32 seeded streams with rdout fed back (the line\'s disparity and runs across symbols).', run: run8b10b },
    answer: refOf('l_8b10b', () => ENC8B10B, '8b/10b encoder', () => [[ENC56, '5b/6b encoder'], [ENC34, '3b/4b encoder']]),
  }),
  l_cdr: () => ({
    id: 'l_cdr', title: 'Clock recovery', level: 'sequential', allowed: 'nand',
    brief: 'The line <b>rxd</b> carries an 8b/10b stream at four clock cycles a bit, from a sender whose clock is not yours: up to 2.5% fast or slow, and drifting while it runs. Nothing else arrives with it. Take a sample of the line every cycle, and raise <b>strobe</b> once a bit, at the moment <b>bit</b> (the newest sample) is the middle of a bit cell. '
      + 'The transitions in the data are the clock: compare the samples around an edge (an early or late vote, the Alexander detector), filter the votes (four the same way) and only then move the strobe by one sample. The far end sends ' + CDR_SCENARIOS.length + ' streams and checks that, after 100 bits of lock-in, the bits taken at the strobe are the bits sent, none twice and none lost.',
    ports: pinsOf(CDR).filter((p) => ['rxd', 'clk', 'bit', 'strobe'].includes(p.name)),
    check: { kind: 'custom', describe: CDR_SCENARIOS.length + ' streams of about 1700 bits (a comma every eighth word): nominal, 1.5% fast, 1.5% slow, drifting to 2.5% either way, and a drift that changes sign: strobes about every 4 cycles, then every bit equal to the one sent.', run: runCdr },
    answer: refOf('l_cdr', () => CDR, 'Clock recovery', () => [[CDR_CTL, 'Strobe counter and vote filter']]),
  }),
};
