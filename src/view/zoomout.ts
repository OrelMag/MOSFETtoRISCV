// Zoom out to go up (docs/transparent/DESIGN.md item 9, phase 2e), DOM-free so tests can feed it recorded wheel traces.
// After the zoom lens handed a level off to a drill, zooming back out to fit shows a cue ("Keep zooming out to go up to
// cpu"); only a fresh gesture after it goes up one level:
// - wheel: a zoom-out event (deltaY > 0) after the cue came up, and after at least FRESH_MS with no wheel event at all.
//   A trackpad's momentum keeps sending events every frame for a second or more after the fingers leave, never with
//   such a gap, so a fling that brought the view to fit (and the cue up) never carries on into the parent; a mouse
//   notched slowly pops on a notch after the cue, which is what a deliberate notch is;
// - pinch: a pinch that starts after the cue and closes the fingers by PINCH_OUT (the one that brought the cue up is not
//   fresh, however long it goes on).
// One pop per cue: the parent's lens takes the gesture's rest.

export const FRESH_MS = 400;
/** A pinch closing the fingers to this fraction of their spread since it began is a zoom-out. */
export const PINCH_OUT = 0.9;

export class ZoomOutGate {
  private lastWheel = -Infinity;
  private cueAt: number | null = null;
  private pinch: { k: number; fresh: boolean } | null = null;

  /** The cue is on screen (from `t`, ms); again while shown changes nothing. */
  cue(t: number): void {
    if (this.cueAt === null) this.cueAt = t;
  }

  /** The cue went away (a pop, another level, the setting off). */
  clear(): void {
    this.cueAt = null;
    this.pinch = null;
  }

  get cued(): boolean {
    return this.cueAt !== null;
  }

  /** A wheel event at `t` (ms, the event's timeStamp): true when it pops a level. Every event is recorded, popping or not. */
  wheel(t: number, deltaY: number): boolean {
    const gap = t - this.lastWheel;
    this.lastWheel = t;
    // `t > cueAt`: the event that zoomed the view out to fit and so raised the cue (it is handled first) is not fresh, even
    // when it came after a pause
    if (this.cueAt === null || !(deltaY > 0) || gap < FRESH_MS || !(t > this.cueAt)) return false;
    this.clear();
    return true;
  }

  /** A pinch step at `t`: `k` its scale this step (> 1 spreads), `start` its first step. True when it pops a level. */
  pinchStep(t: number, k: number, start: boolean): boolean {
    if (start || !this.pinch) this.pinch = { k: 1, fresh: this.cueAt !== null && t >= this.cueAt };
    this.pinch.k *= k;
    if (this.cueAt === null || !this.pinch.fresh || this.pinch.k > PINCH_OUT) return false;
    this.clear();
    return true;
  }

  /** The pinch's fingers lifted. */
  pinchEnd(): void {
    this.pinch = null;
  }
}
