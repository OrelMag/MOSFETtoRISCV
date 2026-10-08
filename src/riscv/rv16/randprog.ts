// Random RV16 programs for fuzzing a learner's core against the golden model: every register is
// written before it is read, loads and stores stay in data words 0…31, branches and jumps only go
// forward (so every program ends), and the program ends with halt. Seeded: one seed, one program.

/** Which instructions to use: 1 arithmetic, 2 + loads / stores, 3 + branches and jal. */
export type RandLevel = 1 | 2 | 3;

const R_OPS = ['add', 'sub', 'sll', 'slt', 'sltu', 'xor', 'srl', 'sra', 'or', 'and'];
const B_OPS = ['beq', 'bne', 'blt', 'bge'];
const REGS = ['ra', 'sp', 'a0', 'a1', 'a2', 't0', 't1'];

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MUL_OPS = ['mul', 'mulh', 'mulhsu', 'mulhu'];
const DIV_OPS = ['div', 'divu', 'rem', 'remu'];

/** md: also the MD opcode (multiplies only, or multiplies and divides). */
export function randomProgram(seed: number, level: RandLevel, n = 40, md?: 'mul' | 'all'): string {
  const r = mulberry(seed * 7919 + level);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  // Edge values are where datapaths break.
  const value = () => (r() < 0.4 ? pick([0, 1, -1, 0x7fff, -0x8000, 0x8001, 15, 16, -2]) : int(-0x8000, 0x7fff));
  const lines: string[] = REGS.map((x) => `        li   ${x}, ${value()}`);
  const pending: { label: string; at: number }[] = [];
  let label = 0;
  for (let i = 0; i < n; i++) {
    for (const p of pending.filter((q) => q.at === i)) lines.push(`${p.label}:`);
    const rd = pick(REGS), a = pick([...REGS, 'zero']), b = pick([...REGS, 'zero']);
    const u = r();
    if (level >= 3 && u < 0.15) {
      const l = `f${label++}`;
      pending.push({ label: l, at: i + int(1, 4) });
      lines.push(r() < 0.8 ? `        ${pick(B_OPS)} ${a}, ${b}, ${l}` : `        jal  ${pick([...REGS, 'zero'])}, ${l}`);
      continue;
    }
    if (level >= 2 && u < 0.35) {
      const k = int(0, 31);
      lines.push(r() < 0.5 ? `        sw   ${a}, ${k}(zero)` : `        lw   ${rd}, ${k}(zero)`);
      continue;
    }
    if (md && r() < 0.3) {
      lines.push(`        ${pick(md === 'all' && r() < 0.5 ? DIV_OPS : MUL_OPS)} ${rd}, ${a}, ${b}`);
      continue;
    }
    const v = r();
    if (v < 0.55) lines.push(`        ${pick(R_OPS)} ${rd}, ${a}, ${b}`);
    else if (v < 0.75) lines.push(`        addi ${rd}, ${a}, ${int(-32, 31)}`);
    else if (v < 0.92) lines.push(`        ${pick(['slli', 'srli', 'srai'])} ${rd}, ${a}, ${int(0, 15)}`);
    else lines.push(`        lui  ${rd}, ${int(0, 1023)}`);
  }
  for (const p of pending.filter((q) => q.at >= n)) lines.push(`${p.label}:`);
  lines.push('        halt');
  return `${lines.join('\n')}\n`;
}
