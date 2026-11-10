// The Baby as a sandbox part ({ baby: { src } }): lib/baby.ts's babyComputer with the program in its store, written in the
// Baby's assembly (ssem/asm.ts) and held in the document like a ROM's program, so a reload, a copy and a share link rebuild
// the same machine (the library id of a Baby with a program is a hash of its words, which nothing could invert).

import { assembleSsem } from '../ssem/asm';
import { babyComputer } from '../lib/baby';
import type { ComponentDef } from '../sim/types';
import type { PartRef } from './model';

/** The longest program text a part holds (32 lines of a few characters, with comments). */
export const BABY_SRC_MAX = 4000;

/** The part for a program, or the first error in it. */
export function babyRefDef(src: string): ComponentDef | { error: string } {
  if (typeof src !== 'string' || src.length > BABY_SRC_MAX) return { error: `Baby: the program is at most ${BABY_SRC_MAX} characters` };
  const r = assembleSsem(src);
  if (r.errors.length) return { error: `Baby program, line ${r.errors[0].line}: ${r.errors[0].message}` };
  return babyComputer(r.words);
}

/** A stored ref, if its program is text that fits. */
export function sanitizeBabyRef(o: { src?: unknown }): PartRef | null {
  return typeof o.src === 'string' && o.src.length <= BABY_SRC_MAX ? { baby: { src: o.src } } : null;
}
