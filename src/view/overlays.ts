// The overlay bar's quantities (DOM-free): one at a time over the level on screen, each value in one of five shared
// bands (0 = the one to look at … 4 = calm) with a text value, so colour is never the only cue. The views draw the
// bands (SchematicView / EditorView overlay(), data-ov, app.css --ov-0…4); the legend says what each band means.
//
// Slack: static timing through every part (sim/slack.ts, the old heatmap). Activity: 0 ↔ 1 changes per bit since the
// overlay was turned on (GateSim's toggle counts, glitches included). Load: the NAND inputs each wire drives (the
// load model's fan-out). Unknown: wires with an X bit, and the parts the X starts from (an X out, no X in).
// Cost: each part's NANDs (transistors, relays or tube sections at switch level) as a share of the level. Energy: the
// switched capacitance of the wires each part drives since the overlay was turned on (Activity weighted by load, as
// power.ts's breakdown). Depth: when each part's slowest output settles after the clock edge (timing.ts's arrival).

import { type DelayModel, fanoutOf, fmtDelay, nandDelay, netLoads } from '../sim/delay';
import type { FlatDesign, HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { SLACK_BAND_LABELS, slackHeat, slackOf } from '../sim/slack';
import { hasFeedback, type Stats, stats } from '../sim/stats';
import { driverOf, netCaps } from '../sim/netcap';
import { type TimingGraph, timingGraph } from '../sim/timing';
import { BX, type ComponentDef, netlistOf } from '../sim/types';
import { groupDigits } from '../sim/numfmt';
import { FF_INPUT, FF_WIRE } from '../sim/netcap';

const ONE_INPUT = FF_INPUT + FF_WIRE;

export type OverlayKind = 'slack' | 'activity' | 'load' | 'unknown' | 'cost' | 'energy' | 'depth';
export const OVERLAY_KINDS: readonly OverlayKind[] = ['slack', 'activity', 'load', 'unknown', 'cost', 'energy', 'depth'];
export const OVERLAY_LABEL: Record<OverlayKind, string> = { slack: 'Slack', activity: 'Activity', load: 'Load', unknown: 'Unknown', cost: 'Cost', energy: 'Energy', depth: 'Depth' };
export const OVERLAY_TITLE: Record<OverlayKind, string> = {
  slack: 'Slack: how much later each part\'s slowest signal could arrive before the clock period (or the longest path) grew',
  activity: 'Activity: how often each wire changes, counted while this overlay is on (runs the gate-level engine)',
  load: 'Load: how many NAND inputs each wire drives',
  unknown: 'Unknown: wires holding an X, and the parts it starts from',
  cost: 'Cost: each part\'s share of this level\'s NANDs (transistors at switch level)',
  energy: 'Energy: the switched capacitance of the wires each part drives, counted while this overlay is on (runs the gate-level engine)',
  depth: 'Depth: when each part\'s slowest output settles, in delays after the clock edge (or the inputs)',
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
  if (c.level === 'switch' && (kind === 'slack' || kind === 'activity' || kind === 'energy' || kind === 'depth'))
    return 'A transistor-level circuit: the switch-level solver has no gate delays, so only Load, Unknown and Cost apply.';
  if ((kind === 'activity' || kind === 'energy') && c.engine === 'cycle') return 'This scene runs on the cycle engine, which keeps no toggle counts (it is too large for the gate-level engine).';
  if ((kind === 'activity' || kind === 'energy') && c.sub) return 'This level has a simulation of its own (opened from a leaf): its toggles are not counted.';
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

// ---- Cost -----------------------------------------------------------------------------------------------------

/** A share of the level, banded: 0 the largest (≥ 25 %), … 4 the smallest (< 1 %). */
export const SHARE_BANDS = [0.25, 0.1, 0.04, 0.01] as const;
export const SHARE_LABELS = ['≥ 25 %', '10–25 %', '4–10 %', '1–4 %', '< 1 %'] as const;
export function shareBand(f: number): number {
  for (let b = 0; b < SHARE_BANDS.length; b++) if (f >= SHARE_BANDS[b]) return b;
  return SHARE_BANDS.length;
}
const pctOf = (f: number) => (f >= 0.1 ? Math.round(f * 100).toString() : f >= 0.01 ? (f * 100).toFixed(1) : (f * 100).toFixed(2));

/** The level's parts (its netlist's instances), by name, with their definitions. */
function partsOf(node: HierNode): [string, ComponentDef][] {
  if (node.children?.size) return [...node.children].map(([n, c]) => [n, c.def]);
  return (netlistOf(node.def)?.instances ?? []).map((i) => [i.name, i.def]);
}

/**
 * Each part's share of the level's cost: NANDs at gate level; at switch level transistors, or relays, or tube sections
 * (triodes and diodes), whichever the level is made of. Pure wiring (splitters, constants) costs nothing and is left out.
 */
export function costOverlay(node: HierNode, level: 'gate' | 'switch'): OverlayResult {
  const parts = partsOf(node).map(([n, d]) => [n, stats(d)] as const);
  const sum = (f: (s: Stats) => number) => parts.reduce((a, [, st]) => a + f(st), 0);
  const [word, of]: [string, (s: Stats) => number] =
    level === 'gate' ? ['NAND', (st) => st.nands]
      : sum((st) => st.transistors) > 0 ? ['transistor', (st) => st.transistors]
        : sum((st) => st.relays) > 0 ? ['relay', (st) => st.relays]
          : ['tube section', (st) => st.triodes + st.diodes];
  const total = sum(of);
  const inst = new Map<string, OvMark>();
  if (total > 0) for (const [name, st] of parts) {
    const n = of(st);
    if (!n) continue;
    const f = n / total;
    inst.set(name, { band: shareBand(f), tip: `${name}: ${plural(n, word)}, ${pctOf(f)} % of this level` });
  }
  return {
    kind: 'cost', inst, net: new Map(),
    legend: {
      title: 'Cost', unit: `share of this level's ${plural(total, word)}`,
      rows: SHARE_LABELS.map((l, b) => ({ band: b, label: l, count: plural(hist(inst, b), 'part') })),
      note: `Each part's ${word}s, everything inside it counted, as a share of the level. Counted from the structure: no simulation. Untinted: pure wiring, which costs nothing.`,
    },
  };
}

// ---- Energy ---------------------------------------------------------------------------------------------------

const capCache = new WeakMap<FlatDesign, Float64Array>();
const capsOf = (d: FlatDesign) => { let c = capCache.get(d); if (!c) capCache.set(d, (c = netCaps(d))); return c; };

/**
 * The switched capacitance (fF · toggles) of the nets each part of the level drives, from `toggles` minus `base`
 * (GateSim.toggles snapshots) over `units` clock cycles or input changes: power.ts's breakdown, as a share of the level's.
 */
export function energyOverlay(design: FlatDesign, node: HierNode, toggles: ArrayLike<number>, base: ArrayLike<number>, units: number, clocked: boolean): OverlayResult {
  const caps = capsOf(design), dr = driverOf(design), k = node.path.length;
  const by = new Map<string, number>();
  let level = 0;
  for (let i = 0; i < caps.length; i++) {
    const t = toggles[i] - base[i];
    if (t <= 0) continue;
    const li = dr[i];
    if (li < 0) continue;
    const p = design.leaves[li].node.path;
    if (p.length <= k || node.path.some((x, j) => p[j] !== x)) continue;
    const sw = t * caps[i];
    by.set(p[k], (by.get(p[k]) ?? 0) + sw);
    level += sw;
  }
  const per = clocked ? 'clock cycle' : 'input change';
  const inst = new Map<string, OvMark>();
  if (level > 0) for (const [name, sw] of by) {
    const f = sw / level;
    inst.set(name, { band: shareBand(f), tip: `${name}: ${pctOf(f)} % of this level's switched capacitance over ${plural(units, per)} (${(sw / Math.max(1, units)).toFixed(1)} fF a ${per})` });
  }
  return {
    kind: 'energy', inst, net: new Map(),
    legend: {
      title: 'Energy', unit: 'share of the switched capacitance',
      rows: SHARE_LABELS.map((l, b) => ({ band: b, label: l, count: plural(hist(inst, b), 'part') })),
      note: units > 0 && level > 0
        ? `C × toggles of the wires each part drives, glitches included, over the last ${plural(units, per)}: ${groupDigits(Math.round(level / units))} fF a ${per} on this level (the energy is ½ C V² of it). Counted on the gate-level engine while this overlay is on.`
        : `Nothing has switched since the overlay came on: ${clocked ? 'Step, Pulse or Run the clock' : 'change an input'} and the parts take their colours.`,
    },
  };
}

// ---- Depth ----------------------------------------------------------------------------------------------------

/** Arrival as a fraction of the longest path, banded: 0 late (≥ 90 %), … 4 early (< 25 %). */
export const DEPTH_BANDS = [0.9, 0.75, 0.5, 0.25] as const;
export const DEPTH_LABELS = ['≥ 90 %', '75–90 %', '50–75 %', '25–50 %', '< 25 %'] as const;
export function depthBand(f: number): number {
  for (let b = 0; b < DEPTH_BANDS.length; b++) if (f >= DEPTH_BANDS[b] - 1e-9) return b;
  return DEPTH_BANDS.length;
}

const graphCache = { unit: new WeakMap<FlatDesign, TimingGraph>(), load: new WeakMap<FlatDesign, TimingGraph>(), drawn: new WeakMap<FlatDesign, TimingGraph>() };

/** The latest arrival at any output of each part on the level, from the graph Slack times; null when nothing is timed. */
export function depthOverlay(design: FlatDesign, node: HierNode, model: DelayModel): OverlayResult | null {
  const s = slackOf(design, model);
  if (!s) return null;
  let g = graphCache[model].get(design);
  if (!g) graphCache[model].set(design, (g = timingGraph(design, { delay: model, outputs: !s.clocked })));
  const inst = new Map<string, OvMark>();
  const word = model === 'unit' ? 'NAND delays' : 'units', f = (x: number) => fmtDelay(x, model);
  const from = s.clocked ? 'after the clock edge' : 'after the inputs change';
  for (const [name, ch] of node.children ?? []) {
    let worst = -Infinity;
    for (const p of ch.def.ports) if (p.dir === 'out') for (const n of ch.ports[p.name] ?? []) {
      const a = g.arr(n);
      if (Number.isFinite(a) && a > worst) worst = a;
    }
    if (!(worst >= 0)) continue;
    inst.set(name, { band: depthBand(worst / s.period), tip: `${name}: settles ${f(worst)} ${word} ${from} (${Math.round((100 * worst) / s.period)} % of ${s.clocked ? 'the clock period' : 'the longest path'}, ${f(s.period)})` });
  }
  return {
    kind: 'depth', inst, net: new Map(),
    legend: {
      title: 'Depth', unit: `latest output · share of ${s.clocked ? 'the period' : 'the longest path'}`,
      rows: DEPTH_LABELS.map((l, b) => ({ band: b, label: l, count: plural(hist(inst, b), 'part') })),
      note: `When each part's slowest output settles, ${from}; ${s.clocked ? 'clock period' : 'longest input → output path'} ${f(s.period)} ${word}. Static timing: no simulation. Late is not the same as critical: Slack says whether the path goes on.`,
    },
  };
}

/** What a view draws of an overlay: the marks, without the legend. */
export type OverlayMarks = Pick<OverlayResult, 'kind' | 'inst' | 'net'>;
