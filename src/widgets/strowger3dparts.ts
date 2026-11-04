// The Strowger selector as parts (DOM-free, tested): a shaft that rises one level per pulse, a wiper that turns over the
// 10 contacts of that level, the bank behind it, the two magnets and the base. Level and line are numbers (fractional
// while moving) so the drawing follows phys/strowger.ts exactly: at rest the wiper tip sits on a contact's centre.

import type { RGB } from '../gl/instances';
import { quatAxisAngle, type Vec3 } from '../gl/math';
import { box, cyl, rod, wire, type Anchor, type Part } from '../gl/parts';
import { LEVELS, LINES, type State } from '../phys/strowger';

export const R = 24, PITCH = 5, FIRST = -70, SPREAD = 140;
export interface SwPose { level: number; line: number; vmag: boolean; rmag: boolean }
export interface SwPalette { frame: RGB; shaft: RGB; brass: RGB; free: RGB; busy: RGB; live: RGB; coil: RGB; lit: RGB; probe: RGB }

const rad = (d: number) => (d * Math.PI) / 180;
/** The wiper's height at a (fractional) level; level 0 is rest. */
export const levelY = (level: number): number => 4 + PITCH * level;
/** A line's angle in degrees from straight back; line 0 is the rest position beside the first contact. */
export const lineAngle = (line: number): number => FIRST + (SPREAD / (LINES - 1)) * (line - 1);
const at = (deg: number, r: number, y: number): Vec3 => [r * Math.sin(rad(deg)), y, -r * Math.cos(rad(deg))];
/** The centre of the contact of a line on a level (1-based). */
export const contactAt = (level: number, line: number): Vec3 => at(lineAngle(line), R, levelY(level));
/** Where the wiper's tip is. */
export const wiperTip = (p: Pick<SwPose, 'level' | 'line'>): Vec3 => at(lineAngle(p.line), R, levelY(p.level));

const lit = (c: RGB, k = 0.5): RGB => [c[0] * k, c[1] * k, c[2] * k];

export function swParts(p: SwPose, s: State, busy: readonly (readonly boolean[])[], P: SwPalette): Part[] {
  const out: Part[] = [], yw = levelY(p.level);
  // Base, with the shaft sliding in it at rest.
  out.push(cyl(P.frame, 0, 0, -20, 0, 31, 0.1));
  // The bank: a contact for every line of every level, free, busy, or the one the call is on.
  for (let l = 1; l <= LEVELS; l++) for (let j = 1; j <= LINES; j++) {
    const here = s.mode === 'connected' && s.level === l && s.line === j, bad = busy[l - 1]?.[j - 1];
    const c = box(here ? P.live : bad ? P.busy : P.free, -0.9, 0.9, -1.3, 1.3, -0.7, 0.7);
    out.push({ ...c, pos: contactAt(l, j), rot: quatAxisAngle([0, 1, 0], -rad(lineAngle(j))), emissive: here ? lit(P.live) : bad ? lit(P.busy, 0.25) : undefined });
  }
  for (const d of [-80, 0, 80]) { const [x, , z] = at(d, R + 2.6, 0); out.push(cyl(P.frame, x, z, 0, levelY(LEVELS) + 4, 0.7, 0.1)); }
  out.push(...wire(P.frame, Array.from({ length: 17 }, (_, i) => at(-80 + 10 * i, R + 2.6, levelY(LEVELS) + 4)), 0.6, 0.1));
  // The shaft, rings to show it sliding, the hub and the wiper arm.
  out.push(cyl(P.shaft, 0, 0, yw - 20, yw + 8, 1.3, 0.6));
  for (let i = 0; i < 7; i++) out.push(cyl(P.shaft, 0, 0, yw - 18 + 4 * i, yw - 17.4 + 4 * i, 2, 0.6));
  out.push(cyl(P.brass, 0, 0, yw - 1.5, yw + 1.5, 2.4, 0.5));
  const tip = wiperTip(p), live = s.mode === 'connected' && p.line === s.line;
  out.push(rod(P.brass, [0, yw, 0], tip, 0.45, 0.5));
  out.push({ ...box(live ? P.live : P.probe, -0.8, 0.8, -1.8, 1.8, -0.6, 0.6), pos: tip, rot: quatAxisAngle([0, 1, 0], -rad(lineAngle(p.line))), emissive: lit(live ? P.live : P.probe, 0.4) });
  // The two magnets in front: vertical on the left, rotary on the right; a coil glows while it pulls.
  for (const [x, on] of [[-15, p.vmag], [15, p.rmag]] as const) {
    out.push(box(P.frame, x - 4.5, x + 4.5, 0, 3, 8, 16), cyl(on ? P.lit : P.coil, x, 12, 3, 13, 3.4, 0.3), box(P.shaft, x - 4, x + 4, 13, 14.5, 9, 15, 0.4));
    if (on) out[out.length - 2].emissive = lit(P.lit, 0.6);
  }
  return out;
}

export function swAnchors(p: SwPose): Anchor[] {
  const front: Vec3 = [0, 0.3, 1], up: Vec3 = [0, 1, 0];
  return [
    { text: 'shaft', p: [0, levelY(p.level) + 8, 0], side: 't', n: up },
    { text: 'wiper', p: wiperTip(p), side: 'r', n: front },
    { text: 'contact bank', p: contactAt(LEVELS, 5), side: 't', n: front },
    { text: 'vertical magnet', p: [-15, 15, 12], side: 'l', n: front },
    { text: 'rotary magnet', p: [15, 15, 12], side: 'r', n: front },
    { text: 'base', p: [0, -10, 31], side: 'b', n: front },
  ];
}
