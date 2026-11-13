// EDSAC's mercury delay line for the studio renderer (DOM-free, tested). The figures and the circulating store are
// mercury3dparts.ts's (the 1948 report's tube, mercury's sound speed, the 576-slot clock); this draws them: the tank in use
// as a steel tube round a mirror-bright mercury column, opened along a quarter so the pulses show inside it, a quartz
// crystal and a brass block at each end, the backing behind the far crystal, the other fifteen tubes of the battery in a
// wooden box, and the electronics that close the loop (amplifier, reshaper, gate) with the recirculation wire lit while
// it carries the pulses round. The pulses are an instance set rewritten every frame: a disc across the bore per 1, where
// the tank's own slot positions put it.

import { lathe, merge, roundedBox, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Instance, RGB } from '../gl/instances';
import { quatAxisAngle, type Mat4, type Vec3 } from '../gl/math';
import type { OrbitView } from '../gl/camera';
import { UNIT_CYL } from '../gl/kit/fromparts';
import {
  ACTIVE, ELEC_Y, ELEC_Z, bandOf, MERC_R, mercuryAnchors, PITCH, pulseShape, SLOTS, SLOTS_PER_WORD, TUBE_R, TUBE_X0, TUBE_X1, UNIT_M, WINDOW_TOL, WORDS, xOfPos, type Tank,
} from './mercury3dparts';

const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
/** lathe's y onto world x (local x → −y: a proper rotation), at (0, y, z). */
const alongX = (y: number, z: number): Mat4 => { const m = new Float32Array(16); m.set([0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, y, z, 1]); return m; };
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo =>
  transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r > 0 ? 2 : 0), tr([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));
/** A solid rod along x from x0 to x1, radius r, its axis at (y, z). */
const rodX = (x0: number, x1: number, r: number, y: number, z: number, seg = 28): Geo => transform(lathe([[0, x0], [r, x0], [r, x1], [0, x1]], { seg, crease: 60 }), alongX(y, z));
/** A tube wall along x: outside r1, bore r0. */
const shellX = (x0: number, x1: number, r0: number, r1: number, y: number, z: number, seg = 40): Geo =>
  transform(lathe([[r1, x0], [r1, x1], [r0, x1], [r0, x0], [r1, x0]], { seg, crease: 60 }), alongX(y, z));

const mk = (o: Material): Material => M.make(o);
export const MATS = {
  steel: mk({ ...M.steel, rough: 0.32, label: 'mild steel tube (Wilkes: "constructed from mild steel tubing")' }),
  mercury: mk({ ...M.mercury, label: 'mercury' }),
  quartz: mk({ base: [0.86, 0.9, 0.92], metal: 0, rough: 0.12, coat: 0.6, label: 'quartz crystal (size and cut not in the sources)' }),
  brass: mk({ ...M.brass, label: 'end block' }),
  backing: mk({ base: [0.12, 0.12, 0.13], metal: 0, rough: 0.8, label: 'backing: absorbs the echo (material not given)' }),
  oak: mk({ ...M.oak, label: 'the battery’s box (drawn: the tanks were kept at one temperature)' }),
  chassis: mk({ base: [0.32, 0.34, 0.37], metal: 0.4, rough: 0.5, label: 'electronics chassis (drawn, not modelled)' }),
  lampOff: mk({ base: [0.35, 0.32, 0.3], metal: 0, rough: 0.4, coat: 0.5, label: 'lamp' }),
  lampOn: (tok: string): Material => mk({ base: tok as Material['base'], metal: 0, rough: 0.4, emit: tok as Material['base'], glow: 1.2, bloom: 1.5, label: 'lamp, lit' }),
  wire: mk({ base: [0.75, 0.45, 0.25], metal: 0.8, rough: 0.35, label: 'the recirculation wiring' }),
  wireLive: (tok: string): Material => mk({ base: [0.75, 0.45, 0.25], metal: 0.5, rough: 0.35, emit: tok as Material['base'], glow: 0.5, bloom: 1.3, label: 'the recirculation wiring, carrying the pulses round' }),
  window: (tok: string): Material => mk({ base: tok as Material['base'], metal: 0, rough: 0.4, emit: tok as Material['base'], glow: 0.6, label: 'the receiving window: a pulse must arrive inside it' }),
  band: (tok: string): Material => mk({ base: tok as Material['base'], metal: 0, rough: 0.3, transmit: 0.75, emit: tok as Material['base'], glow: 0.25, label: 'the word you picked' }),
};

const [, AY, AZ] = ACTIVE, EZ = ELEC_Z, BOXES = [80, 15, -50] as const;
/** The other fifteen tubes, at the battery's 4 × 4 grid. */
export const GRID = [-7.5, -2.5, 2.5, 7.5];

interface Statics { tubes: Geo; blocks: Geo; shell: Geo; mercury: Geo; ends: Geo; crystals: Geo; backing: Geo; box: Geo; chassis: Geo; wire: Geo; windowRing: Geo; slotRing: Geo; levers: Geo[] }
let memo: Statics | null = null;
function statics(): Statics {
  if (memo) return memo;
  const others: Geo[] = [], blocks: Geo[] = [];
  for (const y of GRID) for (const z of GRID) {
    if (y === AY && z === AZ) continue;
    others.push(rodX(TUBE_X0, TUBE_X1, TUBE_R, y, z, 18));
    blocks.push(bx(TUBE_X0 - 3, TUBE_X0, y - 1.6, y + 1.6, z - 1.6, z + 1.6, 0.25), bx(TUBE_X1, TUBE_X1 + 3, y - 1.6, y + 1.6, z - 1.6, z + 1.6, 0.25));
  }
  const shell = shellX(TUBE_X0, TUBE_X1, MERC_R, TUBE_R, AY, AZ);
  const mercury = rodX(TUBE_X0 + 0.2, TUBE_X1 - 0.2, MERC_R - 0.02, AY, AZ, 40);
  const ends = merge([bx(TUBE_X0 - 4, TUBE_X0 - 1.2, AY - 2.6, AY + 2.6, AZ - 2.6, AZ + 2.6, 0.4), bx(TUBE_X1 + 1.2, TUBE_X1 + 4, AY - 2.6, AY + 2.6, AZ - 2.6, AZ + 2.6, 0.4)], 'end blocks');
  const crystals = merge([rodX(TUBE_X0 - 1.2, TUBE_X0 + 0.2, MERC_R, AY, AZ), rodX(TUBE_X1 - 0.2, TUBE_X1 + 1.2, MERC_R, AY, AZ)], 'crystals');
  const backing = bx(TUBE_X1 + 4, TUBE_X1 + 9, AY - 2.2, AY + 2.2, AZ - 2.2, AZ + 2.2, 0.3);
  // the battery's box: a floor, a back and two ends, open at the front and the top so the tubes show
  const X0 = TUBE_X0 - 12, X1 = TUBE_X1 + 14, t = 1.2;
  const box = merge([bx(X0, X1, -12, -12 + t, -12, 13, 0.3), bx(X0, X1, -12, 13, -12, -12 + t, 0.3), bx(X0, X0 + t, -12, 13, -12, 13, 0.3), bx(X1 - t, X1, -12, 13, -12, 13, 0.3), bx(X0, X1, -12, -9, 13 - t, 13, 0.3)], 'box');
  const chassis = merge(BOXES.map((x) => bx(x - 10, x + 10, ELEC_Y - 4, ELEC_Y + 4, EZ - 5, EZ + 5, 0.6)), 'chassis');
  // the loop: from the receiving end down to the electronics, along them, and back up to the sending end
  const wire = tube([[TUBE_X1 + 2.6, AY, AZ + 2.2], [TUBE_X1 + 6, AY, EZ], [TUBE_X1 + 6, ELEC_Y, EZ], [TUBE_X0 - 6, ELEC_Y, EZ], [TUBE_X0 - 6, AY, EZ], [TUBE_X0 - 2.6, AY, AZ + 2.2]], 0.45, { sides: 8, bend: 2 });
  // the receiving slot (dim) and inside it the window a pulse must fall in (bright), as rings round the tube's far end
  const ring = (x0: number, x1: number, r: number) => shellX(x0, x1, TUBE_R + 0.05, TUBE_R + r, AY, AZ, 32);
  const cx = TUBE_X1 - PITCH / 2;
  const windowRing = ring(cx - WINDOW_TOL * PITCH, cx + WINDOW_TOL * PITCH, 0.35), slotRing = merge([ring(cx - PITCH / 2, cx - PITCH / 2 + 0.06, 0.25), ring(cx + PITCH / 2 - 0.06, cx + PITCH / 2, 0.25)], 'slot');
  // the gate's lever: down on the recirculation path, over to the input when writing, open when the loop is cut
  const lx = BOXES[2];
  const levers = [0, 1, 2].map((k) => tube([[lx - 6, ELEC_Y + 4, EZ + 5.2], [lx - 6 + [6, 11, 11][k] * 0.8, ELEC_Y + 4 + [3.5, 5, 7][k], EZ + 5.2]], 0.6, { sides: 8 }));
  memo = { tubes: merge(others, 'tubes'), blocks: merge(blocks, 'blocks'), shell, mercury, ends, crystals, backing, box, chassis, wire, windowRing, slotRing, levers };
  return memo;
}

const PULSE_ROT = quatAxisAngle([0, 0, 1], -Math.PI / 2);
/** A pulse: a disc across the bore at the tank's slot position, thinner and dimmer as it weakens down the tube; the
 *  picked word's pulses in their own colour. */
export function pulseInstances(tank: Tank, sel: number, pulse: RGB, chosen: RGB): Instance[] {
  const out: Instance[] = [];
  for (let L = 0; L < SLOTS; L++) {
    if (!tank.bits[L]) continue;
    const pos = tank.pos(L), { amp, width } = pulseShape(pos), x = xOfPos(pos + tank.offset * (pos / SLOTS));
    const c = Math.floor(L / SLOTS_PER_WORD) === sel ? chosen : pulse, k = 0.55 + 0.45 * amp;
    out.push({ pos: [x, AY, AZ], rot: PULSE_ROT, scale: [2 * MERC_R * 1.04, width * PITCH, 2 * MERC_R * 1.04], color: [c[0] * k, c[1] * k, c[2] * k], emissive: [c[0] * 0.9 * amp, c[1] * 0.9 * amp, c[2] * 0.9 * amp] });
  }
  return out;
}
/** The picked word's sleeve: one per segment of its band (two where it wraps round the tube's ends). */
export function bandInstances(tank: Tank, sel: number, c: RGB): Instance[] {
  return bandOf(tank, sel).map(([a, b]) => {
    const x0 = xOfPos(a) - PITCH / 2, x1 = xOfPos(b - 1) + PITCH / 2;
    return { pos: [(x0 + x1) / 2, AY, AZ] as Vec3, scale: [x1 - x0, 1, 1] as Vec3, color: c, emissive: [c[0] * 0.35, c[1] * 0.35, c[2] * 0.35] as RGB };
  });
}
export const PULSE_GEO = UNIT_CYL;
/** A sleeve of unit length along x round the tube. */
export const BAND_GEO = shellX(-0.5, 0.5, TUBE_R + 0.1, TUBE_R + 0.45, 0, 0, 28);
export const PULSE_MAT: Material = mk({ base: [1, 1, 1], metal: 0, rough: 0.4, label: 'a pulse of ultrasound (drawn as a disc across the bore)' });
export const BAND_MAT: Material = mk({ base: [1, 1, 1], metal: 0, rough: 0.5, label: 'the word you picked: its 36 slots' });

export interface MercuryState { tank: Tank; sel: number }
/** What the rebuilt model shows (the pulses and the band move as instances): rebuild when this changes. */
export const shownKey = (s: MercuryState, compact: boolean): string =>
  `${s.tank.loop} ${s.tank.access?.kind ?? ''} ${s.tank.bits[s.tank.label] === 1} ${compact}`;
export const HG_VIEWS = {
  whole: { target: [-8, -1, 12], yaw: -0.85, pitch: 0.36, dist: 235 },
  rx: { target: [100, 5, 7], yaw: 0.42, pitch: 0.42, dist: 60 },
  tx: { target: [-100, 5, 7], yaw: -0.42, pitch: 0.42, dist: 60 },
} satisfies Record<string, OrbitView>;

/** `flat`: the pulses and the band as items too, in these colours (the flat drawing has no instance sets). */
export function mercuryModel(s: MercuryState, compact = false, flat?: { pulse: RGB; chosen: RGB; band: RGB }): Model3 {
  const S = statics(), items: Item[] = [], { tank } = s, arriving = tank.bits[tank.label] === 1;
  const add = (geo: Geo, mat: Material, name: string, group: string, extra: Partial<Item> = {}) => items.push({ geo, mat, name, group, ...extra });
  const mm = (u: number) => `${(u * UNIT_M * 1000).toFixed(1)} mm`;
  add(S.shell, MATS.steel, 'steel tube', 'tank', { info: { dim: `1 in outside (${mm(TUBE_R * 2)}); the bore is drawn, not given`, source: 'Wilkes & Renwick, 1948 report, 3.1' } });
  add(S.mercury, MATS.mercury, 'mercury', 'tank', { info: { note: 'sound crosses it at about 1442 m/s at 40 °C: a pulse every 2.9 mm, the whole tube 1.152 ms long in time' } });
  add(S.crystals, MATS.quartz, 'quartz crystal', 'tank', { info: { note: 'turns a 13.5 MHz burst into ultrasound at the sending end, and back into a voltage at the receiving end' } });
  add(S.ends, MATS.brass, 'end block', 'tank', { cut: 'none' });
  add(S.backing, MATS.backing, 'backing', 'tank', { cut: 'none' });
  add(S.tubes, MATS.steel, 'the other tanks', 'battery', { cut: 'none', info: { note: 'a battery of 16; EDSAC had two batteries, 32 tanks, 512 long numbers' } });
  add(S.blocks, MATS.brass, 'the other tanks', 'battery', { cut: 'none' });
  add(S.box, MATS.oak, 'the battery’s box', 'battery', { cut: 'none' });
  if (flat) {
    const asItem = (list: Instance[], geo: Geo, name: string) => list.forEach((p) =>
      add(geo, mk({ base: p.color as RGB, metal: 0, rough: 0.4, emit: p.emissive, glow: 1, label: name }), name, 'pulses', { at: p.pos, rot: p.rot, scale: p.scale, cut: 'none' }));
    asItem(pulseInstances(tank, s.sel, flat.pulse, flat.chosen), PULSE_GEO, 'pulse');
    asItem(bandInstances(tank, s.sel, flat.band), BAND_GEO, 'the word you picked');
  }
  add(S.slotRing, MATS.window('--hg-band-b'), 'receiving slot', 'window', { cut: 'none', shadow: false });
  add(S.windowRing, MATS.window('--m3-charge'), 'receiving window', 'window', { cut: 'none', shadow: false, info: { note: `±${WINDOW_TOL.toFixed(2)} of a slot: a pulse arriving outside it is missed` } });
  add(S.chassis, MATS.chassis, 'electronics', 'loop', { cut: 'none' });
  const loopOn = tank.loop;
  add(S.wire, loopOn ? MATS.wireLive('--m3-charge') : MATS.wire, 'the loop', 'loop', { cut: 'none', info: { note: loopOn ? 'amplified, reshaped against the clock and sent again: recirculation is refresh' : 'cut: what arrives is not sent again, so the tank forgets within one circulation' } });
  BOXES.forEach((x, i) => {
    const on = i === 2 ? !tank.loop || !!tank.access : arriving && tank.loop;
    add(bx(x - 2, x + 2, ELEC_Y + 4, ELEC_Y + 5.2, EZ - 2, EZ + 2, 0.4), on ? MATS.lampOn(i === 2 && !tank.loop ? '--m3-poly' : '--m3-charge') : MATS.lampOff, ['amplifier', 'reshaper', 'gate'][i], 'loop', { cut: 'none' });
  });
  add(S.levers[tank.loop ? (tank.access?.kind === 'write' ? 1 : 0) : 2], MATS.brass, 'gate', 'loop', { cut: 'none' });

  const anchors: StudioAnchor[] = mercuryAnchors(tank, s.sel, compact).map((a) => ({ ...a }));
  const beats: Beat[] = [
    { title: 'A shift register made of sound', text: `A steel tube of mercury, ${WORDS} words of ${SLOTS_PER_WORD} pulse slots in flight at once. The tube is opened along a quarter so you can see them: each glowing disc is a 1, a burst of ultrasound crossing the bore.`, view: HG_VIEWS.whole },
    { title: 'Sent', text: 'At this end a quartz crystal turns each 0.9 µs pulse of the 13.5 MHz carrier into a burst of sound in the mercury. Fresh pulses leave clean and sharp.', view: HG_VIEWS.tx },
    { title: 'Received', text: 'At the far end the second crystal turns the sound back into a voltage, weaker and spread. It must arrive inside the bright window, within its slot of the clock; warm the tank and the train slips out of it.', view: HG_VIEWS.rx },
    { title: 'The loop is the refresh', text: 'Amplified, reshaped against the clock and sent again at the first crystal: every pulse is rewritten each 1.152 ms. Cut the loop and the train drains out of the tube in one circulation.', view: { target: [0, -2, 15], yaw: -0.3, pitch: 0.3, dist: 200 }, show: ['loop', 'tank', 'window'] },
  ];
  return { items, anchors, beats, floor: -12, look: { exposure: 1.1 },
    cuts: { planes: [{ n: [0, 1, 0], d: AY }, { n: [0, 0, 1], d: AZ }], open: [AY + TUBE_R + 1, AZ + TUBE_R + 1] } };
}
