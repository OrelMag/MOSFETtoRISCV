// Spike as the oracle for the RV64 golden model (src/riscv/iss64.ts), the RV32 plumbing (spike.ts) at 64 bits: a
// random RV64I / M program (src/riscv/randprog64.ts) linked as an ELF64 at the same addresses (code at CODE, data
// window at DATA, boot and exit stubs, tohost), run by Spike with --isa=rv64im, and its commit log compared with
// ISS64 instruction by instruction: pc and word, the register written and its 64-bit value, the store (address,
// width, data), the load address. The programs are user level, so nothing traps and no CSR is written: a trap or a
// CSR write in Spike's log is a difference. Values are BigInt throughout (spike.ts truncates to 32 bits).

import { assemble } from '../../src/riscv/asm';
import { decode, OPCODES } from '../../src/riscv/isa';
import { ISS64, type StepInfo64 } from '../../src/riscv/iss64';
import { randomProgram64 } from '../../src/riscv/randprog64';
import { wordBytes, writeElf64 } from './elf';
import { CODE, DATA, EXIT, FROMHOST, SPIKE_MEM, STUB, TOHOST, type OracleResult } from './spike';

/** The data window's size in 32-bit words (32 doublewords). */
export const DMEM_WORDS64 = 64;

export interface OracleConfig64 {
  id: string;
  name: string;
  m: boolean;
  /** Spike's --isa. */
  spike: string;
}

/** Chapter 25's 64-bit core: RV64IM, every access width. */
export const ORACLE_CONFIGS64: OracleConfig64[] = [
  { id: 'rv64im', name: 'RV64IM, byte to doubleword access', m: true, spike: 'rv64im_zicsr' },
];

export const spikeArgs64 = (cfg: OracleConfig64, elf: string, log: string) =>
  [`--isa=${cfg.spike}`, '--priv=m', `-m${SPIKE_MEM}`, '-l', '--log-commits', `--log=${log}`, elf];

export interface OracleCase64 {
  cfg: OracleConfig64;
  seed: number;
  source: string;
  words: number[];
  /** Byte offset of the final jump-to-self. */
  halt: number;
  elf: Uint8Array;
}

const hex = (v: bigint | number, d = 16) => `0x${BigInt.asUintN(d * 4, BigInt(v)).toString(16).padStart(d, '0')}`;
const asm64 = (src: string, what: string): ReturnType<typeof assemble> => {
  const a = assemble(src, undefined, { xlen: 64 });
  if (a.errors.length) throw new Error(`${what}: line ${a.errors[0].line}: ${a.errors[0].message}`);
  return a;
};

/** jal x0 by a byte offset. */
function jal0(off: number): number {
  const i = off >>> 0;
  return (((i >>> 20) & 1) << 31 | ((i >>> 1) & 0x3ff) << 21 | ((i >>> 11) & 1) << 20 | ((i >>> 12) & 0xff) << 12 | OPCODES.JAL) >>> 0;
}

export function oracleCase64(cfg: OracleConfig64, seed: number, n = 120): OracleCase64 {
  const source = randomProgram64(seed, { n, m: cfg.m, dmemWords: DMEM_WORDS64, dataBase: DATA });
  const a = asm64(source, `seed ${seed}`);
  const halt = a.labels.get('halt')!;
  const code = a.words.slice();
  code[halt / 4] = jal0(EXIT - (CODE + halt));
  // the stubs' addresses are below 2^31, so li is lui / addiw as on RV32; sw writes tohost's low word (HTIF reads
  // the doubleword, whose high word stays 0)
  const boot = asm64(`li t0, ${CODE}\njr t0\n`, 'boot').words;
  const exit = asm64(`li t0, ${TOHOST}\nli t1, 1\nsw t1, 0(t0)\nloop: j loop\n`, 'exit').words;
  const stub = new Array<number>((FROMHOST + 8 - STUB) / 4).fill(0);
  stub.splice(0, boot.length, ...boot);
  stub.splice((EXIT - STUB) / 4, exit.length, ...exit);
  const elf = writeElf64(STUB, [{ vaddr: CODE, bytes: wordBytes(code) }, { vaddr: STUB, bytes: wordBytes(stub) }], { tohost: TOHOST, fromhost: FROMHOST });
  return { cfg, seed, source, words: a.words, halt, elf };
}

/** ISS64 for a case, at the program's first instruction. */
export function oracleIss64(c: OracleCase64): ISS64 {
  const iss = new ISS64(c.words, { m: c.cfg.m, dmemWords: DMEM_WORDS64, imemWords: 2 ** Math.ceil(Math.log2(Math.max(2, c.words.length))) });
  iss.pc = BigInt(CODE);
  return iss;
}

// ---- Spike's log at 64 bits ----

export interface SpikeCommit64 {
  kind: 'commit';
  line: number;
  priv: number;
  pc: bigint;
  word: number;
  x: Map<number, bigint>;
  /** f registers and CSRs Spike logged written (none expected here). */
  other: string[];
  loads: bigint[];
  stores: { addr: bigint; value: bigint; bits: number }[];
}
export interface SpikeTrap64 { kind: 'trap'; line: number; name: string; epc: bigint; tval?: bigint }
export type SpikeEvent64 = SpikeCommit64 | SpikeTrap64;

const big = (h: string) => BigInt(`0x${h.replace(/^0x/, '')}`);

/** Commits and traps of a log written by Spike with -l --log-commits for an RV64 hart (values 16 hex digits). */
export function parseSpikeLog64(text: string): SpikeEvent64[] {
  const out: SpikeEvent64[] = [];
  const lines = text.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    const s = lines[ln].trimEnd();
    let m = /^core\s+\d+:\s+(\d)\s+0x([0-9a-f]+)\s+\(0x([0-9a-f]+)\)(.*)$/.exec(s);
    if (m) {
      const ev: SpikeCommit64 = { kind: 'commit', line: ln + 1, priv: +m[1], pc: big(m[2]), word: Number(big(m[3])), x: new Map(), other: [], loads: [], stores: [] };
      const t = m[4].trim().split(/\s+/).filter(Boolean);
      for (let i = 0; i < t.length; i++) {
        let r: RegExpExecArray | null;
        if (t[i] === 'mem') {
          const addr = big(t[++i]);
          if (t[i + 1]?.startsWith('0x')) { const v = t[++i]; ev.stores.push({ addr, value: big(v), bits: 4 * (v.length - 2) }); } else ev.loads.push(addr);
        } else if ((r = /^x(\d+)$/.exec(t[i]))) ev.x.set(+r[1], big(t[++i]));
        else if (/^(f\d+|c\d+_\w+)$/.test(t[i])) { ev.other.push(`${t[i]} ${t[i + 1]}`); i++; }
      }
      out.push(ev);
      continue;
    }
    m = /^core\s+\d+:\s+exception\s+([^,]+),\s+epc\s+0x([0-9a-f]+)/.exec(s);
    if (m) { out.push({ kind: 'trap', line: ln + 1, name: m[1].trim(), epc: big(m[2]) }); continue; }
    m = /^core\s+\d+:\s+tval\s+0x([0-9a-f]+)/.exec(s);
    if (m) { const last = out[out.length - 1]; if (last?.kind === 'trap') last.tval = big(m[1]); }
  }
  return out;
}

/** The address a load reads, from the registers before it executes (undefined for anything else). */
function loadAddr(iss: ISS64, word: number): bigint | undefined {
  const d = decode(word, undefined, 64);
  return d.opcode === OPCODES.LOAD ? BigInt.asUintN(64, iss.x[d.rs1] + BigInt(d.imm)) : undefined;
}

/** ISS64 against a Spike log of the same case, instruction by instruction, up to the program's halt. */
export function compareWithSpike64(c: OracleCase64, events: SpikeEvent64[], limit = 20_000): OracleResult {
  const end = BigInt(CODE + 4 * c.words.length), haltPc = BigInt(CODE + c.halt);
  const inProgram = (pc: bigint) => pc >= BigInt(CODE) && pc < end;
  const evs = events.filter((e) => inProgram(e.kind === 'commit' ? e.pc : e.epc));
  const iss = oracleIss64(c);
  let i = 0, steps = 0;
  const res = (diff: string): OracleResult => ({ seed: c.seed, cfg: c.cfg.id, ok: !diff, steps, diff, allowances: 0 });
  const where = (info: StepInfo64, ev?: SpikeEvent64) => `step ${steps}, ${hex(info.pc)} ${info.text}${ev ? ` (Spike log line ${ev.line})` : ''}`;
  while (iss.pc !== haltPc) {
    if (steps >= limit) return res(`our ISS did not reach the halt in ${limit} steps`);
    const ev = evs[i++];
    const la = loadAddr(iss, iss.fetch(iss.pc));
    const info = iss.step();
    steps++;
    if (!ev) return res(`${where(info)}: Spike's log ends here (it went elsewhere or stopped)`);
    if (ev.kind === 'trap') return res(`${where(info, ev)}: Spike traps (${ev.name}${ev.tval !== undefined ? `, tval ${hex(ev.tval)}` : ''}), ours does not`);
    if (ev.pc !== info.pc || ev.word !== info.word) return res(`${where(info, ev)}: Spike commits ${hex(ev.pc)} (${hex(ev.word, 8)})`);
    if (ev.priv !== 3) return res(`${where(info, ev)}: Spike in privilege ${ev.priv}, not machine mode`);
    const out: string[] = [];
    const ours = new Map(info.rd ? [[info.rd, info.value!]] : []);
    for (const [r, v] of ev.x) if (ours.get(r) !== v) out.push(`x${r}: ours ${ours.has(r) ? hex(ours.get(r)!) : 'not written'}, Spike ${hex(v)}`);
    for (const [r, v] of ours) if (!ev.x.has(r)) out.push(`x${r}: ours ${hex(v)}, Spike not written`);
    if (info.store) {
      const bits = info.store.size * 8, s = ev.stores[0];
      if (!s || ev.stores.length > 1 || s.addr !== info.store.addr || s.bits !== bits || s.value !== info.store.value)
        out.push(`store: ours ${bits / 8} bytes ${hex(info.store.value, bits / 4)} at ${hex(info.store.addr)}, Spike ${ev.stores.map((t) => `${t.bits / 8} bytes ${hex(t.value, t.bits / 4)} at ${hex(t.addr)}`).join(', ') || 'none'}`);
    } else if (ev.stores.length) out.push(`store: ours none, Spike at ${hex(ev.stores[0].addr)}`);
    if (la !== undefined && (ev.loads.length !== 1 || ev.loads[0] !== la)) out.push(`load address: ours ${hex(la)}, Spike ${ev.loads.map((a) => hex(a)).join(', ') || 'none'}`);
    if (la === undefined && ev.loads.length) out.push(`load: ours none, Spike at ${hex(ev.loads[0])}`);
    if (ev.other.length) out.push(`Spike also wrote ${ev.other.join(', ')}`);
    if (out.length) return res(`${where(info, ev)}: ${out.join('; ')}`);
  }
  const next = evs[i];
  if (!next || next.kind !== 'commit' || next.pc !== haltPc) return res(`at the halt: Spike's next event is ${next ? (next.kind === 'commit' ? `a commit at ${hex(next.pc)}` : `a trap at ${hex(next.epc)}`) : 'missing'}`);
  return res('');
}

/** A log in Spike's RV64 format written from ISS64 (the boot ROM's lines first): the comparison's self-test. */
export function issAsSpikeLog64(c: OracleCase64): string {
  const iss = oracleIss64(c);
  const L = ['core   0: 0x0000000000001000 (0x00000297) auipc   t0, 0x0', 'core   0: 3 0x0000000000001000 (0x00000297) x5  0x0000000000001000'];
  for (let n = 0; iss.pc !== BigInt(CODE + c.halt) && n < 20_000; n++) {
    const la = loadAddr(iss, iss.fetch(iss.pc));
    const info = iss.step();
    L.push(`core   0: ${hex(info.pc)} (${hex(info.word, 8)}) ${info.text}`);
    let s = `core   0: 3 ${hex(info.pc)} (${hex(info.word, 8)})`;
    if (info.rd) s += ` x${String(info.rd).padEnd(2)} ${hex(info.value!)}`;
    if (la !== undefined) s += ` mem ${hex(la)}`;
    if (info.store) s += ` mem ${hex(info.store.addr)} ${hex(info.store.value, info.store.size * 2)}`;
    L.push(s);
  }
  L.push(`core   0: 3 ${hex(CODE + c.halt)} (${hex(jal0(EXIT - (CODE + c.halt)), 8)})`);
  L.push(`core   0: 3 ${hex(EXIT)} (0x0001f2b7) x5  ${hex(0x1f000)}`);
  return `${L.join('\n')}\n`;
}
