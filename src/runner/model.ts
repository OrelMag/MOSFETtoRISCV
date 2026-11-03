// Appendix D's game, Bit Runner, clock by clock (DOM-free): the reference the gates of lib/bitrunner.ts follow, every
// register and every video pin at every rising edge (tests/bitrunner.test.ts). The game is an original design: you
// are one bit, walls of gates scroll towards you, and a gate passes only a bit of its own colour. There is no position
// register for anything that moves. A wall or the player is a counter that drifts against the beam, because its period
// differs from the line's or the frame's by a count.

/** Pixels and lines in all, and on screen. */
export const RB_LINE = 72, RB_FRAME = 52, RB_W = 64, RB_H = 48;
export const RB_CLOCKS = RB_LINE * RB_FRAME;
/** The playfield's lines; the status band is below it. */
export const RB_FIELD = 40;
/** The wall counter's period in clocks (it divides the line, so a wall stands still until it slips), and its load value. */
export const RB_WALL_PERIOD = 36, RB_WALL_LOAD = 64 - RB_WALL_PERIOD;
/** The player's counter: its load value makes a period of one frame in lines. */
export const RB_PLAYER_LOAD = 64 - RB_FRAME;

export interface RbInputs { up: number; down: number; flip: number; start: number }
export interface RbVideo { white: number; amber: number; cyan: number; hsync: number; vsync: number }

/** Segments a…g as a mask (bit 0 = a) of one BCD digit, by the equations the font's gates compute. */
export function segments(d: number): number {
  const d3 = (d >> 3) & 1, d2 = (d >> 2) & 1, d1 = (d >> 1) & 1, d0 = d & 1;
  const n2 = 1 - d2, n1 = 1 - d1, n0 = 1 - d0;
  const a = d3 | d1 | (d2 & d0) | (n2 & n0);
  const b = n2 | (1 - (d1 ^ d0));
  const c = d2 | n1 | d0;
  const dd = d3 | (n2 & n0) | (d1 & n0) | (n2 & d1) | (d2 & n1 & d0);
  const e = (n2 & n0) | (d1 & n0);
  const f = d3 | (n1 & n0) | (d2 & n1) | (d2 & n0);
  const g = d3 | (d2 & n1) | (n2 & d1) | (d1 & n0);
  return a | b << 1 | c << 2 | dd << 3 | e << 4 | f << 5 | g << 6;
}

/** A pixel of a 3 × 5 digit from its segments: row 0–4, column 0–2. */
export function digitPixel(segs: number, row: number, col: number): number {
  const s = (i: number) => (segs >> i) & 1;
  const [a, b, c, d, e, f, g] = [0, 1, 2, 3, 4, 5, 6].map(s);
  if (col === 1) return row === 0 ? a : row === 2 ? g : row === 4 ? d : 0;
  if (col === 0) return [a | f, f, g | e | f, e, d | e][row];
  return [a | b, b, g | b | c, c, d | c][row];
}

export interface RbState {
  h: number; v: number; f: number;
  wc: number; w: number; armed: number;
  lfsr: number; gapA: number; gapB: number;
  py: number; bit: number; flipPrev: number;
  run: number; ghost: number; lives: number;
  ones: number; tens: number;
}

export class BitRunnerModel {
  s: RbState = { h: 0, v: 0, f: 0, wc: 0, w: 0, armed: 0, lfsr: 0, gapA: 0, gapB: 0, py: 0, bit: 0, flipPrev: 0, run: 0, ghost: 0, lives: 0, ones: 0, tens: 0 };

  /** This wall's gate: does the beam stand in it on this line (the two walls take turns on one comparator)? */
  private gate(): { inGap: boolean; colour: number } {
    const { v, w, gapA, gapB, tens } = this.s;
    const gs = w ? gapB : gapA;
    const diff = ((v >> 2) - (gs & 7)) & 15;
    const inGap = diff < 4 && !(tens >= 2 && diff === 3) && !(tens >= 4 && (diff & 2) !== 0);
    return { inGap, colour: gs >> 3 };
  }

  video(): RbVideo {
    const { h, v, f, wc, py, bit, ghost, lives, ones, tens } = this.s;
    const active = h < RB_W && v < RB_H, field = v < RB_FIELD;
    const { inGap, colour } = this.gate();
    const wf = wc >= 60 && field;
    const pv = h >= 12 && h <= 15 && py >= 60 && field && !(ghost && f);
    const door = wf && inGap && (wc & 1) === ((wc >> 1) & 1);
    let px = v === RB_FIELD ? 1 : 0;
    if (v >= 42 && v <= 46 && h < 16) {
      const digit = h >= 4 && h <= 6 ? tens : h >= 8 && h <= 10 ? ones : -1;
      if (digit >= 0) px |= digitPixel(segments(digit), v - 42, h & 3);
    }
    if ((v === 42 || v === 43) && h >= 52 && h < 64 && (h & 2) === 0) {
      const pip = ((h >> 2) & 3) - 1;
      if (lives <= 2 - pip) px = 1;
    }
    const on = (x: boolean | number) => (active && x ? 1 : 0);
    return {
      white: on((wf && !inGap) || px),
      amber: on((door && colour === 0) || (pv && bit === 0)),
      cyan: on((door && colour === 1) || (pv && bit === 1)),
      hsync: h >= 68 ? 1 : 0,
      vsync: v >= 50 ? 1 : 0,
    };
  }

  /** One rising clock edge, with these inputs held before it. Every next value comes from the values before the edge. */
  step(i: RbInputs): void {
    const s = this.s;
    const hEnd = s.h === RB_LINE - 1, vEnd = s.v === RB_FRAME - 1, frameEnd = hEnd && vEnd;
    const wrap = s.wc === 63, line50 = s.v === 50;
    const slipFrame = s.tens > 0 || s.f === 1;
    const { inGap, colour } = this.gate();
    const pxWin = s.h >= 12 && s.h <= 15, pyWin = s.py >= 60;
    const crash = !!s.run && !s.ghost && pxWin && pyWin && s.wc >= 60 && s.v < RB_FIELD && !(inGap && s.bit === colour);
    const tick = wrap && s.h === 11 && line50 && slipFrame;
    const inc = tick && !!s.run && !s.ghost;
    const load = line50 && s.wc === 60 && s.h >= 64 && s.h <= 68;
    const U = !!s.run && !!i.up && (s.v >> 2) !== 0;
    const D = !!s.run && !!i.down && s.v < 36 && !U;

    const n: RbState = { ...s };
    n.h = hEnd ? 0 : s.h + 1;
    n.v = hEnd ? (vEnd ? 0 : s.v + 1) : s.v;
    n.f = s.f ^ (frameEnd ? 1 : 0);
    n.armed = (line50 && hEnd && slipFrame) || (s.armed && !wrap) ? 1 : 0;
    n.wc = wrap ? RB_WALL_LOAD | s.armed : s.wc + 1;
    n.w = s.w ^ (wrap ? 1 : 0);
    n.lfsr = ((s.lfsr << 1) | (1 ^ ((s.lfsr >> 7) ^ (s.lfsr >> 5) ^ (s.lfsr >> 4) ^ (s.lfsr >> 3)) & 1)) & 255;
    if (load && !s.w) n.gapA = s.lfsr & 15;
    if (load && s.w) n.gapB = s.lfsr & 15;
    if (hEnd) n.py = s.py === 63 ? RB_PLAYER_LOAD + (U ? 1 : 0) - (D ? 1 : 0) : s.py + 1;
    n.bit = s.bit ^ (i.flip && !s.flipPrev ? 1 : 0);
    n.flipPrev = i.flip ? 1 : 0;
    n.run = i.start || (s.run && s.lives !== 3) ? 1 : 0;
    n.ghost = !i.start && (crash || (s.ghost && !tick)) ? 1 : 0;
    n.lives = i.start ? 0 : (s.lives + (crash ? 1 : 0)) & 3;
    if (i.start) { n.ones = 0; n.tens = 0; }
    else if (inc) {
      if (s.ones === 9) { n.ones = 0; n.tens = s.tens === 9 ? 0 : s.tens + 1; }
      else n.ones = s.ones + 1;
    }
    this.s = n;
  }
}
