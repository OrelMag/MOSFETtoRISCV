// Which core levels a program level can run on (campaign/owncore.ts runs it): light, so the level card draws its
// switch without loading the runner. DOM-free.

import { type CoreSpec, coreSpecOf } from './corecheck';
import { levelChallenge } from './levels';
import { NODES, nodeById } from './nodes';
import type { ProgramPuzzle } from './puzzles';

/** A core level a program could run on, and why it cannot when it cannot. */
export interface CoreOption {
  id: string;
  title: string;
  /** The level is solved (its chip passed its bench). */
  solved: boolean;
  /** Why this program cannot run on this kind of core at all (a solved core still cannot). */
  why?: string;
}

/** Why a program level runs on the golden model only, or null. */
export function modelOnly(p: ProgramPuzzle): string | null {
  if (p.nic) return 'it runs on the RV32 computer with a network card: no campaign core has one';
  if (p.dma) return 'it needs the bench’s DMA engine and flash, which the core benches do not have';
  if (p.tests().some((t) => t.irqAt?.length)) return 'its tests raise interrupts at chosen instructions, which a core bench cannot time';
  return null;
}

/** Why a core level's kind of core cannot run this program, or null. */
export function unfit(p: ProgramPuzzle, s: CoreSpec): string | null {
  if (p.lanes) {
    if (!s.lanes) return 'a scalar core: this is a kernel for lanes';
    if (s.lanes !== p.lanes) return `${s.lanes} lanes, the kernel is for ${p.lanes}`;
    if (!!p.warps !== !!s.warps) return p.warps ? 'one warp: the kernel needs two' : 'a warp core: the kernel is for one warp of lanes';
    if (p.raster && !s.raster) return 'no rasterizer: the kernel draws';
    return null;
  }
  if (s.lanes) return 'a lane core: this is a scalar program';
  if (!s.rv16i) return 'it cannot run loads or branches yet';
  if (p.m && !s.m) return 'it has no multiply or divide';
  if (p.system && !s.system) return 'it has no CSRs or traps';
  return null;
}

export const specOf = (id: string): CoreSpec | null => {
  const n = nodeById(id), ch = n && levelChallenge(n);
  return ch ? coreSpecOf(ch.check) : null;
};

/** Every core level, in campaign order, with whether this program can run on it. */
export function coreOptions(p: ProgramPuzzle, solved: (id: string) => boolean): CoreOption[] {
  const only = modelOnly(p);
  const out: CoreOption[] = [];
  for (const n of NODES) {
    if (n.kind !== 'core' || n.soon) continue;
    const s = specOf(n.id);
    if (!s) continue;
    const why = only ?? unfit(p, s) ?? undefined;
    out.push({ id: n.id, title: n.title, solved: solved(n.id), ...(why ? { why } : {}) });
  }
  return out;
}
