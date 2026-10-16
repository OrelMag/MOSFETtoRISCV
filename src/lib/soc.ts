// Chapter 35's computer: the RV32I system CPU on a bus (systemCpu({ bus })) with a DMA engine as a second
// master, and as slaves a RAM from address 0, a flash at 0x1000_0000 and the DMA's registers at
// 0x4000_0000 (bus/model.ts is the golden model's view of the same map). The DMA's irq is the CPU's
// external interrupt. Console, LEDs, switches and the timer stay inside the CPU at 0x8000_0000.

import { MAP } from '../bus/model';
import { BOOT_SOURCE, PAYLOAD_SOURCE } from '../bus/programs';
import { assemble } from '../riscv/asm';
import type { ComponentDef, PortDef } from '../sim/types';
import { AXI_DEFAULT, axiBus, axiFlash, axiRam, DMA_ENGINE, M_IN, M_OUT } from './axi';
import { symbolGeom } from '../sim/geometry';
import { Builder } from './builder';
import { define } from './define';
import { systemCpu } from './system';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

export interface SocOptions {
  /** Boot ROM of 2^imemK words (default 7: 512 bytes). */
  imemK?: number;
  /** RAM of 2^ramK words (default 12: 16 KB). */
  ramK?: number;
  /** Wait states of the RAM (default 0). */
  ramWait?: number;
}

const cache = new Map<string, ComponentDef>();

export function busComputer(program: number[], flashImage: ArrayLike<number> = [], o: SocOptions = {}): ComponentDef {
  const imemK = o.imemK ?? 7, ramK = o.ramK ?? 12, wait = o.ramWait ?? 0;
  const CPU = systemCpu(program, { imemK, bus: true }), FL = axiFlash(flashImage);
  const id = `soc_${CPU.id}_${FL.id}_${ramK}_${wait}`;
  let d = cache.get(id);
  if (d) return d;
  const b = new Builder(10, 24);
  b.pins('clk', 'switches');
  const cpu = b.op(CPU, [], 'CPU', 'cpu');
  const dma = b.op(DMA_ENGINE, [], 'DMA', 'dma');
  b.next();
  const bx = b.op(axiBus(2, [MAP.ram, MAP.flash, MAP.dma, 0xf]), [], 'interconnect', 'bus');
  b.next();
  const slaves = [b.op(axiRam(ramK, wait), [], 'RAM', 'ram'), b.op(FL, [], 'flash', 'flash'), dma, b.op(AXI_DEFAULT, [], 'default', 'def')];
  for (const s of M_OUT) { b.wire(`${cpu}.${s}`, `${bx}.m0_${s}`); b.wire(`${dma}.m_${s}`, `${bx}.m1_${s}`); }
  for (const s of M_IN) { b.wire(`${bx}.m0_${s}`, `${cpu}.${s}`); b.wire(`${bx}.m1_${s}`, `${dma}.m_${s}`); }
  slaves.forEach((sl, i) => {
    for (const s of M_OUT) b.wire(`${bx}.s${i}_${s}`, `${sl}.${s}`);
    for (const s of M_IN) b.wire(`${sl}.${s}`, `${bx}.s${i}_${s}`);
  });
  for (const x of [cpu, dma, bx, slaves[0], slaves[1], slaves[3]]) b.wire('clk', `${x}.clk`);
  b.wire('switches', `${cpu}.switches`);
  b.wire(`${dma}.irq`, `${cpu}.irq`);
  for (const p of ['pcOut', 'consoleData', 'consoleValid', 'leds', 'retire']) b.wire(`${cpu}.${p}`, p);
  b.wire(`${dma}.busy`, 'dmaBusy');
  const R = b.right, cg = symbolGeom(CPU), cpuY = b.instances.find((i) => i.name === cpu)!.at![1];
  d = define({
    id, name: 'Computer on a bus (CPU, DMA, RAM, flash)', category: 'cpu',
    summary: `The system CPU and a DMA engine share one bus to a ${4 * 2 ** ramK}-byte RAM at 0, a flash at 0x1000_0000 and the DMA's registers at 0x4000_0000. The boot ROM (${4 * 2 ** imemK} bytes) holds the first instructions; everything else is fetched over the bus. The DMA's done interrupt is the CPU's external interrupt.`,
    ports: [bit('clk', 'in', 'left', true), bus('switches', 8, 'in'), bus('pcOut', 32, 'out'), bus('consoleData', 8, 'out'), bit('consoleValid', 'out'), bus('leds', 8, 'out'), bit('retire', 'out'), bit('dmaBusy', 'out')],
    symbol: { kind: 'box', label: 'COMPUTER' },
    netlist: () => ({ pins: { clk: [0, cpuY + cg.ports.clk.pos[1]], switches: [0, cpuY + cg.ports.switches.pos[1]], pcOut: [R, 4], consoleData: [R, 7], consoleValid: [R, 10], leds: [R, 13], retire: [R, 16], dmaBusy: [R, 19] }, instances: b.instances, nets: b.nets() }),
  });
  cache.set(id, d);
  return d;
}

/** Chapter 35's computer: the boot ROM and the flash holding the program it loads (bus/programs.ts). */
export function chapterComputer(): ComponentDef {
  const words = (src: string) => { const a = assemble(src); if (a.errors.length) throw new Error(a.errors[0].message); return a.words; };
  return busComputer(words(BOOT_SOURCE), words(PAYLOAD_SOURCE));
}

export const CHAPTER_COMPUTER = chapterComputer();
