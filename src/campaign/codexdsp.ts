// The Signal processing level's codex entries, gathered: four files by chapter group. No DOM, no library import.

import { ALIASES_A, CODEX_A, TAUGHT_A } from './codexdspa';
import { ALIASES_B, CODEX_B, TAUGHT_B } from './codexdspb';
import { ALIASES_C, CODEX_C, TAUGHT_C } from './codexdspc';
import { ALIASES_D, CODEX_D, TAUGHT_D } from './codexdspd';
import type { CodexEntry } from './codex';

export const CODEX_DSP: CodexEntry[] = [...CODEX_A, ...CODEX_B, ...CODEX_C, ...CODEX_D];
export const TAUGHT_DSP: Record<string, string> = { ...TAUGHT_A, ...TAUGHT_B, ...TAUGHT_C, ...TAUGHT_D };
export const ALIASES_DSP: Record<string, string[]> = { ...ALIASES_A, ...ALIASES_B, ...ALIASES_C, ...ALIASES_D };

/**
 * Ids no level teaches yet: the codex test that wants every entry in a level skips them. Act 13's levels list their ids in
 * `codex`, and each id leaves this set when its level lands (tests/content-codexdsp.test.ts checks the set holds only
 * untaught ids).
 */
/** Ids Act 13's levels list in `codex` (nodesdsp.ts). */
const LISTED = new Set(['saturate', 'guardbits']);
export const DSP_AWAITING_LEVELS: ReadonlySet<string> = new Set(CODEX_DSP.map((e) => e.id).filter((id) => !LISTED.has(id)));
