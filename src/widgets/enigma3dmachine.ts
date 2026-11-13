// The whole M4, in the pose a view asks for (DOM-free, tested): enigma3dparts.ts's machine and enigma3dextras.ts's insides and
// accessories put together, with their labels.

import type { Vec3 } from '../gl/math';
import type { Anchor, Part } from '../gl/parts';
import { boxParts, BOX_AT, currentParts, insideParts, printerParts, PRN_BASE } from './enigma3dextras';
import { AX_Y, AX_Z, caseParts, coverParts, ETW_FACE, FACE_Z, keyboardParts, lampParts, lidParts, PANEL_Y, pawlParts, plugboardParts, RIM_R, RIM_X, stackLift, stackParts, stackX, type EnigmaPalette, type EnigmaPose } from './enigma3dparts';

export function enigmaParts(p: EnigmaPose, P: EnigmaPalette): Part[] {
  const out: Part[] = [];
  caseParts(out, p, P);
  keyboardParts(out, p, P);
  plugboardParts(out, p, P);
  if (!p.printer) lampParts(out, p, P);
  if (p.inside || p.lamps > 0.02) insideParts(out, p, P);
  coverParts(out, p, P);
  stackParts(out, p, P);
  pawlParts(out, p, P);
  if (!p.bare && !p.printer) lidParts(out, p, P);
  if (p.printer) printerParts(out, p, P);
  if (p.box) boxParts(out, p, P);
  if (p.trace && p.out < 0.02 && p.inside) currentParts(out, p.trace, p, P);
  return out.filter((q) => (q.scale ?? [1, 1, 1]).every((v) => v > 0));
}

export function enigmaAnchors(p: EnigmaPose): Anchor[] {
  const up: Vec3 = [0, 1, 0], lift = stackLift(p.out), sx = (x: number) => stackX(x, p.out), a: Anchor[] = [];
  if (p.printer) {
    a.push({ text: 'Schreibmax', p: [-18, 240, -32], side: 'l', n: [0, 0, 1] }, { text: 'Print wheel', p: [66, 184, -26], side: 'l', n: [0, 0, 1] }, { text: 'The paper strip', p: [-110, PRN_BASE + 1, -8], side: 't', n: up });
    a.push({ text: 'Keyboard', p: [131, 62, 80], side: 'r', n: up });
    return a;
  }
  if (p.box) a.push({ text: 'Spare wheels', p: [BOX_AT[0], 120, BOX_AT[2] - 20], side: 't', n: up });
  if (p.inside) {
    a.push({ text: 'Key switches', p: [-122, 33, 60], side: 'l', n: up }, { text: 'Cloth loom', p: [117, 17, 20], side: 'r', n: [1, 0, 0] });
    a.push({ text: 'Lamp plate', p: [-116, 80, -30], side: 'l', n: up });
    a.push({ text: 'Plugboard’s back', p: [-132, 30, FACE_Z - 3], side: 'l', n: [-1, 0, 0] });
    a.push({ text: 'Battery', p: [97, 93, -105], side: 'r', n: up, minor: true });
    return a;
  }
  if (p.lid > 0.5) {
    a.push({ text: 'Lamps', p: [-130, 94, 5], side: 'l', n: up }, { text: 'Keyboard', p: [131, 62, 80], side: 'r', n: up });
    if (p.flap > 0.5) a.push({ text: 'Plugboard sockets', p: [132, 30, FACE_Z], side: 'r', n: [0, 0, 1] });
  }
  if (p.cover > 0.5) {
    const y = AX_Y + lift + RIM_R, back = AX_Z - 44;
    a.push({ text: p.settings.reflector === 'D' ? 'UKW-D: in place of both' : 'Reflector', p: [sx(-98), y - 6, AX_Z], side: 'l', n: up });
    if (p.settings.reflector !== 'D') a.push({ text: 'Greek', p: [sx(RIM_X[0]), y, back], side: 't', n: up });
    a.push({ text: 'Left', p: [sx(RIM_X[1]), y, back], side: 't', n: up }, { text: 'Middle', p: [sx(RIM_X[2]), y, back], side: 't', n: up }, { text: 'Right', p: [sx(RIM_X[3]), y, back], side: 't', n: up });
    a.push({ text: 'Entry wheel', p: [ETW_FACE + 14, AX_Y + RIM_R - 12, AX_Z + 16], side: 'r', n: up, minor: true });
    if (p.out < 0.1) a.push({ text: 'Pawls', p: [36, AX_Y + 3, AX_Z - 52], side: 'r', n: up, minor: true });
    a.push({ text: 'Battery', p: [97, 93, -105], side: 'r', n: up, minor: true });
  } else if (p.lid > 0.5) {
    a.push({ text: 'Wheel windows', p: [RIM_X[1], PANEL_Y + 2, AX_Z - 25], side: 't', n: up });
  }
  return a;
}
