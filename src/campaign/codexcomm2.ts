// The Communication extension's codex entries, gathered: four files by chapter group. No DOM, no library import.

import { ALIASES_A, CODEX_A, TAUGHT_A } from './codexcomm2a';
import { ALIASES_B, CODEX_B, TAUGHT_B } from './codexcomm2b';
import { ALIASES_C, CODEX_C, TAUGHT_C } from './codexcomm2c';
import { ALIASES_D, CODEX_D, TAUGHT_D } from './codexcomm2d';
import type { CodexEntry } from './codex';

export const CODEX_COMM2: CodexEntry[] = [...CODEX_A, ...CODEX_B, ...CODEX_C, ...CODEX_D];
export const TAUGHT_COMM2: Record<string, string> = { ...TAUGHT_A, ...TAUGHT_B, ...TAUGHT_C, ...TAUGHT_D };
export const ALIASES_COMM2: Record<string, string[]> = { ...ALIASES_A, ...ALIASES_B, ...ALIASES_C, ...ALIASES_D };
