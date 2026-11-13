// Paper's look for a figure (print view): the attributes on <html> that shape a drawing, swapped for the length of one synchronous
// piece of work and put back before the browser can paint, so the page behind never flashes. Shared by the circuit figures
// (ui/pages/printfig.ts) and the 3D models' snapshots (widgets/modelshot.ts).

/** The attributes that shape a drawn circuit or model, and what paper wants of each (null: absent). */
export const PAPER: [string, string | null][] = [
  ['data-theme', 'light'], ['data-palette', 'print'], ['data-modules', 'plain'], ['data-wireflow', 'off'],
  ['data-netcolors', null], ['data-look', null], ['data-board', null], ['data-parts', null], ['data-wires', null], ['data-hide', null], ['data-lens-fill', null],
  // (print.css: no transitions meanwhile, or a wire whose class just changed to 1 is read still on its way from 0's grey)
  ['data-paper', ''],
];

/** Run `fn` with <html> dressed for paper; the learner's attributes are back when it returns. */
export function onPaper<T>(fn: () => T): T {
  const root = document.documentElement;
  const saved = PAPER.map(([a]) => root.getAttribute(a));
  for (const [a, v] of PAPER) { if (v === null) root.removeAttribute(a); else root.setAttribute(a, v); }
  try {
    return fn();
  } finally {
    PAPER.forEach(([a], i) => { const v = saved[i]; if (v === null) root.removeAttribute(a); else root.setAttribute(a, v); });
  }
}
