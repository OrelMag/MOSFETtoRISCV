// How a note or bookmark names its place (DOM-free): the chapter and step, or the saved title.

import { outlineOf } from '../chapters/outline';
import { chapterNo } from '../chapters/meta';
import type { NoteItem } from './notes';

/** "Chapter 5 · Adding three bits · step 2, Nine NANDs" for a place; chip and component titles are as saved. */
export function placeLabel(it: NoteItem): { head: string; sub: string } {
  const p = it.place;
  if (p.kind === 'step') {
    const c = outlineOf(p.chapter);
    const st = c?.steps[p.step];
    if (c) return { head: `${chapterNo(c)} · ${c.title}`.toUpperCase(), sub: `step ${p.step + 1}${st ? `, ${st.title}` : ''}` };
  }
  if (p.kind === 'bench') return { head: 'WORKBENCH', sub: it.title.replace(/^Workbench · /, '') || p.id };
  if (p.kind === 'chip') return { head: 'SANDBOX', sub: it.title.replace(/^Sandbox · /, '') || p.id };
  return { head: it.title.toUpperCase(), sub: '' };
}

/** What a note's search matches: its text, place and title. */
export const noteHaystack = (it: NoteItem): string => `${it.text} ${it.title} ${placeLabel(it).head} ${placeLabel(it).sub}`.toLowerCase();
