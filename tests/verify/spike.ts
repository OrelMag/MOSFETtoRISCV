// Spike as a second oracle for our golden model (docs/VERIFICATION.md). Our ISS and our CPUs share one author,
// so a misreading of the specification passes in both; Spike, the RISC-V reference simulator, does not share it.
// A random program (src/riscv/randprog32.ts) is linked for Spike as an ELF (code at CODE, data at DATA, its final
// jump-to-self turned into a jump to an exit stub that writes tohost), run with a commit log, and the log is
// compared with our ISS instruction by instruction: pc and word, the register written and its value, f
// registers, stores (address and data), load addresses, CSR writes, and traps (cause, epc, tval).
//
// Spike runs von Neumann, our ISS Harvard with wrapping memories; the program sees the same machine because the
// code and the data window sit at multiples of their memories' sizes. Allowed differences (both readings legal):
// on an illegal instruction Spike puts the instruction in mtval and on ebreak the pc, ours 0; the comparison then
// takes Spike's value so that a later csrr mtval agrees. And Spike's mret writes zero to tcontrol, which ours does not
// have (UNMODELLED: reading it traps in ours, so no program sees the difference); any other value fails.

import { assemble } from '../../src/riscv/asm';
import { CSRS, decode, OPCODES } from '../../src/riscv/isa';
import { CAUSE, ISS, type StepInfo } from '../../src/riscv/iss';
import { randomProgram32, type Rand32Options } from '../../src/riscv/randprog32';
import { wordBytes, writeElf32 } from './elf';

/** Where the program sits; the boot stub (the ELF entry) and the exit stub; HTIF's mailboxes; the data window. */
export const CODE = 0x10000, STUB = 0x1f000, EXIT = 0x1f100, TOHOST = 0x1f800, FROMHOST = 0x1f840, DATA = 0x20000;
export const DMEM_WORDS = 32;
/** Spike's memory: one region for code and stubs, one for the data. */
export const SPIKE_MEM = `0x${CODE.toString(16)}:0x10000,0x${DATA.toString(16)}:0x1000`;

export interface OracleConfig {
  id: string;
  name: string;
  isa: Pick<Rand32Options, 'sub' | 'm' | 'f' | 'system'>;
  /** Spike's --isa. */
  spike: string;
}

/** The ISA variants our CPUs implement (tests/verify/cpus.ts), and every user-level extension at once. */
export const ORACLE_CONFIGS: OracleConfig[] = [
  { id: 'i', name: 'RV32I', isa: {}, spike: 'rv32i_zicsr' },
  { id: 'im', name: 'RV32IM', isa: { m: true }, spike: 'rv32im_zicsr' },
  { id: 'if', name: 'RV32IF', isa: { f: true }, spike: 'rv32if_zicsr' },
  { id: 'user', name: 'RV32IMF, byte and halfword access', isa: { sub: true, m: true, f: true }, spike: 'rv32imf_zicsr' },
  { id: 'sys', name: 'RV32I + Zicsr, machine mode, traps', isa: { sub: true, system: true }, spike: 'rv32i_zicsr' },
  { id: 'sys-m', name: 'RV32IM + Zicsr, machine mode, traps', isa: { sub: true, system: true, m: true }, spike: 'rv32im_zicsr' },
];

/** Spike's command line for an ELF and a log file. */
export const spikeArgs = (cfg: OracleConfig, elf: string, log: string) =>
  [`--isa=${cfg.spike}`, '--priv=m', `-m${SPIKE_MEM}`, '-l', '--log-commits', `--log=${log}`, elf];

export interface OracleCase {
  cfg: OracleConfig;
  seed: number;
  source: string;
  /** The program as our ISS runs it (ending in its jump-to-self). */
  words: number[];
  /** Byte offset of the final jump-to-self. */
  halt: number;
  elf: Uint8Array;
}

const log2up = (n: number) => Math.ceil(Math.log2(Math.max(2, n)));
const hex = (v: number, d = 8) => `0x${(v >>> 0).toString(16).padStart(d, '0')}`;

function words(src: string): number[] {
  const a = assemble(src);
  if (a.errors.length) throw new Error(`stub: ${a.errors[0].message}`);
  return a.words;
}

/** jal x0 by a byte offset. */
function jal0(off: number): number {
  const i = off >>> 0;
  return (((i >>> 20) & 1) << 31 | ((i >>> 1) & 0x3ff) << 21 | ((i >>> 11) & 1) << 20 | ((i >>> 12) & 0xff) << 12 | OPCODES.JAL) >>> 0;
}

export function oracleCase(cfg: OracleConfig, seed: number, n = 120): OracleCase {
  const source = randomProgram32(seed, { n, ...cfg.isa, dmemWords: DMEM_WORDS, dataBase: DATA, timer: false });
  const asm = assemble(source);
  if (asm.errors.length) throw new Error(`seed ${seed}: line ${asm.errors[0].line}: ${asm.errors[0].message}`);
  const halt = asm.labels.get('halt')!;
  const code = asm.words.slice();
  code[halt / 4] = jal0(EXIT - (CODE + halt));
  // boot: the FPU on (mstatus.FS = dirty: Spike traps FP instructions while it is off), then the program
  const boot = words(`${cfg.isa.f ? 'li t0, 0x6000\ncsrs mstatus, t0\n' : ''}li t0, ${CODE}\njr t0\n`);
  const exit = words(`li t0, ${TOHOST}\nli t1, 1\nsw t1, 0(t0)\nloop: j loop\n`);
  const stub = new Array<number>((FROMHOST + 8 - STUB) / 4).fill(0);
  stub.splice(0, boot.length, ...boot);
  stub.splice((EXIT - STUB) / 4, exit.length, ...exit);
  const elf = writeElf32(STUB, [{ vaddr: CODE, bytes: wordBytes(code) }, { vaddr: STUB, bytes: wordBytes(stub) }], { tohost: TOHOST, fromhost: FROMHOST });
  return { cfg, seed, source, words: asm.words, halt, elf };
}

/** Our ISS for a case, at the program's first instruction. */
export function oracleIss(c: OracleCase): ISS {
  const iss = new ISS(c.words, { system: !!c.cfg.isa.system, m: !!c.cfg.isa.m, f: !!c.cfg.isa.f, dmemWords: DMEM_WORDS, imemWords: 2 ** log2up(c.words.length) });
  iss.pc = CODE;
  return iss;
}

// ---- Spike's log (riscv/execute.cc commit_log_print_insn, processor.cc take_trap) ----

export interface SpikeCommit {
  kind: 'commit';
  line: number;
  priv: number;
  pc: number;
  word: number;
  x: Map<number, number>;
  f: Map<number, number>;
  csr: Map<number, number>;
  loads: number[];
  stores: { addr: number; value: number; bits: number }[];
}
export interface SpikeTrap { kind: 'trap'; line: number; name: string; epc: number; tval?: number }
export type SpikeEvent = SpikeCommit | SpikeTrap;

const TRAPS: Record<string, number> = {
  trap_instruction_address_misaligned: 0, trap_instruction_access_fault: 1, trap_illegal_instruction: 2, trap_breakpoint: 3,
  trap_load_address_misaligned: 4, trap_load_access_fault: 5, trap_store_address_misaligned: 6, trap_store_access_fault: 7,
  trap_user_ecall: 8, trap_supervisor_ecall: 9, trap_machine_ecall: 11,
};

const num = (h: string) => Number(BigInt(`0x${h.replace(/^0x/, '')}`) & 0xffffffffn);

/**
 * The commits and traps of a Spike log written with -l --log-commits. Commit lines are
 * `core   0: 3 0x00010000 (0x00000297) x5  0x00010000 mem 0x00020040 0x12`; traps
 * `core   0: exception trap_illegal_instruction, epc 0x00010024` and an optional `core   0:           tval 0x…`.
 * Instruction trace lines (`core   0: 0x… (0x…) addi …`) are skipped.
 */
export function parseSpikeLog(text: string): SpikeEvent[] {
  const out: SpikeEvent[] = [];
  const lines = text.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    const s = lines[ln].trimEnd();
    let m = /^core\s+\d+:\s+(\d)\s+0x([0-9a-f]+)\s+\(0x([0-9a-f]+)\)(.*)$/.exec(s);
    if (m) {
      const ev: SpikeCommit = { kind: 'commit', line: ln + 1, priv: +m[1], pc: num(m[2]), word: num(m[3]), x: new Map(), f: new Map(), csr: new Map(), loads: [], stores: [] };
      const t = m[4].trim().split(/\s+/).filter(Boolean);
      for (let i = 0; i < t.length; i++) {
        let r: RegExpExecArray | null;
        if (t[i] === 'mem') {
          const addr = num(t[++i]);
          if (t[i + 1]?.startsWith('0x')) { const v = t[++i]; ev.stores.push({ addr, value: num(v), bits: 4 * (v.length - 2) }); } else ev.loads.push(addr);
        } else if ((r = /^x(\d+)$/.exec(t[i]))) ev.x.set(+r[1], num(t[++i]));
        else if ((r = /^f(\d+)$/.exec(t[i]))) ev.f.set(+r[1], num(t[++i]));
        else if ((r = /^c(\d+)_\w+$/.exec(t[i]))) ev.csr.set(+r[1], num(t[++i]));
      }
      out.push(ev);
      continue;
    }
    m = /^core\s+\d+:\s+exception\s+([^,]+),\s+epc\s+0x([0-9a-f]+)/.exec(s);
    if (m) { out.push({ kind: 'trap', line: ln + 1, name: m[1].trim(), epc: num(m[2]) }); continue; }
    m = /^core\s+\d+:\s+tval\s+0x([0-9a-f]+)/.exec(s);
    if (m) { const last = out[out.length - 1]; if (last?.kind === 'trap') last.tval = num(m[1]); }
  }
  return out;
}

// ---- the comparison ----

export interface OracleResult {
  seed: number;
  cfg: string;
  ok: boolean;
  /** Instructions (and traps) compared. */
  steps: number;
  /** The first difference, '' when none. */
  diff: string;
  /** Allowed differences taken (mtval conventions, zero written to an UNMODELLED CSR). */
  allowances: number;
}

const CAUSE_NAMES: Record<number, string> = Object.fromEntries(Object.entries(TRAPS).map(([k, v]) => [v, k.replace(/^trap_/, '')]));
const STORE_BITS = [8, 16, 32];
/** CSRs Spike has and ours does not, which Spike's mret writes (with zero here). mstatush was one until Spike
 * showed it missing; ours now has it, read-only zero. */
export const UNMODELLED: Record<number, string> = {
  0x7a5: 'tcontrol (Sdtrig debug triggers)',
};
/** What Spike's mret writes besides the pc: mstatush (MPV cleared) and tcontrol (MTE ← MPTE). */
const MRET_WRITES = [0x310, 0x7a5];

/** The address a load reads, from the registers before it executes (undefined for anything else). */
function loadAddr(iss: ISS, word: number): number | undefined {
  const d = decode(word);
  const isLoad = d.opcode === OPCODES.LOAD || d.name === 'flw';
  return isLoad ? (iss.x[d.rs1] + d.imm) >>> 0 : undefined;
}

/** Our ISS against a Spike log of the same case, instruction by instruction, up to the program's halt. */
export function compareWithSpike(c: OracleCase, events: SpikeEvent[], limit = 20_000): OracleResult {
  const end = CODE + 4 * c.words.length, haltPc = CODE + c.halt;
  const inProgram = (pc: number) => pc >= CODE && pc < end;
  const evs = events.filter((e) => inProgram(e.kind === 'commit' ? e.pc : e.epc));
  const iss = oracleIss(c);
  const sys = !!c.cfg.isa.system;
  let i = 0, steps = 0, allowances = 0;
  const res = (diff: string): OracleResult => ({ seed: c.seed, cfg: c.cfg.id, ok: !diff, steps, diff, allowances });
  const where = (info: StepInfo, ev?: SpikeEvent) => `step ${steps}, ${hex(info.pc)} ${info.text}${ev ? ` (Spike log line ${ev.line})` : ''}`;
  while (iss.pc !== haltPc) {
    if (steps >= limit) return res(`our ISS did not reach the halt in ${limit} steps`);
    const ev = evs[i++];
    const la = loadAddr(iss, iss.fetch(iss.pc));
    const info = iss.step();
    steps++;
    if (!ev) return res(`${where(info)}: Spike's log ends here (it went elsewhere or stopped)`);
    if (info.trap) {
      const cause = info.trap.cause;
      if (ev.kind !== 'trap') return res(`${where(info, ev)}: ours traps (${CAUSE_NAMES[cause] ?? cause}), Spike commits ${hex(ev.pc)} (${hex(ev.word)})`);
      if (ev.epc !== info.pc || TRAPS[ev.name] !== cause) return res(`${where(info, ev)}: ours traps ${CAUSE_NAMES[cause] ?? cause} at ${hex(info.pc)}, Spike ${ev.name} at ${hex(ev.epc)}`);
      const theirs = ev.tval ?? 0;
      if (theirs !== iss.mtval) {
        const alt = cause === CAUSE.ILLEGAL ? info.word : cause === CAUSE.BREAKPOINT ? info.pc : undefined;
        if (iss.mtval === 0 && alt !== undefined && theirs === alt >>> 0) { iss.mtval = theirs; allowances++; }
        else return res(`${where(info, ev)}: mtval ${hex(iss.mtval)}, Spike ${hex(theirs)}`);
      }
      continue;
    }
    if (ev.kind === 'trap') return res(`${where(info, ev)}: Spike traps (${ev.name}${ev.tval !== undefined ? `, tval ${hex(ev.tval)}` : ''}), ours does not`);
    if (ev.pc !== info.pc || ev.word !== info.word) return res(`${where(info, ev)}: Spike commits ${hex(ev.pc)} (${hex(ev.word)})`);
    if (ev.priv !== 3) return res(`${where(info, ev)}: Spike in privilege ${ev.priv}, not machine mode`);
    const out: string[] = [];
    // integer register (x0 is never logged)
    const ours = new Map(info.rd ? [[info.rd, info.value! >>> 0]] : []);
    for (const [r, v] of ev.x) if (ours.get(r) !== v) out.push(`x${r}: ours ${ours.has(r) ? hex(ours.get(r)!) : 'not written'}, Spike ${hex(v)}`);
    for (const [r, v] of ours) if (!ev.x.has(r)) out.push(`x${r}: ours ${hex(v)}, Spike not written`);
    // f register
    if (info.fwrite && ev.f.get(info.fwrite.rd) !== info.fwrite.value >>> 0) out.push(`f${info.fwrite.rd}: ours ${hex(info.fwrite.value)}, Spike ${ev.f.has(info.fwrite.rd) ? hex(ev.f.get(info.fwrite.rd)!) : 'not written'}`);
    for (const [r, v] of ev.f) if (info.fwrite?.rd !== r) out.push(`f${r}: ours not written, Spike ${hex(v)}`);
    // memory
    if (info.store) {
      const bits = STORE_BITS[decode(info.word).funct3 & 3] ?? 32, mask = bits === 32 ? 0xffffffff : 2 ** bits - 1;
      const s = ev.stores[0];
      if (!s || ev.stores.length > 1 || s.addr !== info.store.addr >>> 0 || s.bits !== bits || ((s.value & mask) >>> 0) !== ((info.store.value & mask) >>> 0))
        out.push(`store: ours ${bits / 8} bytes ${hex(info.store.value & mask, bits / 4)} at ${hex(info.store.addr)}, Spike ${ev.stores.map((t) => `${t.bits / 8} bytes ${hex(t.value, t.bits / 4)} at ${hex(t.addr)}`).join(', ') || 'none'}`);
    } else if (ev.stores.length) out.push(`store: ours none, Spike at ${hex(ev.stores[0].addr)}`);
    if (la !== undefined && (ev.loads.length !== 1 || ev.loads[0] !== la)) out.push(`load address: ours ${hex(la)}, Spike ${ev.loads.map((a) => hex(a)).join(', ') || 'none'}`);
    // CSRs Spike wrote: ours must read the same (outside machine mode only the FP ones exist in ours)
    for (const [a, v] of ev.csr) {
      if (!sys && !(a >= 1 && a <= 3)) continue;
      const o = iss.csrRead(a);
      if (o === null && v === 0 && UNMODELLED[a]) allowances++;
      else if (o === null) out.push(`CSR 0x${a.toString(16)}: ours has none, Spike wrote ${hex(v)}`);
      else if (o >>> 0 !== v) out.push(`CSR 0x${a.toString(16)}: ours ${hex(o)}, Spike ${hex(v)}`);
    }
    if (out.length) return res(`${where(info, ev)}: ${out.join('; ')}`);
  }
  const next = evs[i];
  if (!next || next.kind !== 'commit' || next.pc !== haltPc) return res(`at the halt: Spike's next event is ${next ? (next.kind === 'commit' ? `a commit at ${hex(next.pc)}` : `a trap at ${hex(next.epc)}`) : 'missing'}`);
  return res('');
}

/**
 * A log in Spike's format written from our own ISS (the boot ROM's lines first, Spike's mtval conventions on
 * traps): the comparison's self-test, run by npm test where there is no Spike.
 */
export function issAsSpikeLog(c: OracleCase): string {
  const iss = oracleIss(c);
  const L = ['core   0: 0x00001000 (0x00000297) auipc   t0, 0x0', 'core   0: 3 0x00001000 (0x00000297) x5  0x00001000'];
  const reg = (p: string, r: number, v: number) => ` ${p}${String(r).padEnd(2)} ${hex(v)}`;
  for (let n = 0; iss.pc !== CODE + c.halt && n < 20_000; n++) {
    const la = loadAddr(iss, iss.fetch(iss.pc));
    const ff = iss.fflags, frm = iss.frm;
    const info = iss.step();
    L.push(`core   0: ${hex(info.pc)} (${hex(info.word)}) ${info.text}`);
    if (info.trap) {
      L.push(`core   0: exception trap_${CAUSE_NAMES[info.trap.cause]}, epc ${hex(info.pc)}`);
      const tval = info.trap.cause === CAUSE.ILLEGAL ? info.word : info.trap.cause === CAUSE.BREAKPOINT ? info.pc : iss.mtval;
      if (info.trap.cause !== CAUSE.ECALL) L.push(`core   0:           tval ${hex(tval)}`);
      if (info.trap.cause === CAUSE.ILLEGAL || info.trap.cause === CAUSE.BREAKPOINT) iss.mtval = tval;
      continue;
    }
    let s = `core   0: 3 ${hex(info.pc)} (${hex(info.word)})`;
    const d = decode(info.word);
    const csrs: [number, number][] = [];
    if (iss.fflags !== ff) csrs.push([1, iss.fflags]);
    if (iss.frm !== frm) csrs.push([2, iss.frm]);
    if (d.opcode === OPCODES.SYSTEM && d.funct3 & 3 && c.cfg.isa.system) {
      const a = (info.word >>> 20) & 0xfff, writes = (d.funct3 & 3) === 1 || d.rs1 !== 0;
      if (writes && iss.csrRead(a) !== null && a !== CSRS.misa) csrs.push([a, iss.csrRead(a)!]);
    }
    if (d.name === 'mret') for (const a of MRET_WRITES) csrs.push([a, 0]);
    // Spike's map order: x registers, f registers, CSRs by number
    if (info.rd) s += reg('x', info.rd, info.value!);
    if (info.fwrite) s += reg('f', info.fwrite.rd, info.fwrite.value);
    for (const [a, v] of csrs.sort((p, q) => p[0] - q[0])) s += ` c${a}_csr ${hex(v)}`;
    if (la !== undefined) s += ` mem ${hex(la)}`;
    if (info.store) { const bits = STORE_BITS[d.funct3 & 3] ?? 32; s += ` mem ${hex(info.store.addr)} ${hex(info.store.value & (bits === 32 ? -1 : 2 ** bits - 1), bits / 4)}`; }
    L.push(s);
  }
  // the halt's jump to the exit stub, and the stub
  L.push(`core   0: 3 ${hex(CODE + c.halt)} (${hex(jal0(EXIT - (CODE + c.halt)))})`);
  L.push(`core   0: 3 ${hex(EXIT)} (0x0001f2b7) x5  0x0001f000`);
  return `${L.join('\n')}\n`;
}

