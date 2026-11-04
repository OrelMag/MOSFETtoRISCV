// The book's sections (DOM-free, first-load path): runs of consecutive chapters, shared by the map, the home page's cards and the
// chapter menu. A section names its first chapter only, so a new chapter joins the section it follows, and numbers never depend on this.

import { chapterNo } from './meta';

/** In book order: each runs from `first` up to the next one's. */
export const SECTIONS: readonly { name: string; first: string }[] = [
  { name: 'Start', first: 'basics' },
  { name: 'Prologue: before the transistor', first: 'relays' },
  { name: 'Transistors to gates', first: 'mosfet' },
  { name: 'Numbers and choices', first: 'binary' },
  { name: 'Memory from gates', first: 'latches' },
  { name: 'A single-cycle CPU', first: 'alu' },
  { name: 'Making it fast', first: 'fastadd' },
  { name: 'A complete processor', first: 'io' },
  { name: 'Beyond one core', first: 'ooo' },
  { name: 'A GPU', first: 'lanes' },
  { name: 'Memory in depth', first: 'dram' },
  { name: 'Communication', first: 'telegraph' },
  { name: 'Appendix', first: 'appendix-6502' },
];

type Sectioned = { id: string; num: number; appendix?: string; prologue?: string; label?: string };

export interface ChapterSection<C> {
  name: string;
  chapters: C[];
  /** 'prologue' in brass, 'appendix' in vintage orange, as their chapters are drawn. */
  tone: 'journey' | 'prologue' | 'appendix';
  /** The chapter numbers it spans, '01–04'; '' where they do not count (Start's). */
  range: string;
}

/** `chapters` (in book order) cut into sections. */
export function sectionsOf<C extends Sectioned>(chapters: readonly C[]): ChapterSection<C>[] {
  const out: ChapterSection<C>[] = [];
  for (const c of chapters) {
    const s = SECTIONS.find((x) => x.first === c.id);
    if (s || !out.length) out.push({ name: s?.name ?? SECTIONS[0].name, chapters: [], tone: c.appendix ? 'appendix' : c.prologue ? 'prologue' : 'journey', range: '' });
    out[out.length - 1].chapters.push(c);
  }
  for (const s of out) {
    const nos = s.chapters.map(chapterNo);
    s.range = s.chapters.some((c) => c.label) ? '' : nos.length > 1 ? `${nos[0]}–${nos[nos.length - 1]}` : nos[0];
  }
  return out;
}
