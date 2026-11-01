// The memory-map designer's decoder as a chip (editor/memmapui.ts "Open the decoder in the sandbox"): the address's top
// nibble against each region's code, one select line per region and the default slave's when none matches. It is the
// bus's own match logic (lib/axi.ts nibbleSelects, the same gates), without the register that holds the choice while
// a transaction is under way, so its NAND count is the bus decoder's combinational part. Not registered: built per map.

import type { ComponentDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { kit, nibbleSelects } from './axi';

export interface DecoderRegion { name: string; code: number }

/** Output name of a region's select line: `sel_<name>` with identifier characters only, unique. */
export function selectNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((n) => {
    let s = `sel_${n.replace(/[^\w]/g, '_')}`;
    for (let i = 2; seen.has(s.toLowerCase()); i++) s = `sel_${n.replace(/[^\w]/g, '_')}_${i}`;
    seen.add(s.toLowerCase());
    return s;
  });
}

/** Regions in bus order (slave 0 first); the default slave is added last. */
export function memmapDecoder(regions: DecoderRegion[], defaultName = 'default'): ComponentDef {
  const codes = [...regions.map((r) => r.code), 0xf];
  const names = selectNames([...regions.map((r) => r.name), defaultName]);
  const b = new Builder(14, 14);
  const g = kit(b);
  b.pins('addr');
  const nib = g.split('addr', [28, 4])[1];
  b.next();
  const dec = nibbleSelects(b, g, nib, codes);
  b.next();
  dec.forEach((d, k) => b.wire(d, names[k]));
  const ports: PortDef[] = [{ name: 'addr', dir: 'in', width: 32 }, ...names.map((n): PortDef => ({ name: n, dir: 'out', width: 1 }))];
  const R = b.right;
  const pins: Record<string, [number, number]> = { addr: [0, 4] };
  names.forEach((n, k) => { pins[n] = [R, 2 + 3 * k]; });
  return {
    id: `memmapdec_${codes.slice(0, -1).map((c) => c.toString(16)).join('') || 'none'}`,
    name: 'Address decoder', category: 'memory',
    summary: `Decodes a[31:28]: a select line per region (${regions.map((r) => `${r.name} = 0x${r.code.toString(16)}`).join(', ') || 'none'}) and ${defaultName} when none matches.`,
    ports, symbol: { kind: 'box', label: 'DECODE' },
    netlist: () => ({ pins, instances: b.instances, nets: b.nets() }),
  };
}
