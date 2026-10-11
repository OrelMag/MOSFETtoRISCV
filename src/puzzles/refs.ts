// The reference solutions: a program per puzzle for each ready-wired computer that can hold the data (the
// 4-bit CPU has no RAM, so the memory puzzles have no 4-bit reference), and what they measure (refdata.json,
// written by scripts/puzzles.ts --write and checked by tests/puzzles.test.ts). The measurements are the
// points a learner's score is graded against. No DOM.

import type { RefCpu } from './computers';
import refdata from './refdata.json';
import { REFS_4 } from './refs4';
import { REFS_16 } from './refs16';
import { REFS_32 } from './refs32';

export const REFS: Record<RefCpu, Record<string, string>> = { cpu4: REFS_4, rv16: REFS_16, rv32: REFS_32 };

/** The reference program for a puzzle on a computer, if there is one. */
export const refProgram = (cpu: RefCpu, puzzle: string): string | undefined => REFS[cpu][puzzle];

/** A reference's measurements: mean cycles over the tests, program words, NANDs of the computer (no ROM). */
export interface RefPoint { cpu: RefCpu; cycles: number; words: number; nands: number }

export type RefData = Record<string, RefPoint[]>;

export const REF_DATA = refdata as RefData;

/** The reference points of a puzzle (empty when none was measured). */
export const refPoints = (puzzle: string): RefPoint[] => REF_DATA[puzzle] ?? [];
