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
  { name: 'Communication: wires and clocks', first: 'message' },
  { name: 'Communication: the channel', first: 'signals' },
  { name: 'Communication: getting it right', first: 'errors' },
  { name: 'Communication: networks', first: 'ethernet' },
  { name: 'Communication: the air and the bench', first: 'radio' },
  { name: 'Signal processing: arithmetic and filters', first: 'fixed' },
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
export function sectionsOf<C extends Sectioned>(chapters: readonly C[], sections: readonly { name: string; first: string }[] = SECTIONS): ChapterSection<C>[] {
  const out: ChapterSection<C>[] = [];
  for (const c of chapters) {
    const s = sections.find((x) => x.first === c.id);
    if (s || !out.length) out.push({ name: s?.name ?? sections[0].name, chapters: [], tone: c.appendix ? 'appendix' : c.prologue ? 'prologue' : 'journey', range: '' });
    out[out.length - 1].chapters.push(c);
  }
  for (const s of out) {
    // a chapter shown by its label, or with no number, sits in its section without counting for the range (an on-ramp, Start's)
    const nos = s.chapters.filter((c) => !c.label && (c.num || c.prologue)).map(chapterNo);
    s.range = nos.length > 1 ? `${nos[0]}–${nos[nos.length - 1]}` : nos[0] ?? '';
  }
  return out;
}
