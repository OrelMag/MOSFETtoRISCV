// Check yourself: two questions per codex entry, each wrong option saying why (Quiz.why), shown under the entry and
// recorded in settings.solved as codex:<id>:<k>. Written in codexcheck0–3.ts by entry; loaded with the fuller codex.
// No DOM.

import type { Quiz } from '../chapters/types';
import { CHECK0 } from './codexcheck0';
import { CHECK1 } from './codexcheck1';
import { CHECK2 } from './codexcheck2';
import { CHECK3 } from './codexcheck3';
import { CHECK4 } from './codexcheck4';
import { CHECK5 } from './codexcheck5';
import { CHECK6 } from './codexcheck6';
import { CHECK7 } from './codexcheck7';
import { CHECK8 } from './codexcheck8';
import { CHECK9 } from './codexcheck9';
import { CHECK10A } from './codexcheck10a';
import { CHECK10B } from './codexcheck10b';
import { CHECK10C } from './codexcheck10c';
import { CHECK10D } from './codexcheck10d';

export const CHECKS: Record<string, Quiz[]> = { ...CHECK0, ...CHECK1, ...CHECK2, ...CHECK3, ...CHECK4, ...CHECK5, ...CHECK6, ...CHECK7, ...CHECK8, ...CHECK9, ...CHECK10A, ...CHECK10B, ...CHECK10C, ...CHECK10D };

export const checkOf = (id: string): Quiz[] => CHECKS[id] ?? [];
