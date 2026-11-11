// Chapter 'threads': the explainers. Every number is a run of the threads kernel (riscv/osprograms.ts kernelSource({ threads: true })) on the
// golden model (riscv/osrun.ts); tests/threads-kernel.test.ts holds the model to the gates, tests/content-threads.test.ts pins what the chapter quotes.

import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { groupDigits } from '../sim/numfmt';
import { osImage, spinner2 } from '../riscv/osprograms';
import { runOs, tripsOf, type OsRun } from '../riscv/osrun';
import { counting, twoLocks, waiting } from '../riscv/threadprograms';
import { MultiISS } from '../riscv/multi';
import { MC_PROGRAMS } from '../riscv/mcprograms';
import { assemble } from '../riscv/asm';
import { numOf } from '../chapters/order';
import '../styles/os.css';

/** The slices the chapter sweeps: from 100 up, well above sliceTax(), the part of a slice the kernel spends. */
export const THREAD_SLICES = [100, 200, 400, 800, 1600];
/** Increments per thread in the race. */
export const RACE_N = 100;
/** Instructions B holds the lock for while A wants it (spin against sleep). */
export const HOLD = 2000;
/** Rounds of the two-lock program. */
export const ROUNDS = 10;

const MAX = 400000;
export const runThreads = (src: string, slice: number, max = MAX): OsRun => runOs(osImage([src], { threads: true, slice }), max);
/** The number A printed ("A 123"), or null when it printed none. */
export const printed = (r: OsRun): number | null => { const m = /A (-?\d+)\n/.exec(r.output); return m ? Number(m[1]) : null; };

/**
 * What a slice costs before the thread gets any of it: the kernel re-arms the timer early in a switch and mtime counts its instructions too,
 * so the rest of the switch (registers loaded, mret) is spent from the new slice. A lone spinning thread at slice 200 runs 200 minus this many
 * instructions per slice; a slice no longer than it never reaches user code (the timer is due again at mret).
 */
export function sliceTax(): number {
  const r = runOs(osImage([spinner2], { threads: true, slice: 200 }), 20000);
  return 200 - Math.max(...tripsOf(r, 'timer').map((t) => t.userSteps));
}

export interface RaceRow { slice: number; count: number; cycles: number }
let race: RaceRow[] | undefined, locked: RaceRow[] | undefined;
export const raceRows = (): RaceRow[] => (race ??= THREAD_SLICES.map((s) => { const r = runThreads(counting(RACE_N), s); return { slice: s, count: printed(r)!, cycles: r.cycles }; }));
export const lockedRows = (): RaceRow[] => (locked ??= THREAD_SLICES.map((s) => { const r = runThreads(counting(RACE_N, { lock: true }), s); return { slice: s, count: printed(r)!, cycles: r.cycles }; }));

const bar = (v: number, max: number) => h('span', { class: 'os-bar' }, h('i', { style: `width:${Math.min(100, Math.round((100 * v) / max))}%` }));

/** Step 2 (and 3): the final count at each slice, without a lock and with one. */
export function raceWidget(o: { withLock?: boolean } = {}): Widget {
  const rows = raceRows(), lrows = o.withLock ? lockedRows() : undefined;
  const want = 2 * RACE_N;
  const el = h('div', { class: 'widget vm-widget os-widget' },
    h('table', { class: 'data os-cost' },
      h('tr', null, ...['slice', 'count, no lock', ...(lrows ? ['count, with lock 0', 'cycles, no lock', 'cycles, with lock'] : ['lost updates'])].map((t) => h('th', null, t))),
      ...rows.map((r, i) => h('tr', null, h('td', null, `${r.slice} instr.`), h('td', null, bar(r.count, want), ` ${r.count}`),
        ...(lrows ? [h('td', null, bar(lrows[i].count, want), ` ${lrows[i].count}`), h('td', null, groupDigits(r.cycles)), h('td', null, groupDigits(lrows[i].cycles))]
          : [h('td', null, String(want - r.count))])))),
    h('p', { class: 'sub' }, `Two threads each add 1 to one shared word ${RACE_N} times; the right answer is ${want}. Each row is a run of the threads kernel on the golden model with that time slice.`));
  return { el };
}

export interface WaitRow { slice: number; spinTries: number; spinCycles: number; sleepCycles: number }
let waits: WaitRow[] | undefined;
export const waitRows = (): WaitRow[] => (waits ??= THREAD_SLICES.map((s) => {
  const sp = runThreads(waiting(HOLD, 'spin'), s), sl = runThreads(waiting(HOLD, 'sleep'), s);
  return { slice: s, spinTries: printed(sp)!, spinCycles: sp.cycles, sleepCycles: sl.cycles };
}));

/** Step 4 / 5: A wants the lock B holds for HOLD instructions: asking in a loop against sleeping in the kernel. */
export function waitWidget(): Widget {
  const rows = waitRows();
  const el = h('div', { class: 'widget vm-widget os-widget' },
    h('table', { class: 'data os-cost' },
      h('tr', null, ...['slice', 'spinning: tries', 'spinning: cycles', 'sleeping: cycles', 'spinning wastes'].map((t) => h('th', null, t))),
      ...rows.map((r) => h('tr', null, h('td', null, `${r.slice} instr.`), h('td', null, String(r.spinTries)), h('td', null, groupDigits(r.spinCycles)), h('td', null, groupDigits(r.sleepCycles)),
        h('td', null, bar(r.spinCycles - r.sleepCycles, r.spinCycles), ` ${Math.round((100 * (r.spinCycles - r.sleepCycles)) / r.spinCycles)} %`)))),
    h('p', { class: 'sub' }, `Thread B takes lock 0 and works for about ${groupDigits(HOLD)} instructions; thread A then wants the lock. Spinning: A calls trylock in a loop until it answers 1. Sleeping: A calls lock once and is parked. Cycles until both threads are done, on the golden model.`));
  return { el };
}

// ---- step 8: the deadlock, and its one-line fix ------------------------------------------------------------------------------------

export interface DeadRow { slice: number; done: boolean; out: string }
export const deadRows = (order: [number, number]): DeadRow[] => THREAD_SLICES.map((s) => {
  const r = runThreads(twoLocks(ROUNDS, order), s);
  return { slice: s, done: printed(r) === ROUNDS, out: r.output.trim().split('\n')[0] };
});
let fixed = false;
/** The deadlock challenge: B's lock order runs to the end at every slice the chapter sweeps. */
export const deadlockFixed = (): boolean => fixed;
let setOrder: ((o: [number, number]) => void) | null = null;
/** Do it for me: B takes lock 0 first, as A does. */
export const fixDeadlock = (): void => setOrder?.([0, 1]);

export function deadlockWidget(): Widget {
  let order: [number, number] = [1, 0];
  const pick = (i: 0 | 1) => {
    const s = h('select', { 'aria-label': `the lock in B's ${i ? 'second' : 'first'} lock call` }, ...[0, 1].map((k) => h('option', { value: String(k) }, String(k)))) as HTMLSelectElement;
    s.value = String(order[i]);
    s.addEventListener('change', () => { order = i === 0 ? [Number(s.value), order[1]] : [order[0], Number(s.value)]; draw(); });
    return s;
  };
  const sel = [pick(0), pick(1)];
  const code = (who: 'A' | 'B') => h('pre', { class: 'os-code' },
    `thread ${who}, ${ROUNDS} times:\n`,
    who === 'A' ? '  lock(0)\n  ...30 instructions...\n  lock(1)\n  unlock(1)\n  unlock(0)' : h('span', null, '  lock(', sel[0], ')\n  ...30 instructions...\n  lock(', sel[1], ')\n  unlock(second)\n  unlock(first)'));
  const result = h('div', null);
  const draw = () => {
    sel[0].value = String(order[0]); sel[1].value = String(order[1]);
    if (order[0] === order[1]) { fixed = false; result.replaceChildren(h('p', { class: 'sub' }, `B would take lock ${order[0]} twice: it waits for itself, and the kernel says deadlock at once. B needs both locks.`)); return; }
    const rows = deadRows(order);
    fixed = rows.every((r) => r.done);
    result.replaceChildren(h('table', { class: 'data os-cost' },
      h('tr', null, h('th', null, 'slice'), h('th', null, 'what the console says')),
      ...rows.map((r) => h('tr', { class: r.done ? '' : 'bad' }, h('td', null, `${r.slice} instr.`), h('td', null, r.done ? `${r.out}: both finished` : r.out)))),
      h('p', { class: 'sub', role: 'status' }, fixed ? `Every slice finishes: no cycle of waiting can form.` : `${rows.filter((r) => !r.done).length} of ${rows.length} runs stop in a deadlock.`));
  };
  setOrder = (o) => { order = o; draw(); };
  draw();
  const el = h('div', { class: 'widget vm-widget os-widget' }, h('div', { class: 'os-maps' }, code('A'), code('B')), result);
  return { el, destroy: () => { setOrder = null; } };
}

// ---- chapter 'multicore', last step: the threads chapter's locks against an amoswap.w spin lock ------------------------------------

export interface LockCost {
  /** Cycles of the dual-core programs on the golden model (MultiISS): the racy count and the spin-locked one, on one core and on two. */
  race1: number; lock1: number; lock2: number; perCore: number;
  /** What the lock adds per increment: the spin lock alone on a core, and the threads kernel's lock and unlock (two system calls). */
  spinAdds: number; kernelAdds: number;
  /** Increments each core makes in the dual-core programs. */
  each: number;
}
let lockCost: LockCost | undefined;
export function lockCosts(): LockCost {
  if (lockCost) return lockCost;
  const run = (id: string, n: number) => {
    const m = new MultiISS(assemble(MC_PROGRAMS.find((p) => p.id === id)!.source).words, n);
    for (let k = 0; !m.halted && k < 100000; k++) m.step();
    return { cycles: m.cycles, count: m.dmem[16] };
  };
  const race1 = run('race', 1), lock1 = run('lock', 1), lock2 = run('lock', 2);
  const plain = raceRows()[THREAD_SLICES.length - 1].cycles, locked = lockedRows()[THREAD_SLICES.length - 1].cycles;
  return (lockCost = {
    race1: race1.cycles, lock1: lock1.cycles, lock2: lock2.cycles, perCore: lock1.count,
    spinAdds: Math.round((10 * (lock1.cycles - race1.cycles)) / lock1.count) / 10, kernelAdds: Math.round((locked - plain) / (2 * RACE_N)), each: lock1.count,
  });
}

export function lockCostWidget(): Widget {
  const c = lockCosts();
  const row = (what: string, adds: number, how: string) => h('tr', null, h('td', null, what), h('td', null, bar(adds, c.kernelAdds), ` ${adds}`), h('td', null, how));
  const el = h('div', { class: 'widget vm-widget os-widget' },
    h('table', { class: 'data os-cost' },
      h('tr', null, ...['lock', 'cycles it adds per increment', 'how it is made indivisible'].map((t) => h('th', null, t))),
      row('amoswap.w spin lock, one core', c.spinAdds, 'one arbitrated memory access swaps and returns the old value'),
      row(`threads kernel's lock(0) / unlock(0)`, c.kernelAdds, 'two system calls; the kernel runs with interrupts off')),
    h('p', { class: 'sub' }, `The spin lock: this chapter's lock program alone on one core (${c.lock1} cycles for ${c.each} increments) against the racy count (${c.race1}). On two cores, contended, ${c.lock2} cycles for ${2 * c.each}. The kernel's lock: chapter ${numOf('threads')}'s count of ${2 * RACE_N} increments with and without lock 0 at a ${groupDigits(THREAD_SLICES[THREAD_SLICES.length - 1])}-instruction slice. All on the golden models.`));
  return { el };
}
