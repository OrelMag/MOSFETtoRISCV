// The Python compiler's output for every existing program is byte for byte what it was before the `user` target.
import { describe, expect, it } from 'vitest';
import snapshot from './fixtures/py-asm-snapshot.json';
import { snapshotCases } from './pyasm-cases';

describe('compiler output unchanged by the user target', () => {
  it('every sample and fuzz seed generates the same assembly', () => {
    const now = snapshotCases();
    expect(Object.keys(now).length).toBe(Object.keys(snapshot).length);
    expect(Object.keys(now).length).toBeGreaterThan(300);
    const changed = Object.keys(snapshot).filter((k) => (snapshot as Record<string, string>)[k] !== now[k]);
    expect(changed).toEqual([]);
  });
});
