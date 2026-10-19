// Which of the sandbox's toolbar actions go into its "More" menu when the top bar is too narrow for
// all of them (DOM-free: editor.ts measures, this decides; tests/editor-toolbarfit.test.ts).
//
// Without it the actions kept their width and the chip tabs beside them shrank and scrolled: at
// 1440 px "+ New chip" was cut to "New chi" under the autosave indicator; on a phone the actions
// wrapped into four rows above the canvas.

/** The order actions leave the bar in, least used first; ids not listed (later plugins) go before these. */
export const SHED_ORDER: readonly string[] = [
  'help', 'type', 'screens', 'inspect', 'puzzles', 'package', 'timing', 'probe', 'examples', 'challenges',
  'zout', 'zin', 'cpu', 'iobar', 'fit', 'redo', 'undo', 'props', 'file',
];

/**
 * The actions to move into More so that the rest, and the More button, fit in `room` px.
 * `items`: the actions in bar order with their widths; `gap`: the space between two buttons.
 */
export function shedActions(items: readonly { id: string; w: number }[], room: number, moreW: number, gap: number): Set<string> {
  const shed = new Set<string>();
  if (!items.length) return shed;
  let width = items.reduce((s, it) => s + it.w, 0) + gap * (items.length - 1);
  if (width <= room + 0.5) return shed;
  const rank = (id: string) => SHED_ORDER.indexOf(id);
  // unlisted first (the rightmost of them first), then the listed in their order
  const queue = items.map((it, i) => ({ ...it, i })).sort((a, b) => rank(a.id) - rank(b.id) || b.i - a.i);
  width += gap + moreW;
  for (const it of queue) {
    if (width <= room + 0.5) break;
    shed.add(it.id);
    width -= it.w + gap;
  }
  return shed;
}
