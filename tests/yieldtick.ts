// Long tests give their worker back now and then. Vitest's workers report progress over an RPC with a 60 s timeout;
// a test that keeps its worker busy longer (a CPU simulated for thousands of cycles, a large sandbox round trip, on
// CI's slower runner) makes that call time out, and the run fails although every test passed.

/** A macrotask: the worker answers pending RPCs. */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Run a generator to its end, a macrotask between its steps; its return value. */
export async function stepped<T>(g: Generator<unknown, T>): Promise<T> {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    await tick();
  }
}

