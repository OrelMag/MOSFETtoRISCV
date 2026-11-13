// When a 3D canvas takes the wheel and one-finger drags, and when the page keeps them (DOM-free; gl/orbit.ts applies it).
// A model sits in a page that scrolls: a canvas the reader has not engaged leaves the wheel and vertical swipes to the page,
// or scrolling past a 500 px canvas would zoom the model instead of moving on. Engaged = focused (a click, a tap or Tab
// focuses it; Esc, a click outside or tabbing away ends it). Ctrl / ⌘ + wheel (a trackpad pinch arrives as Ctrl + wheel)
// and full screen always zoom; two fingers always orbit and pinch.

export interface WheelState { focused: boolean; ctrl: boolean; meta: boolean; fullscreen: boolean }

/** Does this wheel turn zoom the model (and so not scroll the page)? */
export const wheelZooms = (s: WheelState): boolean => s.focused || s.ctrl || s.meta || s.fullscreen;

/** Show the "click the model, then scroll" hint: a plain wheel turn the page took, the first time on this page. */
export const wheelHint = (s: WheelState, shownAlready: boolean): boolean => !wheelZooms(s) && !shownAlready;

/** The canvas's touch-action: engaged, every gesture is the model's; otherwise a one-finger vertical swipe scrolls the page
 *  (sideways drags still turn the model, and two fingers pinch it). */
export const touchActionOf = (focused: boolean, fullscreen: boolean): 'none' | 'pan-y' => (focused || fullscreen ? 'none' : 'pan-y');

export const WHEEL_HINT = 'Click the model, then scroll to zoom · Ctrl + scroll works too';
