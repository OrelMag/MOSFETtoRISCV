// The 3D models' names switch (settings.modelNames, the corner tag button, N), DOM-free: what the studio stage shows with
// names on or off. Off, no names, leaders, anchor dots, phone badges or list; the canvas keeps exactly its size and place
// (turning names off never moves the page), and the model is fitted to its whole width instead of the part between the
// gutters (a little nearer at home; a moved camera stays). Pointing at a part still names it in its card, and the chips,
// scale bar and tour caption stay.

/** Names as numbered badges + a list (a canvas too narrow to be flanked by its names). */
export const badgeForm = (width: number, measured: number, count: number, minCanvas: number): boolean =>
  width - 2 * measured < minCanvas || count === 0;

/** How the stage is framed: `size` the gutter the canvas box is sized with (the same with names on or off, so the box never
 *  moves), `fit` the gutter the model is fitted inside (none with names off: it takes the gutters' width), `badges` the
 *  phone form drawn now (never with names off). */
export function framing(on: boolean, width: number, measured: number, count: number, minCanvas: number): { size: number; fit: number; badges: boolean; form: boolean } {
  const form = badgeForm(width, measured, count, minCanvas), size = form ? 0 : measured;
  return { size, fit: on ? size : 0, badges: on && form, form };
}

/** Are names drawn now: the switch on and the tour's beat not saying otherwise. A beat cannot turn them on while the
 *  switch is off. */
export const namesShown = (on: boolean, beatLabels: boolean | undefined): boolean => on && beatLabels !== false;
