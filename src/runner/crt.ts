// A monitor on Bit Runner's pins (DOM-free): it knows only sync and video, as a real one does. The beam moves a pixel a
// clock; the falling edge of hsync starts a line, the falling edge of vsync the frame.

import { RB_H, RB_W, type RbVideo } from './model';

/** A pixel: 0 dark, 1 white, 2 amber, 3 cyan (colour wins where you stand in a wall). */
export const pixelOf = (v: RbVideo): number => (v.amber ? 2 : v.cyan ? 3 : v.white ? 1 : 0);

export class Crt {
  x = 0;
  y = 0;
  frames = 0;
  px = new Uint8Array(RB_W * RB_H);
  private hs = 0;
  private vs = 0;

  /** One clock's pins, as they stand after the edge. */
  scan(v: RbVideo): void {
    if (this.hs && !v.hsync) { this.x = 0; this.y++; }
    if (this.vs && !v.vsync) { this.x = 0; this.y = 0; this.frames++; }
    this.hs = v.hsync;
    this.vs = v.vsync;
    if (this.x < RB_W && this.y < RB_H) this.px[this.y * RB_W + this.x] = pixelOf(v);
    this.x++;
  }
  save() { return { x: this.x, y: this.y, frames: this.frames, px: this.px.slice(), hs: this.hs, vs: this.vs }; }
  restore(s: ReturnType<Crt['save']>): void {
    this.x = s.x; this.y = s.y; this.frames = s.frames; this.px = s.px.slice(); this.hs = s.hs; this.vs = s.vs;
  }
}
