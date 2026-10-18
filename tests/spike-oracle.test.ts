// The Spike oracle's plumbing, without Spike (scripts/spike-oracle.ts runs the real one in CI): the ELF it
// loads, the log parser on lines in Spike's formats, and the comparison against a Spike-format log of our own
// ISS, which must agree with itself and catch a changed value, a missing trap or a different store.
import { describe, expect, it } from 'vitest';
import { CODE, DATA, DMEM_WORDS, EXIT, FROMHOST, ORACLE_CONFIGS, STUB, TOHOST, compareWithSpike, issAsSpikeLog, oracleCase, oracleIss, parseSpikeLog } from './verify/spike';

/** The few ELF fields Spike reads: entry, loadable segments, symbols by name. */
function readElf(b: Uint8Array) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true), u32 = (o: number) => dv.getUint32(o, true);
  const segs: { vaddr: number; bytes: Uint8Array }[] = [];
  for (let i = 0; i < u16(44); i++) {
    const o = u32(28) + i * u16(42);
    if (u32(o) === 1) segs.push({ vaddr: u32(o + 8), bytes: b.subarray(u32(o + 4), u32(o + 4) + u32(o + 16)) });
  }
  const syms: Record<string, number> = {};
  const sh = (i: number) => u32(32) + i * u16(46);
  for (let i = 0; i < u16(48); i++) {
    if (u32(sh(i) + 4) !== 2) continue;
    const so = u32(sh(i) + 16), size = u32(sh(i) + 20), str = u32(sh(u32(sh(i) + 24)) + 16);
    for (let s = so + 16; s < so + size; s += 16) {
      let e = str + u32(s);
      while (b[e]) e++;
      syms[new TextDecoder().decode(b.subarray(str + u32(s), e))] = u32(s + 4);
    }
  }
  return { magic: u32(0), cls: b[4], machine: u16(18), entry: u32(24), segs, syms };
}

describe('Spike oracle', () => {
  it('links a program as an ELF32 RISC-V executable with tohost and fromhost', () => {
    const c = oracleCase(ORACLE_CONFIGS[0], 1);
    const e = readElf(c.elf);
    expect([e.magic, e.cls, e.machine, e.entry]).toEqual([0x464c457f, 1, 243, STUB]);
    expect(e.syms).toEqual({ tohost: TOHOST, fromhost: FROMHOST });
    const code = e.segs.find((s) => s.vaddr === CODE)!;
    const word = (i: number) => new DataView(code.bytes.buffer, code.bytes.byteOffset).getUint32(4 * i, true);
    expect(Array.from({ length: c.halt / 4 }, (_, i) => word(i))).toEqual(c.words.slice(0, c.halt / 4));
    expect(word(c.halt / 4)).not.toBe(c.words[c.halt / 4]); // the halt jumps to the exit stub
    const stub = e.segs.find((s) => s.vaddr === STUB)!;
    expect(STUB + stub.bytes.length).toBeGreaterThanOrEqual(FROMHOST + 8);
    expect(EXIT).toBeLessThan(TOHOST);
  });

  it('parses commits, traps and their tval in Spike\'s formats', () => {
    const ev = parseSpikeLog([
      'core   0: 0x00001000 (0x00000297) auipc   t0, 0x0',
      'core   0: 3 0x00001000 (0x00000297) x5  0x00001000',
      'core   0: 3 0x00010010 (0x0005a503) x10 0xdeadbeef mem 0x00020040',
      'core   0: 3 0x00010014 (0x00a58023) mem 0x00020041 0xef',
      'core   0: 3 0x00010018 (0x00b57053) f0  0x7fc00000 c1_fflags 0x00000010',
      'core   0: 3 0x0001001c (0x34011073) c832_mscratch 0x00000005',
      'core   0: exception trap_illegal_instruction, epc 0x00010020',
      'core   0:           tval 0xffffffff',
      'core   0: exception trap_machine_ecall, epc 0x00010024',
    ].join('\n'));
    expect(ev.map((e) => e.kind)).toEqual(['commit', 'commit', 'commit', 'commit', 'commit', 'trap', 'trap']);
    const [boot, ld, sb, fadd, csr, ill, ecall] = ev;
    expect(boot.kind === 'commit' && [boot.pc, boot.word, boot.priv, boot.x.get(5)]).toEqual([0x1000, 0x297, 3, 0x1000]);
    expect(ld.kind === 'commit' && [ld.x.get(10), ld.loads, ld.stores]).toEqual([0xdeadbeef, [0x20040], []]);
    expect(sb.kind === 'commit' && sb.stores).toEqual([{ addr: 0x20041, value: 0xef, bits: 8 }]);
    expect(fadd.kind === 'commit' && [fadd.f.get(0), fadd.csr.get(1)]).toEqual([0x7fc00000, 0x10]);
    expect(csr.kind === 'commit' && csr.csr.get(0x340)).toBe(5);
    expect(ill).toMatchObject({ kind: 'trap', name: 'trap_illegal_instruction', epc: 0x10020, tval: 0xffffffff });
    expect(ecall).toMatchObject({ kind: 'trap', name: 'trap_machine_ecall', epc: 0x10024 });
    expect(ecall.kind === 'trap' && ecall.tval).toBeUndefined();
  });

  it('keeps every load and store in the data window', () => {
    for (const cfg of ORACLE_CONFIGS) {
      for (let seed = 1; seed <= 20; seed++) {
        const c = oracleCase(cfg, seed);
        const iss = oracleIss(c);
        iss.memTrace = [];
        while (iss.pc !== CODE + c.halt && iss.steps < 20_000) iss.step();
        const out = iss.memTrace.filter((m) => m.addr < DATA || m.addr >= DATA + 4 * DMEM_WORDS);
        expect(out, `${cfg.id} seed ${seed}`).toEqual([]);
      }
    }
  });

  it('agrees with a Spike-format log of our own ISS', () => {
    for (const cfg of ORACLE_CONFIGS) {
      for (let seed = 1; seed <= 25; seed++) {
        const c = oracleCase(cfg, seed);
        const r = compareWithSpike(c, parseSpikeLog(issAsSpikeLog(c)));
        expect(r.diff, `${cfg.id} seed ${seed}`).toBe('');
        expect(r.steps).toBeGreaterThan(100);
      }
    }
  });

  it('reports a changed register value, a store, a missing trap and a different mtval', () => {
    const sys = ORACLE_CONFIGS.find((c) => c.id === 'sys')!;
    const c = oracleCase(sys, 3);
    const lines = issAsSpikeLog(c).split('\n');
    const at = (re: RegExp) => lines.findIndex((l, i) => i > 2 && re.test(l));
    const edit = (i: number, f: (l: string) => string) => compareWithSpike(c, parseSpikeLog(lines.map((l, k) => (k === i ? f(l) : l)).join('\n'))).diff;

    expect(edit(at(/^core\s+0: 3 .* x\d+\s+0x/), (l) => l.replace(/(x\d+\s+0x)([0-9a-f])/, (_m, p, d) => p + (d === '0' ? '1' : '0')))).toMatch(/x\d+: ours 0x[0-9a-f]+, Spike/);
    expect(edit(at(/ mem 0x[0-9a-f]+ 0x/), (l) => l.replace(/ mem (0x[0-9a-f]+) /, ' mem 0x00020ffc '))).toMatch(/store: ours/);
    const trap = at(/exception/);
    expect(trap).toBeGreaterThan(0);
    expect(edit(trap, () => '')).toMatch(/ours traps/);
    const tval = at(/tval/);
    expect(edit(tval, (l) => l.replace(/tval 0x[0-9a-f]+/, 'tval 0x00000004'))).toMatch(/mtval/);
  });
});
