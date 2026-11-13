// The 3D models' names switch (settings.modelNames, the corner tag button, N), DOM-free: what the studio stage shows with
// names on or off. Off, no names, leaders, anchor dots, phone badges or list, and the canvas takes the gutters' width
// back; pointing at a part still names it in its card (that is how you ask), and the chips, scale bar and tour caption
// stay.

/** The gutters' width: the measured one with names on, none with them off. */
export const gutterOf = (on: boolean, measured: number): number => (on ? measured : 0);

/** Names as numbered badges + a list (a canvas too narrow to be flanked by its names): only while names are on. */
export const badgeForm = (on: boolean, width: number, measured: number, count: number, minCanvas: number): boolean =>
  on && (width - 2 * measured < minCanvas || count === 0);

/** Are names drawn now: the switch on and the tour's beat not saying otherwise. A beat cannot turn them on while the
 *  switch is off. */
export const namesShown = (on: boolean, beatLabels: boolean | undefined): boolean => on && beatLabels !== false;
