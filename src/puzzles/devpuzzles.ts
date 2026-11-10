// Device puzzles (the Puzzles drawer's Devices group): a device part on a chip of its own, and a circuit (or a CPU) that
// drives it. Check plays every test on the chip's own gates (the sandbox's simulation, its cycle engine), from power-on:
// the device holds the test's world, the clock runs until the world is done, breaks a rule or reaches the test's step
// limit. A circuit is graded on NANDs against the reference circuit (devrefs.ts): ★ every test passes, ★★ within 1.5 × its
// NANDs, ★★★ at or below them. A CPU (the device paced by en: devcpu.ts's computer, or a chip of the learner's own with a
// program ROM) is graded like the stream puzzles, on cycles × NANDs against the reference program on the RV32I computer,
// and keeps its best under a record of its own (cpuRecordId), so a small circuit never hides a CPU's score. No DOM.

import type { Compiled } from '../editor/compile';
import type { ChipDoc, PinDoc } from '../editor/model';
import type { ChipLookup } from '../editor/chipfaults';
import { deviceLeaves, deviceState, type DeviceState } from '../editor/devparts';
import { EditorSim } from '../editor/runtime';
import { DEVICE_TESTS, DEVICES, type DeviceId, type DeviceTest } from './devices';
import { referenceDef } from './devrefs';
import { DEVICE_CPU_REFS } from './devcpu';
import { puzzleStars, type PuzzleScore, type Stars } from './grade';
import { hardwareNands } from './run';

export interface DevicePuzzle {
  id: string;
  dev: DeviceId;
  title: string;
  /** One line for the list. */
  short: string;
  /** The task (HTML). */
  brief: string;
  /** The idea of the reference, in words (Show answer). */
  idea: string;
}

export const DEVICE_PUZZLES: DevicePuzzle[] = [
  {
    id: 'crossing', dev: 'crossing', title: 'Crossing', short: 'lamps and a button',
    brief: 'Drive the lamps of a pedestrian crossing. The device holds <code>req</code> at 1 from a press until <code>walk</code> lights. '
      + '<b>Rules, every step:</b> exactly one car lamp; <code>walk</code> only on red, and only after a press; yellow for at least 2 steps between green and red, '
      + 'then red (never back to green); <code>walk</code> for at least 4 steps; a press served within 12 steps; cars get green for at least 6 steps between two walks.',
    idea: 'A state machine with four states (cars go, yellow, walk, all red) and a 3-bit step counter, cleared at each change of state. '
      + 'Cars go until a press waits and green has lasted 6 steps; yellow 2 steps; walk 4; one step of all red; cars go again.',
  },
  {
    id: 'maze', dev: 'maze', title: 'Maze runner', short: 'walls in, motors out',
    brief: 'Steer the robot to the goal. Each step it reads <code>wall_f</code>, <code>wall_l</code>, <code>wall_r</code> and <code>goal</code>, and takes one command: '
      + '<code>fwd</code>, <code>left</code> or <code>right</code> (none: it waits). Driving into a wall or two commands at once is a fault. Every test maze can be '
      + 'solved by keeping a hand on one wall, within its step limit.',
    idea: 'The left-hand rule: turn left where the left is open, else go forward where the way is open, else turn right. '
      + 'One flip-flop, “just turned left”: right after a left turn always go forward, or the robot would turn round toward where it came from and go round for ever.',
  },
  {
    id: 'vending', dev: 'vend', title: 'Vending machine', short: 'coins in, an item and change out',
    brief: 'An item costs 30¢. <code>coin</code> shows a coin dropping (1 = 5¢, 2 = 10¢, 3 = 25¢); <code>buy</code> and <code>refund</code> are the buttons. '
      + 'Drop an item (<code>vend</code>) within 4 steps of a buy with 30¢ or more paid, and only then; after a sale or a refund give the rest back one coin a step '
      + '(<code>chg</code>: 1 = 5¢, 2 = 10¢), all of it within 10 steps, and never more than is owed.',
    idea: 'A credit register in 5¢ units and one flip-flop, “paying out”. Each step credit becomes credit + the coin − 6 if it drops an item − the coin it gives back. '
      + 'It drops an item on buy when credit ≥ 6 and it is not paying out; it pays out after a sale with change left or a refund, 10¢ while 10¢ or more is left, then 5¢.',
  },
];

export const DEVICE_PUZZLE_BY_ID = new Map(DEVICE_PUZZLES.map((p) => [p.id, p]));
export const devicePuzzleChipId = (p: DevicePuzzle) => `u_pz_${p.id}`;
export const devicePuzzleOfChip = (chipId: string): DevicePuzzle | undefined =>
  chipId.startsWith('u_pz_') ? DEVICE_PUZZLE_BY_ID.get(chipId.slice(5)) : undefined;
export const deviceTests = (p: DevicePuzzle): DeviceTest[] => DEVICE_TESTS[p.dev];

export interface DeviceTestRun {
  name: string;
  ok: boolean;
  why?: string;
  /** World steps taken, and clock cycles run. */
  steps: number;
  cycles: number;
  /** The step of the fault (for the player's mark). */
  at?: number;
  /** Where the world ended (status line). */
  status: string;
}

/** `en`: the device is paced by en (a CPU): graded on cycles × NANDs against the reference program (devcpu.ts). */
export interface DeviceRun { ok: boolean; problems: string[]; results: DeviceTestRun[]; cycles: number; en: boolean }

/** A CPU (the device's `en` pin) gets this many clock cycles per world step at most before a test is declared stuck. */
export const CYCLES_PER_STEP = 400;

export interface DeviceFound { li: number; en: boolean }

/** The device of a simulation, or what is missing. */
export function findDevice(es: EditorSim, p: DevicePuzzle): DeviceFound | string[] {
  const sim = es.sim;
  if (!sim) return es.diags.length ? es.diags.map((d) => d.msg) : ['the circuit cannot be simulated'];
  const all = deviceLeaves(sim);
  const mine = all.filter((d) => d.dev === p.dev);
  const out: string[] = [];
  if (all.length > mine.length) out.push(`a device of another puzzle is placed: keep only the ${DEVICES[p.dev].title.toLowerCase()}`);
  if (mine.length !== 1) out.push(mine.length ? `${mine.length} ${DEVICES[p.dev].title.toLowerCase()} parts: keep one` : `no ${DEVICES[p.dev].title.toLowerCase()} part: start the puzzle again (Start over…) to get it back`);
  if (!es.hasClock) out.push('no clock pin: the world takes a step at each rising clock edge');
  if (out.length) return out;
  return { li: mine[0].li, en: mine[0].en };
}

/** Power on with test k's world in the device (the simulation's clock low). */
export function loadDeviceTest(es: EditorSim, found: DeviceFound, p: DevicePuzzle, k: number): void {
  es.reset('zero');
  es.pokeLeaf(found.li, deviceState(p.dev, k, es.sim?.leafState(found.li)));
}

/** Is the test over (a fault, done, or its step limit)? */
export function deviceOver(st: DeviceState, t: DeviceTest): boolean {
  return st.fault !== null || DEVICES[st.dev].done(st.w) || st.n >= t.steps;
}

/** The cycle budget of a test: one per step for a circuit, CYCLES_PER_STEP for a CPU pacing the world with en. */
export const cycleLimit = (t: DeviceTest, en: boolean) => (en ? t.steps * CYCLES_PER_STEP : t.steps);

/** Judge the device's state after a test ran `cycles` cycles. */
export function judgeDevice(st: DeviceState, t: DeviceTest, cycles: number): DeviceTestRun {
  const m = DEVICES[st.dev];
  const base = { name: t.name, steps: st.n, cycles, status: m.status(st.w) };
  if (st.fault) return { ...base, ok: false, why: `step ${st.n - 1}: ${st.fault}`, at: st.n - 1 };
  if (m.done(st.w)) return { ...base, ok: true };
  if (st.n < t.steps) return { ...base, ok: false, why: `the world took only ${st.n} of ${t.steps} steps in ${cycles} cycles: does en pulse once a step?`, at: st.n };
  const why = m.end(st.w);
  return why ? { ...base, ok: false, why, at: st.n } : { ...base, ok: true };
}

/** Play test k on a simulation already holding the circuit: from power-on until the test is over. */
export function playDeviceTest(es: EditorSim, found: DeviceFound, p: DevicePuzzle, k: number): DeviceTestRun {
  const t = deviceTests(p)[k];
  loadDeviceTest(es, found, p, k);
  const st = () => es.sim!.leafState(found.li) as DeviceState;
  const n = es.runCycles(cycleLimit(t, found.en), () => deviceOver(st(), t));
  return judgeDevice(st(), t, n);
}

/** Run every test of `p` on a compiled chip, on a fresh simulation of its own (the editor's is never touched). */
export function runDevicePuzzle(p: DevicePuzzle, compiled: Compiled, pins: PinDoc[], faults?: { doc: ChipDoc; look: ChipLookup; deps: string[] }): DeviceRun {
  const es = new EditorSim({ debounceMs: 0 });
  try {
    es.setMode('cycle');
    es.update({ ...compiled, def: compiled.def }, pins, faults?.doc, faults && { look: faults.look, deps: faults.deps });
    const found = findDevice(es, p);
    if (Array.isArray(found)) return { ok: false, problems: found, results: [], cycles: 0, en: false };
    const results = deviceTests(p).map((_, k) => playDeviceTest(es, found, p, k));
    const cycles = Math.round((10 * results.reduce((s, r) => s + r.cycles, 0)) / Math.max(1, results.length)) / 10;
    return { ok: results.every((r) => r.ok), problems: [], results, cycles, en: found.en };
  } finally {
    es.destroy();
  }
}

// ---- grading ----------------------------------------------------------------------------------------------------------

export type DeviceStars = 1 | 2 | 3;

/** The reference circuit's NANDs (the par). */
export const parNands = (dev: DeviceId): number => hardwareNands(referenceDef(dev));

/** ★ every test passes; ★★ within 1.5 × the reference's NANDs; ★★★ at or below them. */
export function deviceStars(nands: number, par: number): DeviceStars {
  return nands <= par ? 3 : nands <= 1.5 * par ? 2 : 1;
}

/** The record a CPU's pass is kept under (the circuit's is the puzzle's own id). */
export const cpuRecordId = (p: DevicePuzzle): string => `${p.id}:cpu`;

/** A CPU's grade: the stream puzzles' rule against the reference program on the RV32I computer. */
export const deviceCpuStars = (p: DevicePuzzle, s: PuzzleScore): Stars => puzzleStars(s, [DEVICE_CPU_REFS[p.dev]]);
