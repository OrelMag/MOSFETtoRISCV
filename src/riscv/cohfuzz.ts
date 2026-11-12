// Seeded random programs for the coherent dual-core: loops over shared lines (stores, loads, amoadd / amoswap,
// bounded lr.w / sc.w retry loops, a stray lr.w or sc.w), addresses that share lines between the cores and that
// collide in the caches' sets (evictions, dirty write-backs), a start-up delay for hart 1. Both cores run the same
// code; every loop is bounded, so every program halts.

export function randomCoherentProgram(seed: number, opts: { size?: number; iterations?: number } = {}): string {
  let s = (seed * 2654435761) >>> 0 || 1;
  const rnd = (n: number) => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s % n; };
  const T = ['t0', 't1', 't2', 'a1', 'a2'], reg = () => T[rnd(T.length)];
  const word = () => 4 * rnd(32); // the whole 128-byte memory: two tags per set
  const hot = () => 64 + 4 * rnd(8); // eight words in two lines
  const addr = () => (rnd(3) ? hot() : word());
  const n = opts.size ?? 30, out: string[] = [];
  let label = 0;
  out.push('csrr a0, mhartid', 'li s0, 0', `li s1, ${opts.iterations ?? 3 + rnd(4)}`, `li t6, ${rnd(5)}`);
  out.push('mv t4, a0', 'beqz t4, go', 'dl: addi t6, t6, -1', 'bgtz t6, dl', 'go:');
  out.push('li t0, 1', 'li t1, 2', 'li t2, 3', 'li a1, 5', 'li a2, 7', 'loop:');
  const size = () => out.filter((l) => !/^\w+:$/.test(l)).length;
  for (let i = 0; i < n && size() < 40; i++) { // the ROM holds 64 words
    const k = rnd(14), r = reg(), q = reg();
    if (k < 3) out.push(`lw ${r}, ${addr()}(s0)`);
    else if (k < 6) out.push(`sw ${r}, ${addr()}(s0)`);
    else if (k === 6) out.push(`addi ${r}, ${r}, ${rnd(9) - 4}`);
    else if (k === 7) out.push(`add ${r}, ${r}, ${q}`);
    else if (k === 8) out.push(`slli t5, a0, 2`, `lw ${r}, ${hot()}(t5)`, `addi ${r}, ${r}, 1`, `sw ${r}, ${hot()}(t5)`);
    else if (k === 9) out.push(`addi t3, s0, ${addr()}`, `${rnd(2) ? 'amoadd.w' : 'amoswap.w'} ${r}, ${q}, (t3)`);
    else if (k < 13) {
      const L = label++;
      out.push(`addi t3, s0, ${addr()}`, 'li t4, 3', `retry${L}: lr.w ${r}, (t3)`, `addi ${r}, ${r}, 1`, `sc.w t5, ${r}, (t3)`, `beqz t5, done${L}`, 'addi t4, t4, -1', `bgtz t4, retry${L}`, `done${L}:`);
    } else if (rnd(2)) out.push(`addi t3, s0, ${addr()}`, `lr.w ${r}, (t3)`);
    else out.push(`addi t3, s0, ${addr()}`, `sc.w t5, ${r}, (t3)`);
  }
  out.push('addi s1, s1, -1', 'bnez s1, loop', 'halt: j halt');
  return out.join('\n');
}
