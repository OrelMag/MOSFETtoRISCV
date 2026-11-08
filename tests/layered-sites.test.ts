import { describe, expect, it } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { netlistOf } from '../src/sim/types';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';

// Builder sites switched to layered.ts (`netlist: laid(b, opts)`) because every level they build came out no worse, measured over
// every Builder level (circuit eyeballing, fix/builder-align). These came out fully clean: hold them there.
const CLEAN = ['axibus2_0_1_2_4_5_6_15', 'rv16_lanes4', 'axi_uart_b', 'sysbuscore7_b', 'axibus2_0_1_2_4_5_6_15_b', 'axiram12_0_b',
  'axiflashwin8_64_b', 'axidram12_2_16_o_b', 'dma_b', 'axipixel_b', 'axiio_b', 'axidefault_b', 'rv16_mux16', 'shrs32_5', 'shrs26_5',
  'shrs28_5', 'shrs48_6', 'shrs32_6', 'shrs33_6', 'shrs50_6', 'shrs52_6', 'shrs27_5', 'ohmux4x32', 'ohmux3x3', 'ohmux3x7', 'rv16_dreg16',
  'agerow0', 'agerow1', 'agerow2', 'agerow3', 'agerow4', 'agerow5', 'agerow6', 'agerow7', 'fpun8_23', 'fxclamp16_32', 'fptoia8_23_32',
  'rvc_forms', 'paircheck', 'rv16_eq16', 'hazard2'];

describe('levels laid out by layered.ts', () => {
  it.each(CLEAN)('%s: registered, no wire through a part, nothing drawn on anything else', (id) => {
    const def = registry.get(id);
    expect(def, id).toBeDefined();
    const nl = netlistOf(def!)!;
    const drawn = drawnNetlist(def!, nl);
    expect(wiresThroughParts(drawn, routeNetlist(def!, drawn).nets).size).toBe(0);
    expect(wireOverlaps(routeNetlist(def!, nl).nets)).toEqual([]);
    expect(labelOverlaps(def!, nl)).toEqual([]);
    expect(symbolOverlaps(nl)).toEqual([]);
  });
});
