// The whole book's prose, read once, a chapter at a time with the worker given back between them. Many steps compute their figures the first
// time their body is read (the radio chapter alone takes seconds), so a test that reads every body in one synchronous loop can pass vitest's
// timeout on a busy CI runner, which then fails the run though nothing is wrong. Tests that read every chapter warm the book first, in a
// beforeAll with a timeout of its own: the measured figures are memoized, so what follows is quick.

import { chapters } from '../src/chapters';
import { tick } from './yieldtick';

/** Generous: about 10 s on a quiet machine, several times that on a loaded runner. */
export const WARM_TIMEOUT = 240_000;
/** For a test that still walks every chapter after the warm-up. */
export const BOOK_TIMEOUT = 120_000;

let warm: Promise<void> | null = null;
/** Reads every step's body, once per worker. */
export function warmBook(): Promise<void> {
  warm ??= (async () => {
    for (const c of chapters) {
      for (const s of c.steps) void s.body;
      await tick();
    }
  })();
  return warm;
}
