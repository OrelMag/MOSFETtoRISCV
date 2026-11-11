// A toolbar toggle that saves the open chip in My notes (ui/notes.ts); the page lists it with the learner's other places.

import { notes, type Place } from '../ui/notes';
import { type Editor, registerToolbarAction } from './editor';

const placeOf = (ed: Editor): Place => ({ kind: 'chip', id: ed.chipId });

registerToolbarAction({
  id: 'bookmark', title: 'Bookmark this chip in My notes', icon: 'bookmark', menu: 'Bookmark this chip', order: 95,
  run: (ed) => {
    notes().toggleBookmark(placeOf(ed), `Sandbox · ${ed.doc.name}`);
    ed.renderActions();
  },
  active: (ed) => notes().isBookmarked(placeOf(ed)),
});
