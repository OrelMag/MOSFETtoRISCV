// The words of the stage's feedback notes (ui/stagenotes.ts), DOM-free: a chapter's challenge card and its "Try"
// boxes sit in the text panel, often below its fold (or above the stage on a phone), while the learner works on the
// circuit, so the stage repeats the goal and says when something was achieved.

/** `text` on one short line: whitespace collapsed, cut at a word boundary with an ellipsis when longer than `max`. */
export function oneLine(text: string, max = 90): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

/** What the stage announces when a reach challenge becomes solved. */
export const solvedNote = (goal: string): string => `Challenge solved: ${oneLine(goal, 140)}`;

/** What the stage shows (and announces) when a "Try" box ticks itself. */
export const triedNote = (text: string): string => `Done: ${oneLine(text, 80)}`;
