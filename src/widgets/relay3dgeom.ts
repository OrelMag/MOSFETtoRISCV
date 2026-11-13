// The telephone relay's geometry and lever arithmetic (mm; x right, y up, z towards the viewer), shared by the
// first close-up (relay3dview.ts) and the studio model (relay3dkit.ts): every moving part placed from phys/relay.ts.

import type { Vec3 } from '../gl/math';
import { RELAY, type RelaySample } from '../phys/relay';

// ---------------------------------------------------------------- geometry (mm; x right, y up, z towards the viewer)

/** Gaps and travel drawn this many times their size at the pole (0.85 mm would not show); the contacts' gap is drawn
 *  at about ×4.6, because the stud moves 1.57× the pole's travel along a shorter lever. */
export const EXAG = 6;
export const HINGE: Vec3 = [28, 25, 0]; // the armature turns about the yoke's top corner
export const POLE_X = 0, LEVER = HINGE[0] - POLE_X; // hinge to the pole's centre
export const ARM_X0 = -47, ARM_X1 = 5, ARM_T = 2.5, ARM_W = 12; // armature, along x from the hinge
export const SPRING_LX = 3.5; // the return spring, from the hinge (behind it: pulls the armature open)
// The spring stack, along x: solder tails, pile face (the blades' root), contacts, blade tip under the stud; blade
// rest height.
export const XTAIL = -46, XR = -34, XC = -25, XT = -16, YB = 16;
export const STUD_LX = XT - HINGE[0]; // the lifting stud, from the hinge
export const BT = 0.6, BUT = 0.9, BUT_R = 1.15, TWIN_Z = 1.7; // twin dome contacts: two buttons side by side on each spring
export const POLE_R = 5.65; // a 100 mm² pole face (RELAY.A), drawn at its model area
export const POLE_AX = POLE_X - HINGE[0]; // the pole's place along the armature, from the hinge
 // blade thickness, contact button height and radius
export const STACK = 2 * (BT / 2 + BUT); // blade centre to fixed spring centre with the buttons touching

/** Armature angle (rad, opening up) for armature travel u (m): the gap at the pole, drawn ×EXAG, over the lever. */
export const theta = (u: number) => Math.atan(((RELAY.gOpen - u + RELAY.gRes) * 1e3 * EXAG) / LEVER);
/** A point given in the armature's frame (from the hinge, at angle 0), in the world. */
export const armAt = (lx: number, ly: number, th: number): [number, number] =>
  [HINGE[0] + lx * Math.cos(th) + ly * Math.sin(th), HINGE[1] - lx * Math.sin(th) + ly * Math.cos(th)];
/** How far the stud has pushed the blade's tip down for armature travel u. */
export const push = (u: number) => armAt(STUD_LX, 0, theta(0))[1] - armAt(STUD_LX, 0, theta(u))[1];
/** The contact sits part-way along the cantilever, so it moves that fraction of the tip. */
export const AT_CONTACT = (XC - XR) / (XT - XR);
export const YNC = YB + STACK, YNO = YB - STACK - push(RELAY.yc) * AT_CONTACT;
/** The NC contact opens once the blade has left it (the mockup's 0.03 mm). */
export const ncClosed = (q: RelaySample) => q.y < 0.03e-3;

