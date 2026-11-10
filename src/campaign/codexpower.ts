// Codex entries for the Power chapter (chapters/ch-power.ts). Same shape as codex.ts; the fuller texts are codexmorepow.ts, the questions
// codexcheckpow.ts, the numbers pinned by tests/content-codexpower.test.ts (against bench/powercosts.json and the chapter's widgets). No DOM,
// no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_POWER: CodexEntry[] = [
  E('leakstate', 'Leakage by state', 'concept', `An off transistor still carries a small current, and which of a gate's transistors are off depends on its inputs. A NAND with both inputs at 1 leaks through its two parallel PMOS; with one input at 0, through one NMOS; with both at 0, through two NMOS in series, least of all (the <b>stack effect</b>). Summed NAND by NAND from the simulation's own values, the single-cycle CPU leaks 161 µW in a high-performance process (100 nA/µm off current, ITRS 2013) and 46 nW in a low-standby-power one (10 pA/µm).`, ['power', 'powergating']),
  E('powergating', 'Power gating', 'trick', `A large switch transistor between a block and its supply turns the block off: nothing switches and nothing leaks. The price is waking up: every node that must be 1 is charged again, 39.6 pJ for the single-cycle CPU, and the block's state is lost unless kept in retention flip-flops. So it pays only after a break-even idle time: 247 ns (64 cycles) in the high-performance process, 863 µs in the low-leakage one, where there is little leakage to save.`, ['leakstate', 'clockgating']),
  E('dvfs', 'Voltage and frequency scaling (DVFS)', 'trick', `Energy per toggle goes with V², and a gate's delay grows as V falls toward the threshold, so a chip that does not need full speed lowers its supply and its clock together. A faster design can spend its spare speed this way: asked for 4 ns per instruction, the balanced pipeline gets there at 0.62 V for 23.2 pJ, the single-cycle CPU only at 0.89 V for 45.9 pJ.`, ['minenergy', 'power']),
  E('minenergy', 'Minimum-energy point', 'law', `Lowering the supply saves V² on every toggle, but below the threshold the clock slows exponentially while the leakage falls far less, so each instruction leaks for longer. Their sum has a minimum: for the single-cycle CPU in the high-performance process, 6.1 pJ per instruction at 0.225 V and 12 MHz, against 46.5 pJ at 0.9 V and 253 MHz. Below it, slower costs more.`, ['dvfs', 'leakstate']),
  E('darksilicon', 'Dark silicon', 'concept', `Since about 2005 the supply has stopped falling with each process (a lower threshold leaks exponentially more), so the power per mm² of logic running flat out keeps rising. At 0.9 V the single-cycle CPU's logic draws about 0.5 W/mm²: a 100 mm² die of it would draw 49 W, and within a 15 W budget only 31 % of it could run at once. The rest stays dark: idle, gated or slow, which is why chips fill it with specialised blocks used one at a time.`, ['dvfs', 'powergating']),
  E('glitch', 'Glitch', 'concept', `A change of a net that does not last: a sum bit of a ripple-carry adder flips as each carry arrives and flips back. It charges and discharges its wire like any other change and achieves nothing. The more gates a signal passes through on its way, the more times it can change before it settles. A meter that looks only at the settled values cannot see them; a simulator with gate delays can.`, ['power', 'depth']),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_POWER: Record<string, string> = {
  leakstate: 'power', powergating: 'power', dvfs: 'power', minenergy: 'power', darksilicon: 'power',
  glitch: 'adders', // taught where a ripple adder's sum bits first flip and flip back; the Power chapter measures what they cost
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_POWER: Record<string, string[]> = {
  leakstate: ['stack effect'],
  powergating: ['power gating', 'power-gated', 'power gate'],
  dvfs: ['DVFS', 'voltage and frequency scaling'],
  minenergy: ['minimum-energy point'],
  darksilicon: ['dark silicon'],
  glitch: ['glitches', 'glitching'],
};

/** Ids no campaign level lists: the Power chapter's, beyond the clock-gate level (s_icg lists clockgating). */
export const POWER_AWAITING_LEVELS: ReadonlySet<string> = new Set(Object.keys(TAUGHT_POWER));
