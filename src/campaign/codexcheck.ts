// Check yourself: two questions per codex entry, each wrong option saying why (Quiz.why), shown under the entry and
// recorded in settings.solved as codex:<id>:<k>. Written in codexcheck0–3.ts by entry; loaded with the fuller codex.
// No DOM.

import type { Quiz } from '../chapters/types';
import { CHECK0 } from './codexcheck0';
import { CHECK1 } from './codexcheck1';
import { CHECK2 } from './codexcheck2';
import { CHECK3 } from './codexcheck3';

export const CHECKS: Record<string, Quiz[]> = { ...CHECK0, ...CHECK1, ...CHECK2, ...CHECK3 };

export const checkOf = (id: string): Quiz[] => CHECKS[id] ?? [];
