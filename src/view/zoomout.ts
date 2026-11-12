// Zoom out to go up (docs/transparent/DESIGN.md, revision 3), DOM-free so tests can feed it wheel traces.
// After stepping into a box, zooming back out has two states, both said in a status line under the crumb:
//   1. the level does not fit yet: "Zoom out to see all of alu, then once more to go up to cpu", with a bar (progress)
//      from the scale the level was entered at to the fit scale;
//   2. it fits (the extent within the free area, or smaller): the crumb's parent becomes "▲ up to cpu" and the line
//      says "Zoom out once more to go up to cpu" (cue). The next deliberate zoom-out goes up a level.
// Deliberate means:
// - wheel: a zoom-out event (deltaY > 0) after at least FRESH_MS with no wheel event at all. A trackpad's momentum
//   keeps sending events every frame for a second or more after the fingers leave, never with such a gap, so a fling
//   that brought the view to fit never carries on into the parent; a mouse notch after a pause is deliberate;
// - pinch: a pinch that starts after the cue and closes the fingers to PINCH_OUT of their spread (the pinch that
//   brought the cue up is not fresh, however long it goes on);
// - key: the `−` key or the zoom-out button, one press each (no momentum).
// Never the event that raised the cue (it is handled before the cue shows: t > cueAt). One "up" per cue.

export const FRESH_MS = 400;
/** A pinch closing the fingers to this fraction of their spread since it began is a zoom-out. */
export const PINCH_OUT = 0.9;

export type GateResult = 'up' | null;

export class ZoomOutGate {
  private lastWheel = -Infinity;
  private cueAt: number | null = null;
  private pinchRun: { k: number; fresh: boolean } | null = null;

  /** The level fits (state 2) from `t` (ms); again while it fits changes nothing. */
  cue(t: number): void {
    if (this.cueAt === null) this.cueAt = t;
  }

  /** It no longer fits (a zoom in), another level, the setting off, or it went up. */
  clear(): void {
    this.cueAt = null;
    this.pinchRun = null;
  }

  get cued(): boolean {
    return this.cueAt !== null;
  }

  private up(t: number): GateResult {
    if (this.cueAt === null || !(t > this.cueAt)) return null;
    this.clear();
    return 'up';
  }

  /** A wheel event at `t` (ms, the event's timeStamp). Every event is recorded, whatever it returns. */
  wheel(t: number, deltaY: number): GateResult {
    const gap = t - this.lastWheel;
    this.lastWheel = t;
    return deltaY > 0 && gap >= FRESH_MS ? this.up(t) : null;
  }

  /** A pinch step at `t`: `k` its scale this step (> 1 spreads), `start` its first step. */
  pinch(t: number, k: number, start: boolean): GateResult {
    if (start || !this.pinchRun) this.pinchRun = { k: 1, fresh: this.cueAt !== null && t > this.cueAt };
    this.pinchRun.k *= k;
    return this.pinchRun.fresh && this.pinchRun.k <= PINCH_OUT ? this.up(t) : null;
  }

  /** The pinch's fingers lifted. */
  pinchEnd(): void {
    this.pinchRun = null;
  }

  /** The `−` key or the stage bar's zoom-out button at `t`. */
  key(t: number): GateResult {
    return this.up(t);
  }
}

/**
 * State 1's bar: how far the zoom-out has come from `from` (the scale the level was entered at) to `fitScale`, on a log
 * scale (each wheel notch moves it alike), 0 … 1; 1 at fit or below. Scales are screen px per grid unit.
 */
export function progress(scale: number, fitScale: number, from: number): number {
  if (!(scale > fitScale) || !(fitScale > 0)) return 1;
  if (!(from > fitScale)) return 0;
  return Math.min(1, Math.max(0, Math.log(from / scale) / Math.log(from / fitScale)));
}

/** The status line's words (the crumb's parent turns into "▲ up to <parent>" in state 2). */
export function cueWords(level: string, parent: string, fits: boolean): string {
  return fits ? `Zoom out once more to go up to ${parent}` : `Zoom out to see all of ${level}, then once more to go up to ${parent}`;
}
