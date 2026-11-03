// Which wording a screen gets (DOM-free, so tests can pick without a browser): the callers pass
// coarsePointer() (ui/dom.ts: touch is the main pointer) and whether the sandbox's palette is a drawer.

/** How a part gets onto the canvas: tapped in a drawer and tapped on the canvas, picked in the drawer (narrow window,
 *  mouse) and clicked, or dragged out of the palette beside the canvas. */
export type PlaceMode = 'tap' | 'drawer' | 'drag';

export const placeMode = (coarse: boolean, narrow: boolean): PlaceMode => (coarse ? 'tap' : narrow ? 'drawer' : 'drag');
