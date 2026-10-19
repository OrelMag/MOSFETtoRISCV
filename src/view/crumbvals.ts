// The breadcrumb's live values (the chapters' stage and the sandbox's look inside): each opened level shows
// one of its outputs, chosen so the chain follows a single signal down. From the deepest level up, a level
// shows the output that carries the level below's (its bits are the same flat nets), else its first output.
// A level whose output is part of the level above's bus says which bits: the top in hex, `bit [7] = 1` where
// the bus was sliced. The top level shows a value only when it carries the chain: a CPU's pins are noise
// above an adder opened inside it.

import { B0, B1, type Bit } from '../sim/types';
import { formatBits, type Radix } from '../sim/values';
import type { ViewCtx } from './context';

export interface CrumbValue {
  /** The output shown, a port of this level. */
  port: string;
  /** Bits [lo, hi] of the level above's shown output, when this one is a part of it. */
  slice: { lo: number; hi: number; of: string } | null;
  read(): Bit[];
}

/** One entry per level of the chain (index 0 the top), null where nothing is shown. */
export function crumbValues(chain: ViewCtx[]): (CrumbValue | null)[] {
  const n = chain.length;
  const shown: (string | null)[] = new Array(n).fill(null);
  for (let k = n - 1; k >= 0; k--) {
    const ctx = chain[k], outs = ctx.def.ports.filter((p) => p.dir === 'out');
    const below = k + 1 < n ? shown[k + 1] : null;
    // The level below's output as nets of this level's simulation (a sub-simulation's root is its own).
    const nets = below ? ctx.node.children?.get(lastName(chain[k + 1]))?.ports[below] : undefined;
    const carrier = nets && outs.find((p) => offsetIn(ctx.node.ports[p.name], nets) >= 0);
    shown[k] = carrier ? carrier.name : k === 0 ? null : (outs[0]?.name ?? null);
  }
  return chain.map((ctx, k) => {
    const port = shown[k];
    if (!port) return null;
    let slice: CrumbValue['slice'] = null;
    const up = k > 0 ? shown[k - 1] : null;
    if (up) {
      const parent = chain[k - 1];
      const nets = parent.node.children?.get(lastName(ctx))?.ports[port];
      const bus = parent.node.ports[up];
      const lo = nets ? offsetIn(bus, nets) : -1;
      if (nets && lo >= 0 && nets.length < bus.length) slice = { lo, hi: lo + nets.length - 1, of: up };
    }
    return { port, slice, read: () => ctx.portBits(port) };
  });
}

/** The breadcrumb's text for a value: `s = 0x5A`, `bit [3] = 1`, `bits [15:8] = 0x3F`. */
export function crumbText(v: CrumbValue, radix: Radix): string {
  const bits = v.read();
  const val = formatBits(bits, bits.length === 1 ? 'bin' : radix === 'bin' && bits.length > 8 ? 'hex' : radix);
  if (!v.slice) return `${v.port} = ${val}`;
  const { lo, hi } = v.slice;
  return lo === hi ? `bit [${lo}] = ${val}` : `bits [${hi}:${lo}] = ${val}`;
}

/** Repaint the breadcrumb's value elements (every frame of the stage or the look-inside view). */
export function paintCrumbVals(vals: readonly { el: HTMLElement; v: CrumbValue }[], radix: Radix): void {
  for (const { el, v } of vals) {
    const txt = crumbText(v, radix);
    if (el.textContent !== txt) el.textContent = txt;
    const bits = v.read();
    el.classList.toggle('v1', bits.length === 1 && bits[0] === B1);
    el.classList.toggle('vx', bits.some((b) => b !== B0 && b !== B1));
  }
}

/** The tooltip: which output, and where it sits in the level above. */
export function crumbTitle(v: CrumbValue, name: string, above: string): string {
  if (!v.slice) return `${name}.${v.port}`;
  const { lo, hi, of } = v.slice;
  return `${name}.${v.port}: ${lo === hi ? `bit ${lo}` : `bits ${hi}:${lo}`} of ${above}.${of}`;
}

function lastName(ctx: ViewCtx): string {
  return ctx.path[ctx.path.length - 1];
}

/** Where `part` sits as a contiguous run in `bus` (bit order kept), or -1. */
function offsetIn(bus: readonly number[] | undefined, part: readonly number[]): number {
  if (!bus || !part.length || part.length > bus.length) return -1;
  for (let o = 0; o + part.length <= bus.length; o++) {
    let ok = true;
    for (let i = 0; i < part.length && ok; i++) ok = bus[o + i] === part[i];
    if (ok) return o;
  }
  return -1;
}
