// Memory test (DOM-free; docs/PLAN-VERIFY.md step 12): March tests and the memory faults they are designed to find.
//
// A memory is not tested like logic: its faults are about cells and the wires to them, and a test is a sequence of reads
// and writes walked through the addresses. March C− is six elements over n one-bit cells, 10n operations:
//   ⇕(w0)  ⇑(r0, w1)  ⇑(r1, w0)  ⇓(r0, w1)  ⇓(r1, w0)  ⇕(r0)
// It finds every stuck-at cell, transition fault, address-decoder fault and idempotent coupling fault (Van de Goor); the
// naive test (write 0s, read, write 1s, read) misses most coupling and decoder faults. tests/march.test.ts counts both.

export type MemFault =
  | { kind: 'stuck'; cell: number; v: 0 | 1 }
  /** The cell cannot make this transition (it stays at the old value). */
  | { kind: 'transition'; cell: number; rise: boolean }
  /** A write that changes the aggressor in this direction forces the victim to v. */
  | { kind: 'coupling'; aggressor: number; victim: number; rise: boolean; v: 0 | 1 }
  /** The decoder selects `also` too whenever `addr` is accessed (a write goes to both, a read sees their AND). */
  | { kind: 'decoder'; addr: number; also: number };

export const faultText = (f: MemFault): string => {
  switch (f.kind) {
    case 'stuck': return `cell ${f.cell} stuck at ${f.v}`;
    case 'transition': return `cell ${f.cell} cannot ${f.rise ? 'rise' : 'fall'}`;
    case 'coupling': return `cell ${f.aggressor} ${f.rise ? 'rising' : 'falling'} sets cell ${f.victim} to ${f.v}`;
    case 'decoder': return `address ${f.addr} also selects cell ${f.also}`;
  }
};

/** n one-bit cells with at most one fault, read and written as a test would. */
export class FaultyMemory {
  cells: Uint8Array;
  constructor(readonly n: number, readonly fault: MemFault | null = null) {
    this.cells = new Uint8Array(n);
    if (fault?.kind === 'stuck') this.cells[fault.cell] = fault.v;
  }
  private set(c: number, v: number): void {
    const f = this.fault, old = this.cells[c];
    if (f?.kind === 'stuck' && f.cell === c) return;
    if (f?.kind === 'transition' && f.cell === c && old !== v && (v === 1) === f.rise) return;
    this.cells[c] = v;
    if (f?.kind === 'coupling' && f.aggressor === c && old !== v && (v === 1) === f.rise && !(this.isStuck(f.victim))) this.cells[f.victim] = f.v;
  }
  private isStuck(c: number): boolean { return this.fault?.kind === 'stuck' && this.fault.cell === c; }
  write(a: number, v: number): void {
    this.set(a, v);
    if (this.fault?.kind === 'decoder' && this.fault.addr === a) this.set(this.fault.also, v);
  }
  read(a: number): number {
    const v = this.cells[a];
    return this.fault?.kind === 'decoder' && this.fault.addr === a ? v & this.cells[this.fault.also] : v;
  }
}

export interface MarchElement {
  /** 'up', 'down', or 'any' (either order works). */
  dir: 'up' | 'down' | 'any';
  /** Operations at each address in turn: r0 / r1 read and expect, w0 / w1 write. */
  ops: ('r0' | 'r1' | 'w0' | 'w1')[];
}

export const MARCH_C_MINUS: MarchElement[] = [
  { dir: 'any', ops: ['w0'] },
  { dir: 'up', ops: ['r0', 'w1'] },
  { dir: 'up', ops: ['r1', 'w0'] },
  { dir: 'down', ops: ['r0', 'w1'] },
  { dir: 'down', ops: ['r1', 'w0'] },
  { dir: 'any', ops: ['r0'] },
];

/** The naive test: all zeros written and read back, then all ones. */
export const ZEROS_ONES: MarchElement[] = [
  { dir: 'up', ops: ['w0'] }, { dir: 'up', ops: ['r0'] }, { dir: 'up', ops: ['w1'] }, { dir: 'up', ops: ['r1'] },
];

export const marchText = (t: readonly MarchElement[]): string =>
  t.map((e) => `${e.dir === 'up' ? '⇑' : e.dir === 'down' ? '⇓' : '⇕'}(${e.ops.join(', ')})`).join(' ');

export const marchOps = (t: readonly MarchElement[], n: number): number => t.reduce((s, e) => s + e.ops.length * n, 0);

export interface MarchRun {
  pass: boolean;
  /** The first read that saw the wrong value: element, address, expected. */
  first?: { element: number; addr: number; want: 0 | 1 };
  ops: number;
}

/** Run a March test on a memory. */
export function runMarch(t: readonly MarchElement[], mem: FaultyMemory): MarchRun {
  let ops = 0;
  for (const [i, e] of t.entries()) {
    for (let k = 0; k < mem.n; k++) {
      const a = e.dir === 'down' ? mem.n - 1 - k : k;
      for (const op of e.ops) {
        ops++;
        const v = op[1] === '1' ? 1 : 0;
        if (op[0] === 'w') mem.write(a, v);
        else if (mem.read(a) !== v) return { pass: false, first: { element: i, addr: a, want: v as 0 | 1 }, ops };
      }
    }
  }
  return { pass: true, ops };
}

/** Every single fault of the four kinds in an n-cell memory (couplings and decoder faults between every ordered pair). */
export function allMemFaults(n: number): MemFault[] {
  const out: MemFault[] = [];
  for (let c = 0; c < n; c++) {
    out.push({ kind: 'stuck', cell: c, v: 0 }, { kind: 'stuck', cell: c, v: 1 });
    out.push({ kind: 'transition', cell: c, rise: true }, { kind: 'transition', cell: c, rise: false });
  }
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
    if (a === b) continue;
    for (const rise of [true, false]) for (const v of [0, 1] as const) out.push({ kind: 'coupling', aggressor: a, victim: b, rise, v });
    out.push({ kind: 'decoder', addr: a, also: b });
  }
  return out;
}

/** Of these faults, how many of each kind a test finds. */
export function marchCoverage(t: readonly MarchElement[], n: number, faults = allMemFaults(n)): Record<MemFault['kind'], { found: number; total: number }> {
  const res = { stuck: { found: 0, total: 0 }, transition: { found: 0, total: 0 }, coupling: { found: 0, total: 0 }, decoder: { found: 0, total: 0 } };
  for (const f of faults) {
    res[f.kind].total++;
    if (!runMarch(t, new FaultyMemory(n, f)).pass) res[f.kind].found++;
  }
  return res;
}
