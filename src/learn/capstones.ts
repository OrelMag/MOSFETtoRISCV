// The tier capstones (DOM-free): one design per tier built from a spec sheet, with no walk, hints or "Do it for me",
// graded by the benches the campaign already has. Passing one marks its tier done on My path (learn/path.ts). This file
// is the interface My path reads; the capstone screens fill in `route` and the status as they are built.

export type Tier = 0 | 1 | 2 | 3 | 4;

export interface Capstone {
  tier: Exclude<Tier, 0>;
  id: string;
  title: string;
  /** One line: what is built and how it is graded. */
  brief: string;
  /** Where it is played; null while not built yet (My path shows it without a link). */
  route: string | null;
}

export const CAPSTONES: Capstone[] = [
  { tier: 1, id: 'cap_t1', title: 'An adding machine', brief: 'A 4-bit accumulator that adds what you key in, from the gates, adders and flip-flops of acts 1–3: checked by a test sequence, scored on NANDs and clock period.', route: '#/campaign/play/cap_t1' },
  { tier: 2, id: 'cap_t2', title: 'An RV16 core from its spec', brief: 'A single-cycle core that passes the core bench and plays Pong on itself, scored on NANDs, period and cycles.', route: '#/campaign/play/cap_t2' },
  { tier: 3, id: 'cap_t3', title: 'A pipelined core', brief: 'Forwarding and stalls on the core bench, scored on period × cycles against the reference.', route: '#/campaign/play/cap_t3' },
  { tier: 4, id: 'cap_t4', title: 'The cheapest core that runs the benchmarks', brief: 'A design brief: any RV16 core that runs a fixed workload to the golden model’s results, placed on a cost / speed chart against three reference cores and graded by where it lands.', route: '#/campaign/play/cap_t4' },
];

/** The communication track's capstones: a group of their own on My path, outside the four tiers, whose passes they do not touch. */
export interface CommCapstone { id: string; title: string; brief: string; route: string | null; tier?: undefined }

export type AnyCapstone = Capstone | CommCapstone;

export const COMM_CAPSTONES: CommCapstone[] = [
  { id: 'cap_console', title: 'A serial console', brief: 'A UART with its FIFOs and flags from its register sheet, working with a far end 3.5 % off in clock. Graded at its pins, by what the far end sees.', route: '#/campaign/play/cap_console' },
  { id: 'cap_link', title: 'A link that closes', brief: 'Choose modulation, coding and equalization for two stated channels, for the highest rate any choice can reach within the error target. Measured on the chapters\' code and channel models.', route: '#/campaign/play/cap_link' },
  { id: 'cap_switch', title: 'A switch from its spec', brief: 'A four-port learning switch from its rules, with memories, registers and counters as parts. Real frames, compared whole at every port, with a stated throughput at full load.', route: '#/campaign/play/cap_switch' },
  { id: 'cap_fault', title: 'Find the fault', brief: 'Eight broken networks, each with a real fault in one of the book\'s models. Name each cause from its evidence, with no hints: seven right passes.', route: '#/campaign/play/cap_fault' },
];

export type CapstoneStatus = 'none' | 'started' | 'passed';

/** A capstone's status from the campaign progress's node records (the capstone screens record there under its id). */
export function capstoneStatus(id: string, nodes: Record<string, { status?: string } | undefined>): CapstoneStatus {
  const s = nodes[id]?.status;
  return s === 'solved' ? 'passed' : s ? 'started' : 'none';
}
