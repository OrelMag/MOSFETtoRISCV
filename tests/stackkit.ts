// Runs the Python stack both ways, on the reference interpreter and compiled on the golden model, and returns the memory each left behind.

import { BusModel } from '../src/bus/model';
import { outputOf } from '../src/lang/compile';
import { runPy } from '../src/lang/interp';
import { DEFAULT_STACK } from '../src/comm/stack/all';
import { stackProgram, type StackModule } from '../src/comm/stack';
import { STACK_LAYOUT as L, STACK_RAM_K } from '../src/comm/stack/layout';
import { ISS } from '../src/riscv/iss';

export const hex = (s: string): number[] => s.replace(/[^0-9a-fA-F]/g, '').match(/../g)!.map((h) => parseInt(h, 16));

/** Python that puts a frame in receive buffer `slot` and hands the descriptor to the software (OWN clear, length n), as the NIC would have. */
export function inject(slot: number, frame: number[]): string {
  const b = L.rxBuf + slot * L.bufSize;
  const lines = frame.map((v, i) => `store8(${b + i}, ${v})`);
  lines.push(`store32(${L.rxRing + 8 * slot + 4}, ${frame.length})`);
  return lines.join('\n');
}

export interface Ran {
  /** Transmit descriptors' word 1 (OWN | length), and the first `len` bytes of each transmit buffer. */
  txWord: number[];
  tx(slot: number, n: number): number[];
  rxWord: number[];
  word(addr: number): number;
  /** What the program printed. */
  output: number[];
  steps: number;
  words: number;
}

const wordsOf = (get: (a: number) => number): Ran['word'] => (a) => get(a) >>> 0;

export function build(app: string, modules: readonly StackModule[] = DEFAULT_STACK) {
  return stackProgram(modules, app);
}

/** On the interpreter, with a sparse memory. */
export function viaInterpreter(app: string, modules: readonly StackModule[] = DEFAULT_STACK): Ran {
  const sb = build(app, modules);
  const res = runPy(sb.source, { maxSteps: 3_000_000 });
  if (res.error) throw new Error(`${res.error.message} (line ${res.error.line}: ${JSON.stringify(sb.where(res.error.line))})`);
  const m = res.memory;
  const byte = (a: number) => m.get(a >>> 0) ?? 0;
  const word = (a: number) => (byte(a) | (byte(a + 1) << 8) | (byte(a + 2) << 16) | (byte(a + 3) << 24)) >>> 0;
  return {
    txWord: Array.from({ length: 8 }, (_, i) => word(L.txRing + 8 * i + 4)), rxWord: Array.from({ length: 8 }, (_, i) => word(L.rxRing + 8 * i + 4)),
    tx: (slot, n) => Array.from({ length: n }, (_, i) => byte(L.txBuf + slot * L.bufSize + i)), word: wordsOf(word), output: res.output, steps: res.steps, words: 0,
  };
}

/** Compiled for the RV32I golden model with the memory on a bus (the RAM the computer has). */
export function viaIss(app: string, modules: readonly StackModule[] = DEFAULT_STACK): Ran {
  const sb = build(app, modules);
  if (sb.compiled.error) throw new Error(`${sb.compiled.error.message} (line ${sb.compiled.error.line}: ${JSON.stringify(sb.where(sb.compiled.error.line))})`);
  const words = sb.compiled.words;
  const imemK = Math.ceil(Math.log2(words.length + 1));
  const bus = new BusModel(STACK_RAM_K, [], 4096, {});
  const iss = new ISS(words, { system: true, imemWords: 2 ** imemK, bus });
  while (!iss.halted && iss.steps < 20_000_000) iss.step();
  if (!iss.halted) throw new Error('the program did not halt');
  const word = (a: number) => bus.ram[a >>> 2] >>> 0;
  const byte = (a: number) => (bus.ram[a >>> 2] >>> (8 * (a & 3))) & 255;
  return {
    txWord: Array.from({ length: 8 }, (_, i) => word(L.txRing + 8 * i + 4)), rxWord: Array.from({ length: 8 }, (_, i) => word(L.rxRing + 8 * i + 4)),
    tx: (slot, n) => Array.from({ length: n }, (_, i) => byte(L.txBuf + slot * L.bufSize + i)), word, output: outputOf(sb.compiled.layout!, iss.x[3], new Uint32Array(Array.from({ length: 2048 }, (_, i) => bus.ram[i]))), steps: iss.steps, words: words.length,
  };
}
