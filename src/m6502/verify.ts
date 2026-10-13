// Checking the transistor-level 6502 against the ISS: lock-step from reset (every bus cycle), and
// single instructions from a given state (SingleStepTests), the state set up by a loader program.

import { Chip6502 } from './chip';
import { Cpu6502, Ram64 } from './iss';

const hex = (v: number) => v.toString(16);

/** The chip's registers copied into a fresh ISS (power-on contents are arbitrary on silicon). */
function issLike(chip: Chip6502, ram: Ram64): Cpu6502 {
  const iss = new Cpu6502(ram);
  const r = chip.regs();
  Object.assign(iss, { pc: r.pc, s: r.s, a: r.a, x: r.x, y: r.y, p: r.p & 0xef });
  return iss;
}

export interface Lines { irq: boolean; nmi: boolean }

/**
 * Run `image` on the chip and the ISS from reset for `cycles`, comparing every bus cycle; `lines`
 * drives IRQ / NMI per cycle. Returns the first difference, or null.
 */
export function lockstep(chip: Chip6502, image: Uint8Array, cycles: number, lines?: (c: number) => Lines): string | null {
  const ra = new Ram64();
  ra.mem.set(image);
  (chip.bus as Ram64).mem.set(image);
  chip.irq = chip.nmi = false;
  chip.reset(2);
  const iss = issLike(chip, ra);
  iss.reset();
  for (let c = 0; c < cycles; c++) {
    const l = lines?.(c);
    if (l) { iss.irq = chip.irq = l.irq; iss.nmi = chip.nmi = l.nmi; }
    iss.tick(); chip.cycle();
    if (iss.busAddr !== chip.addr || iss.busData !== chip.data || iss.busWrite !== chip.write || iss.busSync !== chip.sync)
      return `cycle ${c}: iss ${hex(iss.busAddr)} ${hex(iss.busData)} ${iss.busWrite ? 'w' : 'r'} s${iss.busSync}, ` +
        `chip ${hex(chip.addr)} ${hex(chip.data)} ${chip.write ? 'w' : 'r'} s${chip.sync} (iss ir ${hex(iss.ir)})`;
  }
  return null;
}

/** A SingleStepTests case: [pc, s, a, x, y, p, ram as addr, value pairs] before and after, cycles as addr, data, write. */
export type StepState = [pc: number, s: number, a: number, x: number, y: number, p: number, ram: number[]];
export type StepCase = [initial: StepState, final: StepState, cycles: number[]];

/** A memory that serves a loader program until `switchAt` cycles, then the test's RAM. */
class LoaderBus {
  loader = new Uint8Array(65536);
  ram = new Ram64();
  loading = true;
  read(a: number): number { return this.loading ? this.loader[a] : this.ram.read(a); }
  write(a: number, v: number): void { if (this.loading) this.loader[a] = v; else this.ram.write(a, v); }
}

/** The loader: S, then P (pushed, pulled), A, X, Y, and a jump to the instruction. */
function loaderFor([pc, s, a, x, y, p]: StepState): number[] {
  return [0xa2, s, 0x9a, 0xa9, p, 0x48, 0xa9, a, 0xa2, x, 0xa0, y, 0x28, 0x4c, pc & 0xff, pc >> 8];
}
/** Cycles from the first fetch of the loader to the fetch of the instruction under test. */
const LOADER_CYCLES = 2 + 2 + 2 + 3 + 2 + 2 + 2 + 4 + 3;
const LOADER_AT = 0xf000;

export class StepRunner {
  readonly bus = new LoaderBus();
  readonly chip: Chip6502;
  constructor(chip?: Chip6502) {
    this.chip = chip ?? new Chip6502(this.bus);
  }

  /** One case; the first difference, or null. */
  run([init, fin, cycles]: StepCase): string | null {
    const { bus, chip } = this;
    bus.loading = true;
    bus.loader.fill(0);
    bus.loader.set(loaderFor(init), LOADER_AT);
    bus.loader[0xfffc] = LOADER_AT & 0xff; bus.loader[0xfffd] = LOADER_AT >> 8;
    for (let i = 0; i < init[6].length; i += 2) bus.ram.mem[init[6][i]] = init[6][i + 1];
    chip.irq = chip.nmi = false;
    chip.reset(2);
    for (let i = 0; i < 7 + LOADER_CYCLES; i++) chip.cycle();
    bus.loading = false;
    let err: string | null = null;
    const n = cycles.length / 3;
    for (let i = 0; i < n && !err; i++) {
      chip.cycle();
      const [addr, data, w] = [cycles[3 * i], cycles[3 * i + 1], cycles[3 * i + 2]];
      if (chip.addr !== addr || chip.data !== data || chip.write !== (w === 1))
        err = `cycle ${i}: got ${hex(chip.addr)} ${hex(chip.data)} ${chip.write ? 'w' : 'r'}, want ${hex(addr)} ${hex(data)} ${w ? 'w' : 'r'}`;
      else if (chip.sync !== (i === 0 ? 1 : 0)) err = `cycle ${i}: sync ${chip.sync}`;
    }
    if (!err) {
      chip.cycle();
      if (chip.sync !== 1) err = `no fetch after ${n} cycles`;
      else if (chip.addr !== fin[0]) err = `next fetch at ${hex(chip.addr)}, want pc ${hex(fin[0])}`;
      chip.cycle();
    }
    if (!err) {
      const r = chip.regs();
      const got = [r.s, r.a, r.x, r.y, r.p & 0xcf];
      const want = [fin[1], fin[2], fin[3], fin[4], fin[5] & 0xcf];
      const names = ['s', 'a', 'x', 'y', 'p'];
      for (let k = 0; k < 5 && !err; k++) if (got[k] !== want[k]) err = `${names[k]} = ${hex(got[k])}, want ${hex(want[k])}`;
      for (let i = 0; i < fin[6].length && !err; i += 2)
        if (bus.ram.mem[fin[6][i]] !== fin[6][i + 1]) err = `ram[${hex(fin[6][i])}] = ${bus.ram.mem[fin[6][i]]}, want ${fin[6][i + 1]}`;
    }
    bus.ram.mem.fill(0);
    return err;
  }
}
