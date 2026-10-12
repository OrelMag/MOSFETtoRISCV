// The pipeline diagram (stage × cycle) shared by the chapters' pipeline panel and the sandbox's CPU
// panel: a history of PipeSnaps (riscv/cosim.ts) recorded after every rising edge, drawn as a grid
// with one coloured mnemonic per occupied slot, bubbles, and the hazard events of each cycle.

import { type PipeSnap, pipeSnap } from '../riscv/cosim';
import { disasm } from '../riscv/isa';
import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { h } from '../ui/dom';

const hex = (v: number, d = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');

/** The last `max` cycles of a pipeline (a rewind, a reset, drops what came after). */
export class PipeHistory {
  readonly snaps: PipeSnap[] = [];
  constructor(private readonly max = 200) {}

  record(sim: Pick<Sim, 'getBits'>, root: HierNode, cycle: number): void {
    const s = pipeSnap(sim, root, cycle);
    if (!s) return;
    const h = this.snaps;
    if (h.length && h[h.length - 1].cycle >= cycle) h.length = Math.max(0, h.findIndex((x) => x.cycle >= cycle));
    h.push(s);
    if (h.length > this.max) h.shift();
  }

  clear(): void {
    this.snaps.length = 0;
  }

  get last(): PipeSnap | undefined {
    return this.snaps[this.snaps.length - 1];
  }
}

/** The grid's rows (head, one per stage, events) for the last `n` cycles; `wordAt(pc)`: the instruction there. */
export function pipeGridRows(snaps: PipeSnap[], wordAt: (pc: number) => number | undefined, n = 12): HTMLElement[] {
  const shown = snaps.slice(-n);
  const stages = shown[shown.length - 1]?.stages ?? ['F', 'D', 'E', 'M', 'W'];
  const mnem = (pc: number) => {
    const w = wordAt(pc);
    return w === undefined ? 'nop' : disasm(w, pc).split(' ')[0];
  };
  const hue = (pc: number) => (pc * 47) % 360;
  const head = h('div', { class: 'pg-row head' }, h('span', { class: 'pg-st' }, ''), shown.map((s) => h('span', { class: 'pg-c' }, String(s.cycle))));
  const rows = stages.map((st, si) => h('div', { class: 'pg-row' }, h('span', { class: 'pg-st' }, st),
    shown.map((s) => {
      const slot = s.slots[si];
      if (!slot?.valid) return h('span', { class: 'pg-c bubble', title: 'bubble' }, '·');
      return h('span', { class: 'pg-c', style: `--h:${hue(slot.pc)}`, title: `${hex(slot.pc, 4)}: ${disasm(wordAt(slot.pc) ?? 0x13, slot.pc)}` }, mnem(slot.pc));
    })));
  const ev = h('div', { class: 'pg-row ev' }, h('span', { class: 'pg-st' }, ''), shown.map((s) => {
    const tags: string[] = [];
    if (s.stall) tags.push('stall');
    if (s.flush) tags.push('flush');
    if (s.fwdA === 2 || s.fwdB === 2) tags.push('M→E');
    if (s.stages.length === 6 && (s.fwdA === 3 || s.fwdB === 3)) tags.push('X→E');
    if (s.fwdA === 1 || s.fwdB === 1) tags.push('W→E');
    if (s.byp) tags.push('W→D');
    return h('span', { class: 'pg-c ev', title: tags.join(', ') }, tags.join(' '));
  }));
  return [head, ...rows, ev];
}
