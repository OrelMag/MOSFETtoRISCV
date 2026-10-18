// The system core with ports on a bench of library parts (its program ROM, a byte-banked data memory, and the
// I/O unit outside for the console, LEDs and switches at bit 31): the same pins as systemCpu. Shared by
// tests/syscore.test.ts and scripts/verify-export.ts (core-m: the module the layout flow lays out).

import { IO_UNIT, systemCore } from '../src/lib/system';
import { rom } from '../src/lib/cpu';
import { bankedMemory } from '../src/lib/lsu';
import { busMux2 } from '../src/lib/combinational';
import { AND, NOT } from '../src/lib/gates';
import { splitter } from '../src/lib/define';
import type { ComponentDef } from '../src/sim/types';

const bit = (name: string, dir: 'in' | 'out') => ({ name, dir, width: 1 });
const bus = (name: string, width: number, dir: 'in' | 'out') => ({ name, dir, width });

/** The core with a 2^7-word ROM, 2^5 words of data memory and the I/O unit outside (not registered). */
export function coreBench(words: number[], m: boolean): ComponentDef {
  return {
    id: `syscore_bench_${m}`, name: 'system core bench', category: 'cpu',
    ports: [bit('clk', 'in'), bit('irq', 'in'), bus('switches', 8, 'in'), bus('pcOut', 32, 'out'), bus('consoleData', 8, 'out'), bit('consoleValid', 'out'), bus('leds', 8, 'out'), ...(m ? [bit('retire', 'out')] : [])],
    symbol: { kind: 'box', label: 'BENCH' },
    netlist: () => ({
      pins: {},
      instances: [
        { name: 'cpu', def: systemCore({ m }) }, { name: 'imem', def: rom(words, 7) }, { name: 'dm', def: bankedMemory(5) }, { name: 'io', def: IO_UNIT },
        { name: 'a31', def: splitter([31, 1]) }, { name: 'n31', def: NOT }, { name: 'dmWe', def: AND }, { name: 'ioWe', def: AND }, { name: 'rsel', def: busMux2(32) },
      ],
      nets: [
        { name: 'clk', ends: ['clk', 'cpu.clk', 'dm.clk', 'io.clk'] },
        { name: 'irq', ends: ['irq', 'cpu.irq'] },
        { name: 'pc', ends: ['cpu.pcOut', 'imem.addr', 'pcOut'] },
        { name: 'instr', ends: ['imem.data', 'cpu.instr'] },
        { name: 'addr', ends: ['cpu.memAddr', 'dm.addr', 'io.addr', 'a31.in'] },
        { name: 'wdata', ends: ['cpu.memWData', 'dm.wdata', 'io.wdata'] },
        { name: 'be', ends: ['cpu.memBE', 'dm.be'] },
        { name: 'we', ends: ['cpu.memWE', 'dmWe.a', 'ioWe.a'] },
        { name: 'isDev', ends: ['a31.o1', 'n31.a', 'ioWe.b', 'rsel.s'] },
        { name: 'isMem', ends: ['n31.y', 'dmWe.b'] },
        { name: 'dmWe', ends: ['dmWe.y', 'dm.we'] },
        { name: 'ioWe', ends: ['ioWe.y', 'io.we'] },
        { name: 'memR', ends: ['dm.rdata', 'rsel.a'] },
        { name: 'ioR', ends: ['io.rdata', 'rsel.b'] },
        { name: 'rdata', ends: ['rsel.y', 'cpu.memRData'] },
        { name: 'switches', ends: ['switches', 'io.switches'] },
        { name: 'consoleData', ends: ['io.consoleData', 'consoleData'] },
        { name: 'consoleValid', ends: ['io.consoleValid', 'consoleValid'] },
        { name: 'leds', ends: ['io.leds', 'leds'] },
        ...(m ? [{ name: 'retire', ends: ['cpu.retire', 'retire'] }] : []),
      ],
    }),
  } as ComponentDef;
}
