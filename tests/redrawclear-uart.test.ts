import { describe, expect, it } from 'vitest';
import { i2cBus } from '../src/lib/i2c';
import { UART_CORE, UART_RX, UART_TX } from '../src/lib/uart';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { routeNetlist } from '../src/view/route';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';

// The UART levels drawn by hand (and the I²C bus): no wire runs under a part (see tests/redrawclear.test.ts).
const levels: [string, () => ComponentDef][] = [
  ['UART transmitter', () => UART_TX],
  ['UART receiver', () => UART_RX],
  ['UART core', () => UART_CORE],
  ['I²C bus', () => i2cBus(1, [{ adr: 0x50 }])],
];

describe('hand-drawn UART levels', () => {
  it.each(levels)('%s: no wire runs through a part', (_, make) => {
    const def = make();
    const nl = drawnNetlist(def, netlistOf(def)!);
    const hit = wiresThroughParts(nl, routeNetlist(def, nl).nets);
    expect([...hit].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0])).toEqual([]);
  });
});
