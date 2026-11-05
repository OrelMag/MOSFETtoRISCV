// The light side of the chapters (DOM-free, no imports): what navigation, search, the progress counts, the notes' place labels
// and the home page's cards read without the chapters' code. The data is chapters/manifest.ts, generated from the chapters by
// scripts/chapter-manifest.ts (tests/chapter-manifest.test.ts fails when it drifts); a chapter's own module loads on demand
// (chapters/load.ts). Nothing here may import types.ts, the chapter modules or the library: this is the first-load path.

/** What every place that lists a chapter needs. */
export interface ChapterHead {
  id: string;
  /** numOf(id) (chapters/order.ts places the chapter); an appendix chapter continues the count but is shown by its letter. */
  num: number;
  appendix?: string;
  prologue?: string;
  label?: string;
  title: string;
  blurb: string;
  level: string;
  /** Chapters it builds on (ids): an optional chapter named here counts as read by this one's reader (chapters/firstuse.ts). */
  builds?: string[];
}

/** One step as the outline knows it. Extend here (and in scripts/chapter-manifest.ts) for anything else a list needs per step. */
export interface StepMeta {
  title: string;
  /** The step has a check: a reach challenge or a quiz (settings.solved key `<chapter>:<step>`). */
  challenge?: 'reach' | 'quiz';
}

export interface ChapterMeta extends ChapterHead {
  /** The recap (the step after the last): how many Check-yourself questions it has. */
  recap?: { checks: number };
  steps: StepMeta[];
}

/** How a chapter is numbered on screen: 07, P1 for a prologue chapter, A for an appendix. */
export const chapterNo = (c: { num: number; appendix?: string; prologue?: string; label?: string }): string => c.label ?? c.prologue ?? c.appendix ?? String(c.num).padStart(2, '0');

/** Planned chapters, shown greyed out on the map. */
export interface FutureChapter {
  num: number;
  title: string;
  blurb: string;
  level: string;
}
