// The 4 x 4 DRAM array of chapter dram on a SwitchSim of its own (DOM-free), driven by the same protocol as the chapter's
// panel (widgets/dram.ts dramScene): precharge, activate, sense, close, refresh, and Wait = SwitchSim.leak. It settles
// only when an operation is called, never per frame. Every charge the 3D model draws is read back with `level`.

import { BITLINE_C, CELL_C, CELL_HALFLIFE, DRAM4X4 } from '../lib/dram';
import { flatten } from '../sim/flatten';
import { SENSE_OFFSET, SwitchSim } from '../sim/switchsim';
import { probes } from './dram';

/** The words the model starts with (bit c = column c, index = row): a mix of 1s and 0s in every row. */
export const PATTERN = [0b1010, 0b0110, 0b1111, 0b0001];

/** The chapter's bit line against its cell: 100 fF over 25 fF. */
export const RATIO = BITLINE_C / CELL_C;
/** Bit-line to cell capacitance ratios the learner can pick. Real arrays run about 10 (Keeth, Baker, Johnson, Lin, DRAM
 *  Circuit Design, 2nd ed., ch. 2: hundreds of cells on a digit line). */
export const RATIOS = [4, 8, 16, 32, 64] as const;
/** The swing a full 1 or 0 puts on its bit line, as a fraction of VDD: (V − VDD/2) Cs / (Cs + Cb). */
export const swingOf = (ratio: number): number => 0.5 / (1 + ratio);
/** Cycles a stored 1 is still read as 1 at this ratio (widgets/dram.ts SAFE_CYCLES at the chapter's own); 0: never, a
 *  fresh 1's swing is already under the amplifier's offset. */
export function safeCyclesOf(ratio: number): number {
  const need = 0.5 + SENSE_OFFSET * (1 + ratio);
  return need >= 1 ? 0 : Math.floor(CELL_HALFLIFE * Math.log2(1 / need));
}

export interface DramSnap {
  /** Per row and column: the cell's level as a fraction of VDD (NaN: unknown). */
  cell: number[][];
  /** Per column: the bit line's level, the reference line's (no cells on it: the amplifier's other input), and
   *  bl - blb (what the amplifier compares). */
  bl: number[];
  blb: number[];
  dv: number[];
  /** Bit-line to cell capacitance ratio of this bench. */
  ratio: number;
  /** The row whose word line is up, or -1. */
  open: number;
  sensed: boolean;
  precharged: boolean;
  /** Cycles since each row was last restored. */
  age: number[];
}

export class DramBench {
  readonly sim = new SwitchSim(flatten(DRAM4X4, { mode: 'switch' }));
  readonly p = probes(this.sim, DRAM4X4);
  readonly age: number[] = new Array<number>(this.p.rows).fill(0);
  /** What the last operation did, in a sentence ('' when nothing to say). */
  note = '';

  /** `ratio`: the bit lines' capacitance over a cell's. The chapter's array has 4; another ratio scales this bench's own
   *  bit lines (both of each pair, so the reference still matches), the circuit and its simulation otherwise unchanged. */
  constructor(readonly ratio: number = RATIO) {
    if (ratio !== RATIO) {
      const w = this.sim.design.capWeight!;
      for (const n of [...this.p.bl, ...this.p.blb]) w.set(n, CELL_C * ratio);
    }
    this.drive({ row: 0, act: 0, pre: 1, sae: 0, col: 0, cs: 0, we: 0, din: 0 });
  }

  private drive(o: Record<string, number>): void {
    for (const [k, v] of Object.entries(o)) this.sim.setInput(k, v);
    this.sim.settle();
  }
  private inp(k: string): number { return this.sim.getInput(k); }
  /** A row the amplifiers hold at full level is as good as just restored. */
  private restored(): void { if (this.inp('act') === 1 && this.inp('sae') === 1) this.age[this.inp('row')] = 0; }

  precharge(): void {
    this.note = '';
    this.drive({ cs: 0, we: 0 }); this.drive({ act: 0 }); this.drive({ sae: 0 }); this.drive({ pre: 1 });
  }
  activate(row: number): void {
    this.note = '';
    if (this.inp('act') === 1) { this.note = `Row ${this.inp('row')} is still open: close it first.`; return; }
    if (this.inp('pre') === 0) this.note = 'The bit lines were not precharged: they share what they held.';
    this.drive({ pre: 0 });
    this.drive({ row, act: 1 });
    this.restored();
  }
  sense(): void {
    this.note = this.inp('act') === 0 ? 'No row is open: the amplifiers latch whatever the bit lines hold.' : '';
    this.drive({ sae: 1 });
    this.restored();
  }
  /** Word line down first, then the amplifiers let go: the cells keep the restored charge. */
  close(): void { this.note = ''; this.drive({ act: 0 }); this.drive({ sae: 0 }); }

  /** Writes the pattern row by row (the panel's load), ending precharged; every row counts as restored. */
  write(words: readonly number[] = PATTERN): void {
    words.forEach((bits, r) => {
      this.precharge(); this.drive({ pre: 0 }); this.drive({ row: r, act: 1 }); this.drive({ sae: 1 });
      for (let c = 0; c < this.p.cols; c++) { this.drive({ col: c, din: (bits >> c) & 1, cs: 1, we: 1 }); this.drive({ we: 0, cs: 0 }); }
      this.close();
    });
    this.precharge();
    this.age.fill(0);
    this.note = 'Pattern written.';
  }
  refresh(row: number): void {
    if (this.inp('act') === 1) this.close();
    this.precharge(); this.activate(row); this.sense(); this.age[row] = 0; this.close(); this.precharge();
    this.note = `Row ${row} refreshed.`;
  }
  refreshAll(): void { for (let r = 0; r < this.p.rows; r++) this.refresh(r); this.note = 'Every row refreshed.'; }
  wait(n: number): void {
    this.sim.leak(n);
    for (let r = 0; r < this.p.rows; r++) this.age[r] += n;
    this.restored();
    this.note = this.inp('act') === 1 && this.inp('sae') === 0
      ? `${n} cycles passed with row ${this.inp('row')} open and not sensed: each cell and its bit line leak together (slower than a cell alone), so a 1 loses its margin while a 0 gains. A controller never waits here: it senses at once.`
      : `${n} cycles passed.`;
  }

  snap(): DramSnap {
    const s = this.sim, p = this.p, act = this.inp('act') === 1;
    const bl = p.bl.map((n) => s.level(n));
    return {
      cell: p.cell.map((row) => row.map((n) => s.level(n))),
      bl, blb: p.blb.map((n) => s.level(n)), dv: bl.map((v, c) => v - s.level(p.blb[c])), ratio: this.ratio,
      open: act ? this.inp('row') : -1, sensed: this.inp('sae') === 1, precharged: this.inp('pre') === 1,
      age: this.age.slice(),
    };
  }
}
