// The overlay bar's quantities (DOM-free): one at a time over the level on screen, each value in one of five shared
// bands (0 = the one to look at … 4 = calm) with a text value, so colour is never the only cue. The views draw the
// bands (SchematicView / EditorView overlay(), data-ov, app.css --ov-0…4); the legend says what each band means.
//
// Slack: static timing through every part (sim/slack.ts, the old heatmap). Activity: 0 ↔ 1 changes per bit since the
// overlay was turned on (GateSim's toggle counts, glitches included). Load: the NAND inputs each wire drives (the
// load model's fan-out). Unknown: wires with an X bit, and the parts the X starts from (an X out, no X in).

import { type DelayModel, fanoutOf, nandDelay, netLoads } from '../sim/delay';
import type { FlatDesign, HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { SLACK_BAND_LABELS, slackHeat, slackOf } from '../sim/slack';
import { hasFeedback } from '../sim/stats';
import { BX, netlistOf } from '../sim/types';
import { groupDigits } from '../sim/numfmt';
import { FF_INPUT, FF_WIRE } from '../sim/netcap';

const ONE_INPUT = FF_INPUT + FF_WIRE;

export type OverlayKind = 'slack' | 'activity' | 'load' | 'unknown';
export const OVERLAY_KINDS: readonly OverlayKind[] = ['slack', 'activity', 'load', 'unknown'];
export const OVERLAY_LABEL: Record<OverlayKind, string> = { slack: 'Slack', activity: 'Activity', load: 'Load', unknown: 'Unknown' };
export const OVERLAY_TITLE: Record<OverlayKind, string> = {
  slack: 'Slack: how much later each part\'s slowest signal could arrive before the clock period (or the longest path) grew',
  activity: 'Activity: how often each wire changes, counted while this overlay is on (runs the gate-level engine)',
  load: 'Load: how many NAND inputs each wire drives',
  unknown: 'Unknown: wires holding an X, and the parts it starts from',
};

/** A band (0 … 4, or 'x' for Unknown) and its value in words. `src`: where an X starts. */
export interface OvMark { band: number | 'x'; tip: string; src?: boolean }

export interface OvLegendRow { band: number | 'x' | 'src'; label: string; count: string }
export interface OvLegend { title: string; unit: string; rows: OvLegendRow[]; note: string }

export interface OverlayResult {
  kind: OverlayKind;
  /** Instance of the level → mark. */
  inst: Map<string, OvMark>;
  /** Net index of the level's netlist → mark. */
  net: Map<number, OvMark>;
  legend: OvLegend;
}

/** What the scene runs on, for which overlays apply. */
export interface OvContext {
  level: 'gate' | 'switch';
  engine?: 'gate' | 'cycle' | 'nmos';
  /** The level is a sub-simulation (an opened NAND or ROM), not the scene's own. */
  sub?: boolean;
}

/** Why an overlay cannot be shown here ('' if it can). */
export function overlayRefusal(kind: OverlayKind, c: OvContext): string {
  if (c.engine === 'nmos') return 'This chip runs on the NMOS engine: two values, no gate delays, so none of the overlays apply.';
  if (c.level === 'switch' && (kind === 'slack' || kind === 'activity'))
    return 'A transistor-level circuit: the switch-level solver has no gate delays, so only Load and Unknown apply.';
  if (kind === 'activity' && c.engine === 'cycle') return 'This scene runs on the cycle engine, which keeps no toggle counts (it is too large for the gate-level engine).';
  if (kind === 'activity' && c.sub) return 'This level has a simulation of its own (opened from a leaf): its toggles are not counted.';
  return '';
}

const plural = (n: number, w: string) => `${groupDigits(n)} ${w}${n === 1 ? '' : 's'}`;
const hist = <K>(m: Map<K, OvMark>, band: number | 'x') => [...m.values()].filter((v) => v.band === band).length;

/** The fan-out from which the load model puts inverter pairs in front of a wire (where they make it faster). */
export const BUFFER_FANOUT: number = (() => {
  for (let fo = 1; fo < 64; fo++) if (nandDelay(fo * ONE_INPUT, true) < nandDelay(fo * ONE_INPUT, false) - 1e-9) return fo;
  return 64;
})();


/** The name a net goes by in a tooltip. */
function netName(node: HierNode, i: number): string {
  const nd = netlistOf(node.def)?.nets[i];
  return nd?.name ?? nd?.ends[0] ?? `net ${i}`;
}

// ---- Slack ----------------------------------------------------------------------------------------------------

export function slackOverlay(design: FlatDesign, at: readonly string[], model: DelayModel): OverlayResult | null {
  const s = slackOf(design, model);
  if (!s) return null;
  const inst = new Map<string, OvMark>([...slackHeat(s, at)].map(([k, v]) => [k, { band: v.band, tip: v.tip }]));
  const word = model === 'unit' ? 'NAND delays' : 'units';
  return {
    kind: 'slack', inst, net: new Map(),
    legend: {
      title: 'Slack', unit: 'per part · share of the period',
      rows: SLACK_BAND_LABELS.map((l, b) => ({ band: b, label: b === 4 ? '≥ 50 %' : l, count: plural(hist(inst, b), 'part') })),
      note: `${s.clocked ? `Clock period ${Math.round(s.period * 10) / 10} ${word}` : `Longest input → output path ${Math.round(s.period * 10) / 10} ${word}`}: how much later the slowest path through each part could be before it grew. Static timing: no simulation. Untinted: no ${s.clocked ? 'register-to-register' : 'input → output'} path crosses it.`,
    },
  };
}

// ---- Activity -------------------------------------------------------------------------------------------------

/** Toggles per bit per unit, banded: 0 changes as often as a clock (1 and more), … 4 quiet. */
export const ACTIVITY_BANDS = [1, 0.5, 0.2, 0] as const;
export const ACTIVITY_LABELS = ['≥ 1', '0.5–1', '0.2–0.5', '< 0.2', '0 (quiet)'] as const;
export function activityBand(t: number): number {
  if (t >= 1) return 0;
  if (t >= 0.5) return 1;
  if (t >= 0.2) return 2;
  return t > 0 ? 3 : 4;
}

const fmtRate = (t: number) => (t >= 10 ? t.toFixed(0) : t >= 1 ? t.toFixed(1) : t.toFixed(2));

/**
 * Toggles per bit per unit of each net of the level, from `toggles` minus `base` (snapshots of GateSim.toggles)
 * over `units` (clock cycles, or input changes for a circuit without a clock).
 */
export function activityOverlay(node: HierNode, toggles: ArrayLike<number>, base: ArrayLike<number>, units: number, clocked: boolean): OverlayResult {
  const net = new Map<number, OvMark>();
  const per = clocked ? 'clock' : 'input change';
  const nets = node.nets ?? [];
  if (units > 0) nets.forEach((bits, i) => {
    if (!bits.length) return;
    let sum = 0;
    for (const f of bits) sum += Math.max(0, toggles[f] - base[f]);
    const t = sum / bits.length / units;
    net.set(i, { band: activityBand(t), tip: `${netName(node, i)}: ${fmtRate(t)} changes per bit per ${per}${bits.length > 1 ? ` (${bits.length} bits)` : ''}` });
  });
  return {
    kind: 'activity', inst: new Map(), net,
    legend: {
      title: 'Activity', unit: `changes per bit per ${per}`,
      rows: ACTIVITY_LABELS.map((l, b) => ({ band: b, label: l, count: plural(hist(net, b), 'wire') })),
      note: units > 0
        ? `0 ↔ 1 changes over the last ${plural(units, per)}, glitches included (a clock makes 2 a cycle). Counted on the gate-level engine while this overlay is on.`
        : `Nothing has run since the overlay came on: ${clocked ? 'Step, Pulse or Run the clock' : 'change an input'} and the wires take their colours.`,
    },
  };
}

// ---- Load -----------------------------------------------------------------------------------------------------

export function loadBand(fo: number): number {
  if (fo > 4 * BUFFER_FANOUT) return 0;
  if (fo > 2 * BUFFER_FANOUT) return 1;
  if (fo >= BUFFER_FANOUT) return 2;
  return fo > 1 ? 3 : 4;
}

export function loadOverlay(design: FlatDesign, node: HierNode): OverlayResult {
  const loads = netLoads(design);
  const net = new Map<number, OvMark>();
  (node.nets ?? []).forEach((bits, i) => {
    if (!bits.length) return;
    let worst = 0;
    for (const f of bits) worst = Math.max(worst, loads[f]);
    const fo = fanoutOf(worst);
    net.set(i, { band: loadBand(fo), tip: `${netName(node, i)}: drives ${plural(fo, 'NAND input')}${bits.length > 1 ? ' (its busiest bit)' : ''}, ${worst.toFixed(1)} fF` });
  });
  const B = BUFFER_FANOUT;
  return {
    kind: 'load', inst: new Map(), net,
    legend: {
      title: 'Load', unit: 'NAND inputs driven (busiest bit)',
      rows: [`> ${4 * B}`, `${2 * B + 1}–${4 * B}`, `${B}–${2 * B}`, `2–${B - 1}`, '0–1'].map((l, b) => ({ band: b, label: l, count: plural(hist(net, b), 'wire') })),
      note: `From ${B} inputs on, a buffer in front of the wire makes it faster (the load-dependent delay model). About ${ONE_INPUT.toFixed(1)} fF an input with its wire, illustrative 28 nm. Counted from the structure: no simulation.`,
    },
  };
}

// ---- Unknown --------------------------------------------------------------------------------------------------

export function unknownOverlay(sim: Sim, node: HierNode): OverlayResult {
  const xOf = (nets: readonly number[]) => { let n = 0; for (const b of sim.getBits(nets)) if (b === BX) n++; return n; };
  const net = new Map<number, OvMark>();
  (node.nets ?? []).forEach((bits, i) => {
    const n = bits.length ? xOf(bits) : 0;
    if (n) net.set(i, { band: 'x', tip: `${netName(node, i)}: ${n === bits.length ? (n === 1 ? 'X' : `all ${n} bits X`) : `${n} of ${bits.length} bits X`}` });
  });
  // where an X starts: a part with an X out and either no X in or storage of its own (a register in a loop has X in too:
  // its own output fed back), and the level's own inputs left X
  const inst = new Map<string, OvMark>();
  for (const [name, ch] of node.children ?? []) {
    let xin = 0, xout = 0;
    for (const p of ch.def.ports) {
      const n = xOf(ch.ports[p.name] ?? []);
      if (p.dir === 'out') xout += n;
      else xin += n;
    }
    if (xout && (!xin || hasFeedback(ch.def))) inst.set(name, { band: 'x', src: true, tip: `${name}: ${xout} output bit${xout === 1 ? '' : 's'} X${xin ? '' : ' with every input known'}: it holds X (storage never written since power-on). Reset, or one write, clears it.` });
  }
  const pins = node.def.ports.filter((p) => p.dir !== 'out' && xOf(node.ports[p.name] ?? []) > 0).map((p) => p.name);
  const total = (node.nets ?? []).filter((b) => b.length).length;
  const srcs = [...inst.keys()];
  return {
    kind: 'unknown', inst, net,
    legend: {
      title: 'Unknown', unit: 'X: neither 0 nor 1',
      rows: [
        { band: 'x', label: `${net.size} of ${total}`, count: 'wires with an X bit' },
        ...(srcs.length ? [{ band: 'src' as const, label: srcs.length > 3 ? `${srcs.slice(0, 3).join(', ')} +${srcs.length - 3}` : srcs.join(', '), count: 'where it starts' }] : []),
        ...(pins.length ? [{ band: 'src' as const, label: pins.join(', '), count: pins.length === 1 ? 'an input left X' : 'inputs left X' }] : []),
      ],
      note: net.size ? 'An X spreads through every gate whose output it can change. It starts at storage nobody wrote and at inputs nobody set.' : 'Every wire on this level is a 0 or a 1.',
    },
  };
}

/** What a view draws of an overlay: the marks, without the legend. */
export type OverlayMarks = Pick<OverlayResult, 'kind' | 'inst' | 'net'>;
