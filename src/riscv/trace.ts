// Slow mode helpers (no DOM): what a retired instruction did, and the speed slider's scale.

import { bitsToF32 } from '../sim/fpref';
import { ABI, FABI } from './isa';
import { CAUSE, type StepInfo } from './iss';

const hex = (v: number, d = 8) => '0x' + (v >>> 0).toString(16).padStart(d, '0');

const CAUSE_NAME: Record<number, string> = {
  [CAUSE.MISALIGNED_FETCH]: 'misaligned fetch', [CAUSE.ILLEGAL]: 'illegal instruction', [CAUSE.BREAKPOINT]: 'ebreak',
  [CAUSE.MISALIGNED_LOAD]: 'misaligned load', [CAUSE.MISALIGNED_STORE]: 'misaligned store', [CAUSE.ECALL]: 'ecall',
  [CAUSE.TIMER_IRQ]: 'timer interrupt', [CAUSE.EXTERNAL_IRQ]: 'external interrupt',
};

/** The architectural effect of one step, e.g. `a0 ← 0x0000002a (42)` or `[0x10] ← 0x00000007`. */
export function stepEffect(s: StepInfo): string {
  if (s.trap) return `trap: ${CAUSE_NAME[s.trap.cause] ?? 'cause'} (mcause ${hex(s.trap.cause, 1)}) → mtvec`;
  const parts: string[] = [];
  if (s.rd) parts.push(`${ABI[s.rd]} ← ${hex(s.value ?? 0)} (${(s.value ?? 0) | 0})`);
  if (s.fwrite) parts.push(`${FABI[s.fwrite.rd]} ← ${hex(s.fwrite.value)} (${+bitsToF32(s.fwrite.value).toPrecision(7)})`);
  if (s.store) parts.push(`[${hex(s.store.addr, 2)}] ← ${hex(s.store.value)}`);
  if (s.halted) parts.push('halt');
  return parts.length ? parts.join(' · ') : '—';
}

/** Slider position 0..1 → rate on a log scale between min and max. */
export function rateScale(pos: number, min: number, max: number): number {
  const p = Math.min(1, Math.max(0, pos));
  return min * Math.pow(max / min, p);
}

/** Inverse of rateScale. */
export function ratePos(rate: number, min: number, max: number): number {
  return Math.min(1, Math.max(0, Math.log(rate / min) / Math.log(max / min)));
}

/** Rates read best with two significant digits (0.25, 1.5, 12, 150). */
export function fmtRate(r: number): string {
  return r >= 10 ? String(Math.round(r)) : String(+r.toPrecision(2));
}
