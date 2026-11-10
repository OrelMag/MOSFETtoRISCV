// The narrowed copy of a generated riscv-vector-tests file for the gate-level vector unit: the rules are listed in
// scripts/rvv-tests/build.mjs, which applies them.

/** The gate rules above, applied to one stage-2 source. Returns null with a reason when nothing is left to run. */
export function gatesVariant(src) {
  const lines = src.split('\n');
  const out = [];
  let keep = true, widen = false, blocks = 0, kept = 0;
  for (const line of lines) {
    const head = /^# Generating tests for .*SEW: (e\d+)/.exec(line);
    if (head) { blocks++; keep = head[1] === 'e32'; if (keep) kept++; }
    if (/^\s*TEST_PASSFAIL/.test(line) || /^RVTEST_CODE_END/.test(line)) keep = true; // the end belongs to every test
    if (!keep) continue;
    if (/^\s*csrwi\s+vxrm\b/.test(line) || /^\s*csrci\s+vxsat\b/.test(line)) continue;
    const set = /^(\s*vsetvli\s+\w+,\s*x0,\s*)e8(,\s*m[1248]\b.*)$/.exec(line);
    if (set) { out.push(`${set[1]}e32${set[2]}`); widen = true; continue; }
    if (widen && /^\s*v[ls]e8\.v\b/.test(line)) { out.push(line.replace(/v([ls])e8\.v/, 'v$1e32.v')); widen = false; continue; }
    if (/^\s*vsetvli\b/.test(line)) widen = false;
    out.push(line);
  }
  const cases = out.filter((l) => /^\s*TEST_CASE\(/.test(l)).length;
  if (!cases) return { reason: kept ? 'no TEST_CASE left in its e32 blocks' : `no e32 block (of ${blocks})` };
  return { src: pruneData(out.join('\n'), src), cases, blocks, kept };
}


/**
 * Rule 5 of the gate copy: the test data the dropped blocks used is dropped too. The generator appends one chunk per
 * operand group to `testdata` and points a0 at it with `la a0, testdata` / `li a5, <offset>` / `add a0, a0, a5`; a
 * chunk runs from its offset to the next one. The chunks the kept code still names are packed in their order and the
 * offsets rewritten. The data is the generator's `.quad` lines; anything else naming testdata leaves the file as it is.
 */
export function pruneData(src, all) {
  const lines = src.split('\n');
  const offs = (s) => [...s.matchAll(/^\s*la a0, testdata\n\s*li a5, (\d+)$/gm)].map((m) => +m[1]);
  if ((src.match(/testdata/g) ?? []).length !== offs(src).length + 1) return src; // only the pattern and the label
  const begin = lines.findIndex((l) => /^testdata:\s*$/.test(l));
  const end = lines.findIndex((l, i) => i > begin && /^RVTEST_DATA_END/.test(l));
  if (begin < 0 || end < 0) return src;
  const quads = lines.slice(begin + 1, end).filter((l) => l.trim());
  if (!quads.every((l) => /^\s*\.quad 0x[0-9a-f]+$/i.test(l))) return src;
  const bytes = Buffer.alloc(8 * quads.length);
  quads.forEach((l, i) => bytes.writeBigUInt64LE(BigInt(l.trim().slice(6)), 8 * i));
  const bounds = [...new Set(offs(all))].sort((a, b) => a - b);
  const chunkEnd = (o) => bounds.find((b) => b > o) ?? bytes.length;
  const keep = [...new Set(offs(src))].sort((a, b) => a - b);
  const moved = new Map();
  const parts = [];
  let at = 0;
  for (const o of keep) {
    const pad = (8 - (at % 8)) % 8; // each chunk 8-byte aligned, as the generator's are
    if (pad) { parts.push(Buffer.alloc(pad)); at += pad; }
    moved.set(o, at);
    parts.push(bytes.subarray(o, chunkEnd(o)));
    at += chunkEnd(o) - o;
  }
  const packed = Buffer.concat(parts);
  const out = [];
  for (let i = 0; i < packed.length; i += 16) out.push(`  .byte ${[...packed.subarray(i, i + 16)].map((b) => `0x${b.toString(16)}`).join(', ')}`);
  const body = [...lines.slice(0, begin + 1), ...out, ...lines.slice(end)].join('\n');
  return body.replace(/^(\s*la a0, testdata\n\s*li a5, )(\d+)$/gm, (_m, p, o) => `${p}${moved.get(+o)}`);
}
