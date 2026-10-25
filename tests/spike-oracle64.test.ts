// The RV64 Spike oracle's plumbing, without Spike (scripts/spike-oracle.ts runs the real one in CI, config rv64im):
// the ELF64 it loads, the parser on RV64 log lines, and the comparison against a Spike-format log of ISS64.
import { describe, expect, it } from 'vitest';
import { CODE, DATA, EXIT, FROMHOST, STUB, TOHOST } from './verify/spike';
import { compareWithSpike64, DMEM_WORDS64, issAsSpikeLog64, ORACLE_CONFIGS64, oracleCase64, oracleIss64, parseSpikeLog64 } from './verify/spike64';
import { decode, OPCODES } from '../src/riscv/isa';

/** The ELF64 fields Spike reads: class, machine, entry, loadable segments, symbols by name. */
function readElf64(b: Uint8Array) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true), u32 = (o: number) => dv.getUint32(o, true);
  const u64 = (o: number) => Number(dv.getBigUint64(o, true));
  const segs: { vaddr: number; bytes: Uint8Array }[] = [];
  for (let i = 0; i < u16(56); i++) {
    const o = u64(32) + i * u16(54);
    if (u32(o) === 1) segs.push({ vaddr: u64(o + 16), bytes: b.subarray(u64(o + 8), u64(o + 8) + u64(o + 32)) });
  }
  const syms: Record<string, number> = {};
  const sh = (i: number) => u64(40) + i * u16(58);
  for (let i = 0; i < u16(60); i++) {
    if (u32(sh(i) + 4) !== 2) continue;
    const so = u64(sh(i) + 24), size = u64(sh(i) + 32), str = u64(sh(u32(sh(i) + 40)) + 24);
    for (let s = so + 24; s < so + size; s += 24) {
      let e = str + u32(s);
      while (b[e]) e++;
      syms[new TextDecoder().decode(b.subarray(str + u32(s), e))] = u64(s + 8);
    }
  }
  return { magic: u32(0), cls: b[4], machine: u16(18), entry: u64(24), segs, syms };
}

const cfg = ORACLE_CONFIGS64[0];

describe('Spike oracle, RV64', () => {
  it('links a program as an ELF64 RISC-V executable with tohost and fromhost', () => {
    const c = oracleCase64(cfg, 1);
    const e = readElf64(c.elf);
    expect([e.magic, e.cls, e.machine, e.entry]).toEqual([0x464c457f, 2, 243, STUB]);
    expect(e.syms).toEqual({ tohost: TOHOST, fromhost: FROMHOST });
    const code = e.segs.find((s) => s.vaddr === CODE)!;
    const word = (i: number) => new DataView(code.bytes.buffer, code.bytes.byteOffset).getUint32(4 * i, true);
    expect(Array.from({ length: c.halt / 4 }, (_, i) => word(i))).toEqual(c.words.slice(0, c.halt / 4));
    expect(word(c.halt / 4)).not.toBe(c.words[c.halt / 4]);
    const stub = e.segs.find((s) => s.vaddr === STUB)!;
    expect(STUB + stub.bytes.length).toBeGreaterThanOrEqual(FROMHOST + 8);
    expect(EXIT).toBeLessThan(TOHOST);
  });

  it('parses RV64 commits (64-bit values, store widths) and traps', () => {
    const ev = parseSpikeLog64([
      'core   0: 0x0000000000001000 (0x00000297) auipc   t0, 0x0',
      'core   0: 3 0x0000000000001000 (0x00000297) x5  0x0000000000001000',
      'core   0: 3 0x0000000000010010 (0x0005b503) x10 0xfedcba9876543210 mem 0x0000000000020040',
      'core   0: 3 0x0000000000010014 (0x00a5b023) mem 0x0000000000020048 0xfedcba9876543210',
      'core   0: 3 0x0000000000010018 (0x00a59023) mem 0x0000000000020042 0x3210',
      'core   0: exception trap_illegal_instruction, epc 0x000000000001001c',
      'core   0:           tval 0x0000000000000000',
    ].join('\n'));
    expect(ev.map((e) => e.kind)).toEqual(['commit', 'commit', 'commit', 'commit', 'trap']);
    const [boot, ld, sd, sh, ill] = ev;
    expect(boot.kind === 'commit' && [boot.pc, boot.x.get(5)]).toEqual([0x1000n, 0x1000n]);
    expect(ld.kind === 'commit' && [ld.x.get(10), ld.loads]).toEqual([0xfedcba9876543210n, [0x20040n]]);
    expect(sd.kind === 'commit' && sd.stores).toEqual([{ addr: 0x20048n, value: 0xfedcba9876543210n, bits: 64 }]);
    expect(sh.kind === 'commit' && sh.stores).toEqual([{ addr: 0x20042n, value: 0x3210n, bits: 16 }]);
    expect(ill).toMatchObject({ kind: 'trap', name: 'trap_illegal_instruction', epc: 0x1001cn, tval: 0n });
  });

  it('keeps every load and store in the data window', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const c = oracleCase64(cfg, seed);
      const iss = oracleIss64(c);
      while (iss.pc !== BigInt(CODE + c.halt) && iss.steps < 20_000) {
        const d = decode(iss.fetch(iss.pc), undefined, 64);
        if (d.opcode === OPCODES.LOAD || d.opcode === OPCODES.STORE) {
          const a = BigInt.asUintN(64, iss.x[d.rs1] + BigInt(d.imm));
          expect(a >= BigInt(DATA) && a < BigInt(DATA + 4 * DMEM_WORDS64), `seed ${seed}`).toBe(true);
        }
        iss.step();
      }
    }
  });

  it('agrees with a Spike-format log of ISS64', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const c = oracleCase64(cfg, seed);
      const r = compareWithSpike64(c, parseSpikeLog64(issAsSpikeLog64(c)));
      expect(r.diff, `seed ${seed}`).toBe('');
      expect(r.steps).toBeGreaterThan(100);
    }
  });

  it('reports a changed upper half, a store, a trap and a load address', () => {
    const c = oracleCase64(cfg, 3);
    const lines = issAsSpikeLog64(c).split('\n');
    const at = (re: RegExp) => lines.findIndex((l, i) => i > 2 && re.test(l));
    const edit = (i: number, f: (l: string) => string) => compareWithSpike64(c, parseSpikeLog64(lines.map((l, k) => (k === i ? f(l) : l)).join('\n'))).diff;
    // the register's top hex digit: only a 64-bit comparison sees it
    expect(edit(at(/^core\s+0: 3 .* x\d+\s+0x/), (l) => l.replace(/(x\d+\s+0x)([0-9a-f])/, (_m, p, d) => p + (d === '0' ? '1' : '0')))).toMatch(/x\d+: ours 0x[0-9a-f]{16}, Spike/);
    expect(edit(at(/ mem 0x[0-9a-f]+ 0x/), (l) => l.replace(/ mem (0x[0-9a-f]+) /, ' mem 0x0000000000020ff8 '))).toMatch(/store: ours/);
    const ld = at(/ mem 0x[0-9a-f]+$/);
    expect(edit(ld, (l) => l.replace(/ mem 0x[0-9a-f]+$/, ' mem 0x0000000000020000'))).toMatch(/load address/);
    expect(edit(ld, (l) => `core   0: exception trap_load_access_fault, epc ${/ 3 (0x[0-9a-f]+)/.exec(l)![1]}`)).toMatch(/Spike traps/);
  });
});
