// Seeded random AGC programs for the yaAGC oracle (scripts/agc/oracle.ts): straight-line code with forward branches,
// over every instruction the golden model runs, on operands in erasable memory, the central registers and the
// editing registers. A program starts with INHINT, loads random words into its erasable cells, runs `length` random
// instructions and ends in a loop on itself (the halt the model and the harness stop at).
//
// Left out on purpose: I/O channels, RESUME / EDRUPT (not modelled), Z as an operand (a write to Z is a jump anywhere),
// the counters 024–057 (INCR / AUG there request interrupts), and INDEX on anything but a small table index (an
// indexed word can become any instruction).

export interface RandOpts { length?: number }

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELLS = 16; // E0 … E15 at 0100; S0 … S3 in switched erasable at 01400 (EB as set)
const oct = (n: number) => n.toString(8);

export function randomAgcProgram(seed: number, opts: RandOpts = {}): string {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const length = opts.length ?? 120;
  const lines: string[] = [];
  const at = (label: string, text: string) => lines.push(`${label.padEnd(8)}${text}`);
  const op = (text: string) => at('', text);
  // a random word: small, large, ±0, ±1, the ends
  const word = (): number => {
    const k = r();
    if (k < 0.15) return pick([0, 0o77777, 1, 0o77776, 0o37777, 0o40000]);
    if (k < 0.5) return Math.floor(r() * 64) ^ (r() < 0.5 ? 0 : 0o77777);
    return Math.floor(r() * 0o100000);
  };
  // erasable layout
  for (let i = 0; i < CELLS; i++) at(`E${i}`, `= ${oct(0o100 + i)}`);
  for (let i = 0; i < 4; i++) at(`S${i}`, `= ${oct(0o1400 + i)}`);
  at('IX', `= ${oct(0o140)}`);
  const cells = Array.from({ length: CELLS }, (_, i) => `E${i}`);
  const single = [...cells, ...cells, 'S0', 'S1', 'S2', 'S3', 'A', 'L', 'Q', 'CYR', 'SR', 'CYL', 'EDOP', 'EB', 'FB', 'BB'];
  const readOnly = [...single, 'ZERO', 'KTAB', 'KTAB +1', 'KTAB +2', 'KTAB +3'];
  // a double word's high half: K, K + 1 both cells (or A, L / L, Q / the registers' neighbours)
  const pairs = [...cells.slice(0, CELLS - 1), 'S0', 'S1', 'S2', 'A', 'L', 'CYR', 'SR', 'CYL'];
  const consts: number[] = [];
  const k = (v: number) => { consts.push(v & 0o77777); return `K${consts.length - 1}`; };

  lines.push('        SETLOC 4000');
  op('INHINT');
  // switched erasable bank and the starting words
  op(`CA ${k(pick([0o0400, 0o1000, 0o1400, 0o3400]))}`); op('TS EB');
  for (let i = 0; i < CELLS; i++) { op(`CA ${k(word())}`); op(`TS E${i}`); }
  for (let i = 0; i < 4; i++) { op(`CA ${k(word())}`); op(`TS S${i}`); }
  op(`CA ${k(word())}`); op(`CA ${k(word())}`); op('TS L'); op(`CA ${k(word())}`);

  let label = 0;
  const pending: { name: string; after: number }[] = [];
  for (let n = 0; n < length; n++) {
    // a forward branch target lands here
    for (let j = pending.length - 1; j >= 0; j--) if (pending[j].after <= 0) { at(pending[j].name, 'NOOP'); pending.splice(j, 1); } else pending[j].after--;
    const kind = r();
    if (kind < 0.06) {
      const name = `F${label++}`;
      pending.push({ name, after: 1 + Math.floor(r() * 4) });
      if (r() < 0.5) { op('EXTEND'); op(`${pick(['BZF', 'BZMF'])} ${name}`); } else op(`TCF ${name}`);
      continue;
    }
    if (kind < 0.09) {
      // INDEX over a four-word table
      op(`CA ${k(Math.floor(r() * 4))}`); op('TS IX'); op('INDEX IX'); op(`${pick(['CA', 'AD', 'MASK', 'CS'])} KTAB`);
      continue;
    }
    if (kind < 0.11) {
      // a subroutine call and return
      op('TC SUBR');
      continue;
    }
    if (kind < 0.16) { op(`CA ${k(word())}`); continue; }
    if (kind < 0.2) { op(`CA ${k(word())}`); op('TS L'); continue; }
    const basic = r() < 0.55;
    if (basic) {
      const o = pick(['CCS', 'DAS', 'LXCH', 'INCR', 'ADS', 'CA', 'CS', 'DXCH', 'TS', 'XCH', 'AD', 'MASK', 'COM', 'DOUBLE', 'DDOUBL', 'ZL', 'OVSK'] as const);
      if (o === 'COM' || o === 'DOUBLE' || o === 'DDOUBL' || o === 'ZL') { op(o); continue; }
      if (o === 'OVSK') { op('TS A'); continue; }
      if (o === 'DAS' || o === 'DXCH') { op(`${o} ${pick(pairs)}`); continue; }
      if (o === 'CA' || o === 'CS' || o === 'AD' || o === 'MASK') { op(`${o} ${r() < 0.2 ? k(word()) : pick(readOnly)}`); continue; }
      op(`${o} ${pick(single)}`);
    } else {
      const o = pick(['DV', 'MSU', 'QXCH', 'AUG', 'DIM', 'DCA', 'DCS', 'SU', 'MP', 'SQUARE', 'DCOM', 'ZQ'] as const);
      op('EXTEND');
      if (o === 'SQUARE' || o === 'DCOM' || o === 'ZQ') { op(o); continue; }
      if (o === 'DCA' || o === 'DCS') { op(`${o} ${pick(pairs)}`); continue; }
      if (o === 'MP') { op(`MP ${r() < 0.2 ? k(word()) : pick(readOnly)}`); continue; }
      op(`${o} ${pick(single)}`);
    }
  }
  for (const p of pending) at(p.name, 'NOOP');
  at('DONE', 'TCF DONE');
  op('TCF DONE'); op('TCF DONE'); op('TCF DONE');
  // the subroutine: a little work, then RETURN (Q holds the return address unless the work changed it: keep it simple)
  at('SUBR', 'CA E0');
  op('AD E1');
  op('TS E2');
  op('TS E2');
  op('RETURN');
  at('KTAB', `OCT ${oct(word())}`);
  for (let i = 0; i < 3; i++) op(`OCT ${oct(word())}`);
  consts.forEach((v, i) => at(`K${i}`, `OCT ${oct(v)}`));
  return lines.join('\n') + '\n';
}
