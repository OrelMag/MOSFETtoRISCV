// Chapter 'threads': every number the prose and the codex quote is measured (chapters/ch-threads.ts threadFigures), and here held to
// what it claims: the race is wrong at every slice the chapter sweeps, the lock right at all of them, the deadlock happens as written and
// never with the fix, the Python program races too. The kernel itself is checked against the gates in tests/threads-kernel.test.ts.
import { describe, expect, it } from 'vitest';
import { PY_N, pyRace, pyThreads, RING_N, SCENE_SLICE, threadFigures } from '../src/chapters/ch-threads';
import { chapters } from '../src/chapters';
import { CODEX } from '../src/campaign/codex';
import { moreOf } from '../src/campaign/codexmore';
import { runPy } from '../src/lang/interp';
import { printed, RACE_N, THREAD_SLICES } from '../src/widgets/threads';
import { osImage, spinner2 } from '../src/riscv/osprograms';
import { runOs, tripsOf } from '../src/riscv/osrun';
import { groupDigits } from '../src/sim/numfmt';

const F = threadFigures();
const n = (v: number) => groupDigits(v).replace(/[   ]/g, ' ');
const plain = (h: string) => h.replace(/<[^>]+>/g, '');
const body = (id: string) => plain(CODEX.find((e) => e.id === id)!.body);

describe('the chapter\'s claims', () => {
  it('the race loses updates at every slice, the lock loses none', () => {
    expect(F.race).toHaveLength(THREAD_SLICES.length);
    for (const c of F.race) expect(c).toBeLessThan(2 * RACE_N);
    expect(F.lockedCycles).toBeGreaterThan(F.plainCycles);
    expect(F.perIncrement).toBe(Math.round((F.lockedCycles - F.plainCycles) / (2 * RACE_N)));
  });

  it('a slice no longer than the tax runs no user instruction; one longer runs slice − tax', () => {
    const user = (s: number) => Math.max(...tripsOf(runOs(osImage([spinner2], { threads: true, slice: s }), 20000), 'timer').map((t) => t.userSteps));
    expect(user(F.tax)).toBe(0);
    expect(user(F.tax + 1)).toBe(1);
    expect(user(400)).toBe(400 - F.tax);
    expect(THREAD_SLICES[0]).toBeGreaterThan(F.tax);
  });

  it('a thread switch pays no walks after it, a process switch does; the kernel part is the same', () => {
    expect(F.threadSwitch).toBe(F.procSwitch);
    expect(F.threadWalks).toBe(0);
    expect(F.procWalks).toBeGreaterThan(0);
  });

  it('spinning costs more than sleeping at every slice', () => {
    for (const t of F.spinTries) expect(t).toBeGreaterThan(1);
    expect(F.spinWaste).toBeGreaterThan(10);
  });

  it('the ring adds 1 .. n without loss on conditions and on semaphores; the producer waits', () => {
    expect(F.ringSum).toBe((RING_N * (RING_N + 1)) / 2);
    expect(F.condWaits).toBeGreaterThan(0);
    expect(F.semCycles).toBeLessThan(F.condCycles);
  });

  it('the deadlock happens at every slice as written and never with the fix', () => {
    expect(F.deadAll).toBe(THREAD_SLICES.length);
    expect(F.fixedAll).toBe(THREAD_SLICES.length);
  });

  it('Python: the unlocked program races at most slices; the interpreter, with one thread, prints the right count', () => {
    expect(runPy(pyRace(false)).output).toEqual([2 * PY_N]);
    expect(runPy(pyRace(true)).output).toEqual([2 * PY_N]);
    expect(F.py.race.filter((v) => v < 2 * PY_N).length).toBeGreaterThanOrEqual(THREAD_SLICES.length - 1);
    for (const v of F.py.race) expect(v).toBeLessThanOrEqual(2 * PY_N);
    expect(F.py.locked).toBeGreaterThan(F.py.plain);
    // the locked program, compiled, on the kernel: right at every slice
    for (const s of THREAD_SLICES) expect(printed(runOs(osImage([pyThreads(true)], { threads: true, slice: s }), 2000000)), `slice ${s}`).toBe(2 * PY_N);
  });

  it('the scenes run at the chapter\'s slice, one of the panel\'s', () => {
    expect(THREAD_SLICES).toContain(SCENE_SLICE);
  });
});

describe('the codex quotes the chapter', () => {
  it('numbers in the entries are the figures', () => {
    expect(body('thread')).toContain(`${F.threadWalks} page walks after it where a process switch pays ${F.procWalks}`);
    expect(body('race')).toContain(`ended between ${F.raceLow} and ${F.raceHigh}, never at ${2 * RACE_N}`);
    expect(body('lock')).toContain(`about ${F.perIncrement} cycles more`);
    const more = (id: string) => plain(moreOf(id)!.example!.body);
    expect(more('thread')).toContain(`spawn: ${F.spawn} cycles`);
    expect(more('thread')).toContain(`${F.threadSwitch} kernel cycles, ${F.threadWalks} walks`);
    expect(more('thread')).toContain(`${F.procSwitch} kernel cycles, ${F.procWalks} walks`);
    expect(more('race').replace(/\s+/g, ' ')).toContain(`final count ${F.race.join(' ')}`);
    expect(more('race')).toContain(`${F.py.race.slice(0, -1).join(', ')} and ${F.py.race[F.py.race.length - 1]}`);
    expect(more('critsec')).toContain(`${n(F.plainCycles)} cycles`);
    expect(more('critsec')).toContain(`${n(F.lockedCycles)} cycles, count ${2 * RACE_N}`);
    expect(more('critsec')).toContain(`about ${F.perIncrement} cycles per increment`);
    expect(more('lock').replace(/\s+/g, ' ')).toContain(`trylock tries ${F.spinTries.join(' ')}`);
    expect(more('lock')).toContain(`spinning wasted ${F.spinWaste} % of its cycles at a ${F.spinWasteAt}-instruction slice`);
    expect(more('condvar')).toContain(`sum ${F.ringSum}, the producer waited ${F.condWaits} times, ${n(F.condCycles)} cycles`);
    expect(more('semaphore')).toContain(`sum ${F.ringSum} in ${n(F.semCycles)} cycles, against ${n(F.condCycles)}`);
    expect(more('deadlock')).toContain(`deadlock at ${F.deadAll} of ${THREAD_SLICES.length}`);
    expect(more('deadlock')).toContain(`finished at ${F.fixedAll} of ${THREAD_SLICES.length}`);
  });

  it('every link names a step by its title', () => {
    const ch = chapters.find((c) => c.id === 'threads')!;
    for (const id of ['thread', 'race', 'critsec', 'lock', 'condvar', 'semaphore', 'deadlock']) {
      for (const l of moreOf(id)!.chapters ?? []) expect(ch.steps[l.step!].title, id).toBe(l.label);
    }
  });
});

describe('Many cores, last step: the kernel lock against an amoswap.w spin lock', () => {
  it('the spin lock adds a few cycles per increment, the kernel lock the chapter\'s figure; both count right', async () => {
    const { lockCosts } = await import('../src/widgets/threads');
    const c = lockCosts();
    expect(c.kernelAdds).toBe(F.perIncrement);
    expect(c.spinAdds).toBeGreaterThan(0);
    expect(c.spinAdds).toBeLessThan(10);
    expect(c.kernelAdds / c.spinAdds).toBeGreaterThan(20);
    expect(c.lock2).toBeGreaterThan(c.lock1);
  });
});
