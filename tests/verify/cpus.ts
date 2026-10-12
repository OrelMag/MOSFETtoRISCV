// Every RV32 CPU the chapters build, as the verification suites see it: how to build it around a
// program, which instructions it claims, and which riscv-tests environment it can run.

import {
  dualCore, multicycleCpu, pipelinedCpu, pipelinedFpCpu, singleCycleCpu, systemCpu,
} from '../../src/lib';
import type { IssOptions } from '../../src/riscv/iss';
import type { ComponentDef } from '../../src/sim/types';
import type { Env } from './images';

export interface Isa {
  /** Byte and halfword loads and stores (otherwise word access only). */
  sub?: boolean;
  m?: boolean;
  f?: boolean;
  /** Zicsr, machine-mode traps and interrupts. */
  system?: boolean;
  /** csrr mhartid, amoswap.w, amoadd.w (the multi-core). */
  mp?: boolean;
}

export interface CpuConfig {
  id: string;
  name: string;
  isa: Isa;
  env: Env;
  /** Smallest ROM / data memory (address bits) the generator accepts. */
  imemK?: number;
  dmemK?: number;
  /** The data memory size is fixed (main memory behind a cache). */
  fixedDmemK?: number;
  /** Cycles per instruction at worst (stalls, misses, divides), for the cycle budget. */
  cpi: number;
  build(words: number[], imemK: number, dmemK: number): ComponentDef;
}

export const CPUS: CpuConfig[] = [
  { id: 'sc', name: 'Single-cycle', isa: {}, env: 'bare', cpi: 1, build: (w, imemK, dmemK) => singleCycleCpu(w, { imemK, dmemK }) },
  { id: 'sc-ks', name: 'Single-cycle, fast adders', isa: {}, env: 'bare', cpi: 1, build: (w, imemK, dmemK) => singleCycleCpu(w, { imemK, dmemK, adder: 'ks' }) },
  { id: 'sc-dc', name: 'Single-cycle, write-through D-cache', isa: {}, env: 'bare', fixedDmemK: 6, cpi: 9, build: (w, imemK) => singleCycleCpu(w, { imemK, dmemK: 6, dcache: true, adder: 'ks' }) },
  { id: 'sc-wb2', name: 'Single-cycle, 2-way write-back D-cache', isa: {}, env: 'bare', fixedDmemK: 6, cpi: 13, build: (w, imemK) => singleCycleCpu(w, { imemK, dmemK: 6, dcache: 'wb2', adder: 'ks' }) },
  { id: 'sc-ic', name: 'Single-cycle, I-cache', isa: {}, env: 'bare', cpi: 9, build: (w, imemK, dmemK) => singleCycleCpu(w, { imemK, dmemK, icache: true, adder: 'ks' }) },
  { id: 'sc-wb-ic', name: 'Single-cycle, write-back D-cache + I-cache', isa: {}, env: 'bare', fixedDmemK: 6, cpi: 22, build: (w, imemK) => singleCycleCpu(w, { imemK, dmemK: 6, dcache: 'wb', icache: true }) },
  { id: 'sc-f', name: 'Single-cycle RV32IF', isa: { f: true }, env: 'bare', cpi: 30, build: (w, imemK, dmemK) => singleCycleCpu(w, { imemK, dmemK, fpu: true, adder: 'ks' }) },
  { id: 'mc-fsm', name: 'Multicycle, hardwired control', isa: {}, env: 'bare', cpi: 5, build: (w, imemK, dmemK) => multicycleCpu(w, { imemK, dmemK, control: 'fsm' }) },
  { id: 'mc-micro', name: 'Multicycle, microcode', isa: {}, env: 'bare', cpi: 5, build: (w, imemK, dmemK) => multicycleCpu(w, { imemK, dmemK, control: 'micro' }) },
  { id: 'pipe', name: 'Pipelined', isa: {}, env: 'bare', cpi: 3, build: (w, imemK, dmemK) => pipelinedCpu(w, { imemK, dmemK }) },
  { id: 'pipe-ks', name: 'Pipelined, fast adders', isa: {}, env: 'bare', cpi: 3, build: (w, imemK, dmemK) => pipelinedCpu(w, { imemK, dmemK, adder: 'ks' }) },
  { id: 'pipe-bal', name: 'Pipelined, balanced', isa: {}, env: 'bare', cpi: 3, build: (w, imemK, dmemK) => pipelinedCpu(w, { imemK, dmemK, adder: 'ks', balanced: true }) },
  { id: 'pipe-bp', name: 'Pipelined, branch predictor', isa: {}, env: 'bare', cpi: 3, build: (w, imemK, dmemK) => pipelinedCpu(w, { imemK, dmemK, predictor: true }) },
  { id: 'pipe-bal-bp', name: 'Pipelined, balanced + predictor', isa: {}, env: 'bare', cpi: 3, build: (w, imemK, dmemK) => pipelinedCpu(w, { imemK, dmemK, adder: 'ks', balanced: true, predictor: true }) },
  { id: 'pipe-wb2', name: 'Pipelined, 2-way write-back D-cache', isa: {}, env: 'bare', fixedDmemK: 6, cpi: 15, build: (w, imemK) => pipelinedCpu(w, { imemK, adder: 'ks', dcache: 'wb2' }) },
  { id: 'pipe-wt-bal-bp', name: 'Pipelined, write-through D-cache, balanced + predictor', isa: {}, env: 'bare', fixedDmemK: 6, cpi: 11, build: (w, imemK) => pipelinedCpu(w, { imemK, adder: 'ks', dcache: 'wt', predictor: true, balanced: true }) },
  { id: 'pipe-m', name: 'Pipelined RV32IM', isa: { m: true }, env: 'bare', cpi: 21, build: (w, imemK, dmemK) => pipelinedCpu(w, { imemK, dmemK, adder: 'ks', m: true }) },
  { id: 'pipe-m-bal-bp', name: 'Pipelined RV32IM, balanced + predictor', isa: { m: true }, env: 'bare', cpi: 21, build: (w, imemK, dmemK) => pipelinedCpu(w, { imemK, dmemK, adder: 'ks', balanced: true, predictor: true, m: true }) },
  { id: 'fppipe', name: 'Pipelined RV32IF (six stages)', isa: { f: true }, env: 'bare', cpi: 30, build: (w, imemK, dmemK) => pipelinedFpCpu(w, { imemK, dmemK }) },
  { id: 'sys', name: 'System (Zicsr, traps, I/O)', isa: { sub: true, system: true }, env: 'p', imemK: 7, cpi: 1, build: (w, imemK, dmemK) => systemCpu(w, { imemK, dmemK }) },
  { id: 'sys-m', name: 'System RV32IM', isa: { sub: true, system: true, m: true }, env: 'p', imemK: 7, cpi: 34, build: (w, imemK, dmemK) => systemCpu(w, { imemK, dmemK, m: true }) },
  { id: 'dual', name: 'Dual-core (hart 0)', isa: { mp: true }, env: 'bare-mp', cpi: 2, build: (w, imemK, dmemK) => dualCore(w, dmemK, false, imemK) },
];

/** Tests that need byte / halfword access. ld_st and st_ld pass on a word-only CPU too (every value they store is
 * sign-extended, so a word access reads it back unchanged), which proves nothing: they count as byte / halfword tests. */
const SUBWORD = new Set(['lb', 'lbu', 'lh', 'lhu', 'sb', 'sh', 'ld_st', 'st_ld']);
const MP_AMO = new Set(['amoadd_w', 'amoswap_w']);
/** Optional features of the privileged spec our system CPU leaves out. */
const MI_OPTIONAL: Record<string, string> = {
  breakpoint: 'no debug triggers (Sdtrig)',
  pmpaddr: 'no physical memory protection (PMP)',
  zicntr: 'no instret counter (Zicntr: cycle only)',
  instret_overflow: 'no minstret counter',
};

/** Why test `name` (suite-test) does not apply to `cfg`, or undefined when it must pass. */
export function notApplicable(cfg: Pick<CpuConfig, 'isa' | 'fixedDmemK'>, name: string, dataWords = 0): string | undefined {
  const i = name.indexOf('-'), suite = name.slice(0, i), t = name.slice(i + 1), isa = cfg.isa;
  if (t === 'fence_i') return 'self-modifying code: the instruction memory is a ROM';
  if (t === 'ma_data') return 'misaligned loads and stores are not supported';
  if (suite === 'rv32ui' && SUBWORD.has(t) && !isa.sub) return 'word access only (no byte / halfword loads and stores)';
  if (suite === 'rv32um' && !isa.m) return 'no M extension';
  if (suite === 'rv32uf' && !isa.f) return 'no F extension';
  if (suite === 'rv32ua' && !(isa.mp && MP_AMO.has(t))) return isa.mp ? 'only amoswap.w and amoadd.w' : 'no atomics';
  if (suite === 'rv32mi' && !isa.system) return 'no CSRs or traps';
  if (suite === 'rv32mi' && MI_OPTIONAL[t]) return MI_OPTIONAL[t];
  if (cfg.fixedDmemK !== undefined && dataWords > 2 ** cfg.fixedDmemK) return `data does not fit the ${2 ** cfg.fixedDmemK}-word main memory`;
  return undefined;
}

/** The golden model configured like a CPU's ISA. */
export function issOptions(isa: Isa): IssOptions {
  return { system: !!isa.system, m: !!isa.m, f: !!isa.f };
}
