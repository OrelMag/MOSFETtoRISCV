// Flowing bits (after Turing Complete): a wire carrying a 1 shows pellets marching from its
// driver to its sinks, and a bus carrying a non-zero word shows that value riding along it, like
// packets in a pipe (view/flowtokens.ts). Pellets are a stroke-dasharray on an overlay path,
// moved by a CSS animation of stroke-dashoffset; pellets and values both take their phase from
// one global clock, so pieces of one net (sandbox wires split at branches, a schematic net's
// paths sharing a trunk) line up wherever they meet.

import type { Vec } from '../sim/geometry';
import { B1, BX, type Bit } from '../sim/types';
import { formatBits, type Radix } from '../sim/values';

/** Travel speed of pellets and values, grid units per second. */
export const FLOW_SPEED = 4;
const PELLET = 0.45, PELLET_GAP = 1.15;

/** A dash pattern (dash, gap, dash, gap, ...: always an even count) and its period. */
export interface FlowDash { dash: number[]; period: number }

/** Pellets on a 1-bit wire carrying a 1; null otherwise (0, X, Z, and buses: they carry values). */
export function flowDash(bits: Bit[]): FlowDash | null {
  return bits.length === 1 && bits[0] === B1 ? { dash: [PELLET, PELLET_GAP], period: PELLET + PELLET_GAP } : null;
}

/** The value a bus carries along, or null when nothing flows (a 1-bit wire, a zero word, any X). */
export function flowText(bits: Bit[], radix: Radix): string | null {
  if (bits.length < 2 || bits.some((b) => b === BX) || !bits.some((b) => b === B1)) return null;
  return formatBits(bits, radix);
}

/**
 * Dash array and dash offsets (animation start → end) for a path of length `len` whose start is
 * `d0` grid units from the driver along the net. `reverse`: the signal enters at the path's end
 * (a sandbox wire drawn from a sink to its driver), so the pattern runs backwards.
 */
export function flowStyle(f: FlowDash, d0: number, len: number, reverse: boolean): { dasharray: string; from: number; to: number } {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  if (!reverse) return { dasharray: f.dash.map(r).join(' '), from: r(d0), to: r(d0 - f.period) };
  // f(-x) is the reversed pattern; a leading 0 dash keeps the gaps on even indices.
  const back = [0, ...[...f.dash].reverse(), 0];
  const o = -d0 - len;
  return { dasharray: back.map(r).join(' '), from: r(o), to: r(o + f.period) };
}

/** Animation key: what a path shows (unchanged key → leave its animation running). */
export const flowKey = (f: FlowDash | null, d0: number, len: number, reverse: boolean) =>
  f ? `${f.dash.join(',')}|${d0}|${len}|${reverse ? 1 : 0}` : '';

/** Show (or with f null, stop) the flow on an overlay path. */
export function applyFlow(el: SVGElement, f: FlowDash | null, d0 = 0, len = 0, reverse = false): void {
  const st = el.style;
  if (!f) {
    st.animation = '';
    st.strokeDasharray = '';
    el.setAttribute('display', 'none');
    return;
  }
  const { dasharray, from, to } = flowStyle(f, d0, len, reverse);
  const dur = f.period / FLOW_SPEED;
  st.strokeDasharray = dasharray;
  st.setProperty('--flow-from', String(from));
  st.setProperty('--flow-to', String(to));
  // A negative delay puts every animation on one global phase.
  const phase = ((performance.now() / 1000) % dur);
  st.animation = `wire-flow ${dur.toFixed(3)}s linear ${(-phase).toFixed(3)}s infinite`;
  el.removeAttribute('display');
}

// ---- polylines (grid units; a sandbox wire's segments may be slanted) -------------------------

const dist = (p: Vec, q: Vec) => Math.hypot(p[0] - q[0], p[1] - q[1]);

export const polyLength = (pts: Vec[]) => pts.slice(1).reduce((t, q, i) => t + dist(pts[i], q), 0);

/** The part of `poly` between arc lengths s0 < s1. */
export function slicePoly(poly: Vec[], s0: number, s1: number): Vec[] {
  const out: Vec[] = [];
  const at = (a: Vec, b: Vec, t: number): Vec => {
    const l = dist(a, b) || 1;
    return [a[0] + ((b[0] - a[0]) * t) / l, a[1] + ((b[1] - a[1]) * t) / l];
  };
  let s = 0;
  for (let i = 1; i < poly.length; i++) {
    const [a, b] = [poly[i - 1], poly[i]];
    const l = dist(a, b);
    if (s + l >= s0 && s <= s1) {
      if (!out.length) out.push(at(a, b, s0 - s));
      if (s + l <= s1) out.push(b);
      else { out.push(at(a, b, s1 - s)); break; }
    }
    s += l;
  }
  return out.filter((p, i) => i === 0 || p[0] !== out[i - 1][0] || p[1] !== out[i - 1][1]);
}

/** Length of the stretch two polylines from the same driver share before they part. */
function shared(a: Vec[], b: Vec[]): number {
  if (a[0][0] !== b[0][0] || a[0][1] !== b[0][1]) return 0;
  // Walk both a step at a time (corners and collinear points need not coincide).
  let s = 0, i = 1, j = 1;
  let ra = a.length > 1 ? dist(a[0], a[1]) : 0, rb = b.length > 1 ? dist(b[0], b[1]) : 0;
  const dir = (p: Vec[], k: number) => `${Math.sign(p[k][0] - p[k - 1][0])},${Math.sign(p[k][1] - p[k - 1][1])}`;
  while (i < a.length && j < b.length) {
    if (ra === 0) { i++; if (i < a.length) ra = dist(a[i - 1], a[i]); continue; }
    if (rb === 0) { j++; if (j < b.length) rb = dist(b[j - 1], b[j]); continue; }
    if (dir(a, i) !== dir(b, j)) break;
    const step = Math.min(ra, rb);
    s += step;
    ra -= step;
    rb -= step;
  }
  return s;
}

/**
 * A schematic net's paths (one per sink, each from the driver) cut to what no earlier path
 * already covers: values ride a shared trunk once, not once per sink, and each branch starts at
 * its junction with the trunk's distance there, so a value reaching it carries on down the branch.
 */
export function laneTails(paths: Vec[][]): { pts: Vec[]; d0: number; sink: boolean }[] {
  const out: { pts: Vec[]; d0: number; sink: boolean }[] = [];
  paths.forEach((p, i) => {
    const len = polyLength(p);
    let d0 = 0;
    for (let k = 0; k < i; k++) d0 = Math.max(d0, shared(paths[k], p));
    if (len - d0 > 1e-6) out.push({ pts: d0 > 0 ? slicePoly(p, d0, len) : p, d0, sink: true });
  });
  return out;
}
