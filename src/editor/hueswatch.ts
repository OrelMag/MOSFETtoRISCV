// The net colour swatches (wirehue.ts): no colour (the palette's), Auto (the net's colour-per-net
// hue, shown even with that switch off), then the WIRE_HUES. Used by the right-click menu and the
// wire / pointer properties.

import { h } from '../ui/dom';
import type { NetHue } from './model';
import { WIRE_HUES } from './wirehue';

/** A row of swatch buttons; `current` is marked (null: the nets differ, nothing marked). */
export function hueSwatches(current: NetHue | undefined | null, pick: (hue: NetHue | undefined) => void, role: 'menuitemradio' | 'radio' = 'radio'): HTMLElement {
  const sw = (hue: NetHue | undefined, cls: string, title: string, style?: string) => h('button', {
    type: 'button', role, class: `sb-hue-sw ${cls}`, title, 'aria-label': title, 'aria-checked': String(current !== null && current === hue),
    style: style ?? null, onclick: () => pick(hue),
  });
  return h('div', { class: 'sb-hues', role: role === 'radio' ? 'radiogroup' : 'group', 'aria-label': 'Net colour' },
    sw(undefined, 'none', 'No colour: the palette’s value colours'),
    sw('auto', 'auto', 'Auto: the net’s own colour from colour per net'),
    WIRE_HUES.map((c) => sw(c.hue, '', `${c.name[0].toUpperCase()}${c.name.slice(1)}`, `--sw-h:${c.hue}`)));
}
