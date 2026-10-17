// The triode close-up's body (loaded on demand by widgets/triode3d.ts). Placeholder until the 3D view lands
// (branch feat/tube-3d): the model's state at a few grid voltages.

import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { triodeAt } from '../phys/triode';

export function triodeView(): Widget {
  const rows = [0, -4, -8, -12.5].map((vg) => {
    const t = triodeAt(vg, 20);
    return h('p', null, `grid ${vg} V: plate ${t.vp.toFixed(0)} V, ${(t.ip * 1e3).toFixed(2)} mA`);
  });
  return { el: h('div', null, ...rows) };
}
