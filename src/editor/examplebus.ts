// Examples ▸ System on a bus: chapter 37's computer as a sandbox chip. The system CPU (its boot ROM a ROM part)
// and the DMA engine are the bus's masters; RAM, a flash (its window in gates over a ROM part holding the
// program), the DRAM of chapter 35, the DMA's registers, a screen, and an I/O port for a keyboard and a timer.
// Every link is two buses (request, response: lib/axi.ts bundled), every connection a pair of pointers.

import { SANDBOX_SOURCE, SANDBOX_WORDS, bootSource } from '../bus/programs';
import { SANDBOX_MAP, SANDBOX_PARTS } from '../lib/soc';
import { symbolGeom, type Vec } from '../sim/geometry';
import type { ChipDoc, PartRef } from './model';
import { isError, partDef } from './parts';
import { Sheet } from './example6502';

export const NOTES_BUS = 'Chapter 37\'s computer on one bus. Masters: the RV32I system core (boot ROM: the ROM part on its left) and the DMA engine. '
  + 'Slaves, by the top four address bits: 0 RAM (16 KB), 1 the flash (a 64-cycle page read, then 2 cycles a word; its program is the ROM part beside it: Edit program…), '
  + '2 the DRAM (chapter 35\'s controller), 4 the DMA\'s registers, 5 the screen (pixel (x, y) at 0x5000_0000 + 256·y + 4·x, colour the low byte), '
  + '6 the I/O port: the keyboard (+0 the oldest key, taken when read; +4 status) and the timer (+8 its count, reading it acknowledges; +12 its irq); anything else the default slave. '
  + 'Console, LEDs, switches and mtime are inside the core at 0x8000_0000. At power-on the boot ROM has the DMA copy the flash to RAM 0x400 and jumps there. '
  + 'Set the clock rate to max (the menu by Step), Run, then type (the keyboard takes keys while running): each key is echoed, kept in DRAM and drawn; Enter prints the line back; the LEDs count the timer\'s interrupts. '
  + 'Every link is two buses: the request (the master\'s nine signals, 105 bits) and the response (six signals, 37 bits); double-click a part to see them unpacked. The CPU drawer does not follow this core (its memory and interrupts are behind the bus): watch the console, the screen and the LEDs, or look inside.';

const SLAVES: [string, keyof typeof SANDBOX_PARTS, string][] = [
  ['ram', 'ram', 'RAM 16 KB'], ['flash', 'flash', 'flash window'], ['dram', 'dram', 'DRAM'], ['dmaregs', 'dma', ''],
  ['pixel', 'pixel', 'screen port'], ['io', 'io', 'I/O port'], ['none', 'def', 'default slave'],
];

/** The sandbox's System on a bus. */
export function busSystemChip(id: string, name: string): ChipDoc {
  if (SLAVES.length !== SANDBOX_MAP.length) throw new Error('busSystemChip: one slave per map entry');
  const s = new Sheet();
  const size = (ref: PartRef) => { const d = partDef(ref, () => undefined); if (isError(d)) throw new Error(d.error); const g = symbolGeom(d); return [g.w, g.h] as Vec; };
  const lib = (k: keyof typeof SANDBOX_PARTS): PartRef => ({ lib: SANDBOX_PARTS[k].id });
  const GAP = 6;

  // column 1: the boot ROM, the switches; column 2: the core, the DMA, the interrupt OR, console and LEDs
  const bootRef: PartRef = { rom: { k: 7, w: 32, addr: 'rv32', lang: 'asm', src: bootSource(SANDBOX_WORDS) } };
  const [bw, bh] = size(bootRef);
  s.pin('clk', 'in', [2, 2], 1, { kind: 'clock' });
  s.part('boot', bootRef, [6, 6], { label: 'boot ROM' });
  s.part('sw', { switches: 8 }, [6, 6 + bh + 10], { label: 'switches' });
  const x2 = 6 + bw + 16;
  const [cw, ch] = size(lib('cpu'));
  s.part('cpu', lib('cpu'), [x2, 6], { label: 'RV32I core' });
  const [, dh] = size(lib('dma'));
  s.part('dma', lib('dma'), [x2, 6 + ch + GAP + 2], { label: 'DMA' });
  const yLow = 6 + ch + GAP + 2 + dh + GAP + 2;
  s.part('irq', { lib: 'or' }, [x2, yLow], { label: 'irq: timer or DMA' });
  s.part('con', { console: { cols: 32, rows: 8 } }, [x2, yLow + 8], { label: 'console' });
  s.part('leds', { display: 'led', width: 8 }, [x2 + 30, yLow]);

  // column 3: the interconnect
  const x3 = x2 + Math.max(cw, 40) + 18;
  const [bxw] = size(lib('bus'));
  s.part('bus', lib('bus'), [x3, 6], { label: 'interconnect' });

  // column 4: the slaves (the DMA's registers are the DMA itself, in column 2); column 5: their devices
  const x4 = x3 + bxw + 18;
  let y = 6, wMax = 0;
  const at = new Map<string, number>();
  for (const [n, k, label] of SLAVES) {
    if (n === 'dmaregs') continue;
    const [w, h] = size(lib(k));
    s.part(n, lib(k), [x4, y], { label });
    at.set(n, y);
    wMax = Math.max(wMax, w);
    y += h + GAP;
  }
  const x5 = x4 + wMax + 18;
  // each device beside its slave, or below the one above it when that is taller
  let y5 = 0;
  const device = (id: string, ref: PartRef, slave: string, label: string) => {
    const y0 = Math.max(at.get(slave)!, y5);
    s.part(id, ref, [x5, y0], { label });
    y5 = y0 + size(ref)[1] + GAP;
    return y0;
  };
  device('from', { rom: { k: 8, w: 32, addr: 'word', lang: 'asm', src: SANDBOX_SOURCE } }, 'flash', 'flash contents');
  device('scr', { screen: { mode: 'write', size: 64, color: 'rgb332' } }, 'pixel', 'screen');
  device('kbd', { keyboard: true }, 'io', 'keyboard');
  const yt = device('tmr', { lib: 'timer1000' }, 'io', 'timer');
  s.part('cnt', { split: [8, 2] }, [x5 + 16, yt + 2]);

  // the links: request and response of every master and slave
  s.tap('cpu.req', 'cpu_req'); s.tap('bus.m0_req', 'cpu_req');
  s.tap('bus.m0_rsp', 'cpu_rsp'); s.tap('cpu.rsp', 'cpu_rsp');
  s.tap('dma.m_req', 'dma_req'); s.tap('bus.m1_req', 'dma_req');
  s.tap('bus.m1_rsp', 'dma_rsp'); s.tap('dma.m_rsp', 'dma_rsp');
  SLAVES.forEach(([n], k) => {
    const part = n === 'dmaregs' ? 'dma' : n;
    s.tap(`bus.s${k}_req`, `${n}_req`); s.tap(`${part}.req`, `${n}_req`);
    s.tap(`${part}.rsp`, `${n}_rsp`); s.tap(`bus.s${k}_rsp`, `${n}_rsp`);
  });
  // the devices
  const pairs: [string, string, string][] = [
    ['cpu.pcOut', 'boot.addr', 'pc'], ['boot.data', 'cpu.romData', 'boot'], ['sw.q', 'cpu.switches', 'sw'],
    ['cpu.consoleData', 'con.data', 'conData'], ['cpu.consoleValid', 'con.we', 'conWe'], ['cpu.leds', 'leds.a', 'leds'],
    ['dma.irq', 'irq.b', 'dmaIrq'], ['tmr.irq', 'irq.a', 'tmrIrq'], ['irq.y', 'cpu.irq', 'irq'],
    ['flash.addr', 'from.addr', 'faddr'], ['from.data', 'flash.data', 'fdata'],
    ['pixel.x', 'scr.x', 'px'], ['pixel.y', 'scr.y', 'py'], ['pixel.color', 'scr.color', 'pcolor'], ['pixel.we', 'scr.we', 'pwe'],
    ['io.kack', 'kbd.ack', 'kack'], ['kbd.code', 'io.code', 'kcode'], ['kbd.ready', 'io.ready', 'kready'],
    ['tmr.irq', 'io.irq', 'tmrIrq'], ['io.tack', 'tmr.ack', 'tack'], ['tmr.count', 'cnt.in', 'tcount'], ['cnt.o0', 'io.count', 'tcount8'],
  ];
  const tapped = new Set<string>();
  for (const [a, b, n] of pairs) for (const e of [a, b]) if (!tapped.has(e)) { tapped.add(e); s.tap(e, n); }
  for (const p of ['cpu', 'dma', 'bus', 'ram', 'flash', 'dram', 'pixel', 'io', 'none', 'tmr', 'con', 'scr']) s.tap(`${p}.clk`, 'clk');
  s.tap('pin:clk', 'clk');
  return s.doc(id, name, { notes: NOTES_BUS });
}
