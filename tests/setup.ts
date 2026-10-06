// Vitest's worker reads its RPC messages only when Node's event loop reaches the poll phase, and
// between tests the runner awaits nothing but microtasks. A file of long synchronous tests (the
// gate-level CPU co-simulations) therefore behaves like one block; on a slow CI runner an
// "onTaskUpdate" reply then waits more than 60 s and the run fails with "Timeout calling
// onTaskUpdate" although every test passed. setImmediate runs after the poll phase, so this
// yield lets the replies through after every test.
import { afterEach } from 'vitest';

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

/** For long loops inside a test: await this now and then (every few seconds of work). */
export const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));
