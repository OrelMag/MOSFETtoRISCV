// Every program of the core bench says what it exercises (CoreTest.what: the level strip's failure list, the capstone's Tests tab).
import { describe, expect, it } from 'vitest';
import { coreTests, mdTests, pipeTests, predictTests, sysTests } from '../src/campaign/coretests';

describe('CoreTest.what', () => {
  it('every program of every bench stage has a description', () => {
    const all = [...[1, 2, 3].flatMap((s) => coreTests(s as 1 | 2 | 3)), ...[0, 1, 2, 3].flatMap((s) => pipeTests(s as 0 | 1 | 2 | 3)),
      ...sysTests(true), ...sysTests(false), ...mdTests('mul'), ...mdTests('all'), ...predictTests()];
    expect(all.filter((t) => !t.what).map((t) => t.name)).toEqual([]);
  });
});
