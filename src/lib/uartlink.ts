// Chapter 43's last scene: two bus computers, each with a UART and its own clock pin, their tx and rx crossed through two
// line parts (lib/uart.ts LINE). The clocks are unrelated: a panel drives clkA and clkB at chosen rates.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { define } from './define';
import { busComputer, type SocOptions } from './soc';
import { lineDef } from './uart';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

export interface TwoOptions { delay?: number; imemK?: number; ramK?: number }

/** One word of flash: the sandbox cannot place an empty flash by reference (its id is taken), and nothing here reads it. */
export const FLASH = [0];
const cache = new Map<string, ComponentDef>();

/** Two computers running `srcA` and `srcB` from their boot ROMs, a keyboard each (instance 'kbd'), one wire each way. */
export function twoComputers(srcA: number[], srcB: number[], o: TwoOptions = {}): ComponentDef {
  const delay = o.delay ?? 2, soc: SocOptions = { imemK: o.imemK ?? 8, ramK: o.ramK ?? 8, uart: true, keys: true };
  const A = busComputer(srcA, FLASH, soc), B = busComputer(srcB, FLASH, soc), L = lineDef(delay);
  const id = `two_${A.id}_${B.id}_${delay}`;
  let d = cache.get(id);
  if (d) return d;
  const ga = symbolGeom(A), gl = symbolGeom(L), z8 = constWord(8, 0), gz = symbolGeom(z8);
  const x0 = 14, xl = x0 + ga.w + 22, x1 = xl + gl.w + 22, H = 6 + Math.max(ga.h, 30);
  const instances: InstanceDef[] = [
    { name: 'a', def: A, at: [x0, 6], label: 'Computer A' },
    { name: 'b', def: B, at: [x1, 6], label: 'Computer B' },
    { name: 'ab', def: L, at: [xl, 8], label: 'A → B' },
    { name: 'ba', def: L, at: [xl, 24], label: 'B → A' },
    { name: 'za', def: z8, at: [2, H + 4] }, { name: 'zb', def: z8, at: [x1 - gz.w - 6, H + 4] },
  ];
  const nets: NetDef[] = [
    { name: 'clkA', ends: ['clkA', 'a.clk', 'ab.clk'], tags: true },
    { name: 'clkB', ends: ['clkB', 'b.clk', 'ba.clk'], tags: true },
    { name: 'za', ends: ['za.y', 'a.switches'], tags: true },
    { name: 'zb', ends: ['zb.y', 'b.switches'], tags: true },
    { name: 'txA', ends: ['a.uartTx', 'ab.d', 'lineAtx'] , tags: true },
    { name: 'rxB', ends: ['ab.q', 'b.uartRx', 'lineAB'], tags: true },
    { name: 'txB', ends: ['b.uartTx', 'ba.d', 'lineBtx'], tags: true },
    { name: 'rxA', ends: ['ba.q', 'a.uartRx', 'lineBA'], tags: true },
    { name: 'noiseAB', ends: ['noiseAB', 'ab.noise'], tags: true },
    { name: 'noiseBA', ends: ['noiseBA', 'ba.noise'], tags: true },
  ];
  for (const [s, c] of [['A', 'a'], ['B', 'b']] as const) {
    nets.push({ name: `console${s}`, ends: [`${c}.consoleData`, `consoleData${s}`] }, { name: `consoleValid${s}`, ends: [`${c}.consoleValid`, `consoleValid${s}`] },
      { name: `leds${s}`, ends: [`${c}.leds`, `leds${s}`] }, { name: `retire${s}`, ends: [`${c}.retire`, `retire${s}`] }, { name: `pc${s}`, ends: [`${c}.pcOut`, `pc${s}`] });
  }
  const ports: PortDef[] = [bit('clkA', 'in', 'left', true), bit('clkB', 'in', 'left', true), bit('noiseAB', 'in'), bit('noiseBA', 'in'),
    ...(['A', 'B'] as const).flatMap((s) => [bus(`consoleData${s}`, 8, 'out'), bit(`consoleValid${s}`, 'out'), bus(`leds${s}`, 8, 'out'), bit(`retire${s}`, 'out'), bus(`pc${s}`, 32, 'out')]),
    bit('lineAtx', 'out'), bit('lineAB', 'out'), bit('lineBtx', 'out'), bit('lineBA', 'out')];
  const pins: Record<string, [number, number]> = { clkA: [0, 2], clkB: [0, 5], noiseAB: [0, 8], noiseBA: [0, 11] };
  let y = 2;
  for (const p of ports) if (p.dir === 'out') { pins[p.name] = [x1 + ga.w + 14, y]; y += 3; }
  d = define({
    id, name: 'Two computers on a wire', category: 'cpu',
    summary: 'Two bus computers, each with a UART at 0x3000_0000, a keyboard and a console, on unrelated clocks (clkA, clkB). A\'s tx goes through a line part to B\'s rx and B\'s tx to A\'s rx. The line parts stand for the cable: chapter 41 models what is inside.',
    ports, symbol: { kind: 'box', label: 'TWO COMPUTERS' },
    netlist: () => ({ pins, instances, nets }),
  });
  cache.set(id, d);
  return d;
}
