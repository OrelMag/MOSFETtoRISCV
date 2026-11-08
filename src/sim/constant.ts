// Which components are constants (wires tied to VDD / GND), decided by what they are, not by how their symbol looks: a one-port
// box with a label is also a key, a probe or a display. DOM-free; the view's legibility rule (view/legible.ts) and its tests use it.

import type { ComponentDef } from './types';

/**
 * A constant: lib/alu.ts constWord (`const<w>_<hex>`: the CSR unit's k_*, zero32, kT, kE, misa, ones), the sandbox's constant part
 * (`sb_const<w>_<hex>`, editor/parts.ts) and the one-bit tie cells (`tie0`, `tie1`, lib/transistors.ts). Not a key, a probe or
 * an LED / display (their ids are `key_…`, `disp_…`), nor any other box with one port.
 */
export const isConstantDef = (def: Pick<ComponentDef, 'id'>): boolean => /^(sb_)?const\d+_[0-9a-f]+$/.test(def.id) || def.id === 'tie0' || def.id === 'tie1';
