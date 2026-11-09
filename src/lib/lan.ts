// Chapter glass's last scene: two bus computers, each with a NIC, and a switch between them. The computers' serial pairs (txd, txen out; rxd, crs in) meet
// the switch through one MAC pair a port (chapter carriers's receiver and transmitter, here on the switch's side of the cable): the receiver turns the
// bits of a port into the byte stream the switch takes in, the transmitter turns the switch's stream back into bits. Ports 2 and 3 are unused (their
// receive streams idle, their transmit sides always ready, so that a flooded frame leaves). One clock for everything.
//
// Built on first use (the parts are large): lanComputers() is called by the chapter's scene, not at import.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { define } from './define';
import { macRx, macTx } from './ethernet';
import { ethSwitch } from './ethswitch';
import { FLASH } from './uartlink';
import { busComputer, type SocOptions } from './soc';
import { TIE0, TIE1 } from './transistors';
import type { SwitchOpts } from '../comm/ethswitch';
import { STACK_RAM_K } from '../comm/stack/layout';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

export interface LanOptions {
  /** Boot ROM of 2^imemK words (the compiled stack and the application live there; default 13). */
  imemK?: number;
  /** The switch: a cell holds 2^cellK bytes (7: 128, enough for a 98-byte ping), `cells` a port. */
  switch?: Partial<SwitchOpts>;
}

export const LAN_SWITCH: Partial<SwitchOpts> = { cellK: 7, cells: 2 };
const cache = new Map<string, ComponentDef>();

/** The system options both computers share. */
export const lanSoc = (imemK = 12): SocOptions => ({ imemK, ramK: STACK_RAM_K, nic: true });

/** Computer A runs `srcA`, computer B `srcB` (RV32I words, from their boot ROMs). */
export function lanComputers(srcA: number[], srcB: number[], o: LanOptions = {}): ComponentDef {
  const soc = lanSoc(o.imemK ?? 12), sw = { ...LAN_SWITCH, ...o.switch };
  const A = busComputer(srcA, FLASH, soc), B = busComputer(srcB, FLASH, soc), SW = ethSwitch(sw), RX = macRx(), TX = macTx();
  const id = `lan_${A.id}_${B.id}_${SW.id}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const ga = symbolGeom(A), gs = symbolGeom(SW), gr = symbolGeom(RX), gt = symbolGeom(TX);
  const z8 = constWord(8, 0), z48 = constWord(48, 0), z10 = constWord(10, 0x155), z8g = symbolGeom(z8);
  const x0 = 12, xm = x0 + ga.w + 26, xs = xm + gr.w + 22, xe = xs + gs.w + 22, x1 = xe + gt.w + 26;
  const yA = 8, yB = yA + ga.h + 16, H = yB + ga.h + 8;
  const instances: InstanceDef[] = [
    { name: 'a', def: A, at: [x0, yA], label: 'Computer A' },
    { name: 'b', def: B, at: [x0, yB], label: 'Computer B' },
    { name: 'sw', def: SW, at: [xs, 8], label: 'Switch' },
    { name: 'rx0', def: RX, at: [xm, yA], label: 'Port 0 MAC RX' }, { name: 'rx1', def: RX, at: [xm, yB], label: 'Port 1 MAC RX' },
    { name: 'tx0', def: TX, at: [xe, yA], label: 'Port 0 MAC TX' }, { name: 'tx1', def: TX, at: [xe, yB], label: 'Port 1 MAC TX' },
    { name: 'z8', def: z8, at: [x0, H] }, { name: 'z48', def: z48, at: [x0, H + 8] }, { name: 'z10', def: z10, at: [x0, H + 16] },
    { name: 'lo', def: TIE0, at: [x0, H + 24] }, { name: 'hi', def: TIE1, at: [x0, H + 32] },
  ];
  void z8g;
  const nets: NetDef[] = [];
  const tag = (name: string, ends: string[]) => nets.push({ name, ends, tags: true });
  tag('clk', ['clk', 'a.clk', 'b.clk', 'sw.clk', 'rx0.clk', 'rx1.clk', 'tx0.clk', 'tx1.clk']);
  tag('zero8', ['z8.y', 'a.switches', 'b.switches', 'sw.rxData2', 'sw.rxData3']);
  tag('zero', ['lo.y', 'rx0.rst', 'rx1.rst', 'tx0.rst', 'tx1.rst', 'tx0.crs', 'tx1.crs', 'tx0.col', 'tx1.col', 'sw.rxValid2', 'sw.rxValid3', 'sw.rxLast2', 'sw.rxLast3', 'sw.rxErr2', 'sw.rxErr3']);
  tag('one', ['hi.y', 'sw.txReady2', 'sw.txReady3', 'rx0.promisc', 'rx1.promisc']);
  tag('addr0', ['z48.y', 'rx0.addr', 'rx1.addr']);
  tag('seed', ['z10.y', 'tx0.seed', 'tx1.seed']);
  ([['a', 0], ['b', 1]] as const).forEach(([c, p]) => {
    // the computer's pair into the port's receiver, the transmitter's pair back
    tag(`${c}txd`, [`${c}.txd`, `rx${p}.rxd`]); tag(`${c}txen`, [`${c}.txen`, `rx${p}.crs`, `${c}txenOut`]);
    tag(`${c}rxd`, [`tx${p}.txd`, `${c}.rxd`]); tag(`${c}crs`, [`tx${p}.txen`, `${c}.crs`, `${c}crsOut`]);
    tag(`rxData${p}`, [`rx${p}.data`, `sw.rxData${p}`, `rxData${p}`]); tag(`rxValid${p}`, [`rx${p}.valid`, `sw.rxValid${p}`, `rxValid${p}`]); tag(`rxLast${p}`, [`rx${p}.last`, `sw.rxLast${p}`, `rxLast${p}`]); tag(`rxErr${p}`, [`rx${p}.err`, `sw.rxErr${p}`, `rxErr${p}`]);
    tag(`rxReady${p}`, [`sw.rxReady${p}`, `rx${p}.ready`]);
    tag(`txData${p}`, [`sw.txData${p}`, `tx${p}.data`]); tag(`txValid${p}`, [`sw.txValid${p}`, `tx${p}.valid`]); tag(`txLast${p}`, [`sw.txLast${p}`, `tx${p}.last`]);
    tag(`txReady${p}`, [`tx${p}.ready`, `sw.txReady${p}`]);
    nets.push({ name: `console${c}`, ends: [`${c}.consoleData`, `consoleData${c.toUpperCase()}`] }, { name: `consoleValid${c}`, ends: [`${c}.consoleValid`, `consoleValid${c.toUpperCase()}`] },
      { name: `leds${c}`, ends: [`${c}.leds`, `leds${c.toUpperCase()}`] }, { name: `retire${c}`, ends: [`${c}.retire`, `retire${c.toUpperCase()}`] }, { name: `pc${c}`, ends: [`${c}.pcOut`, `pc${c.toUpperCase()}`] });
  });
  const ports: PortDef[] = [bit('clk', 'in', 'left', true),
    ...(['A', 'B'] as const).flatMap((s) => [bus(`consoleData${s}`, 8, 'out'), bit(`consoleValid${s}`, 'out'), bus(`leds${s}`, 8, 'out'), bit(`retire${s}`, 'out'), bus(`pc${s}`, 32, 'out')]),
    bit('atxenOut', 'out'), bit('btxenOut', 'out'), bit('acrsOut', 'out'), bit('bcrsOut', 'out'),
    // the byte streams into the switch, one a port: every frame either computer sends, as the switch receives it (a mirror port)
    ...([0, 1] as const).flatMap((p) => [bus(`rxData${p}`, 8, 'out'), bit(`rxValid${p}`, 'out'), bit(`rxLast${p}`, 'out'), bit(`rxErr${p}`, 'out')])];
  const pins: Record<string, [number, number]> = { clk: [0, 6] };
  let y = 4;
  for (const p of ports) if (p.dir === 'out') { pins[p.name] = [x1 + 10, y]; y += 3; }
  const d = define({
    id, name: 'Two computers on a switch', category: 'cpu',
    summary: 'Two bus computers, each with a NIC (descriptor rings in RAM, DMA, a MAC), joined by a four-port learning switch through one MAC pair a port. Everything runs on one clock; the consoles are the computers\' own.',
    ports, symbol: { kind: 'box', label: 'LAN' },
    netlist: () => ({ pins, instances, nets }),
  });
  cache.set(id, d);
  return d;
}

/** One computer with a NIC whose transmitter is wired to its own receiver: the driver of riscv/nicprograms.ts sends a frame to itself. */
export function nicLoopback(program: number[], imemK = 8): ComponentDef {
  const C = busComputer(program, FLASH, { imemK, ramK: STACK_RAM_K, nic: true }), id = `nicloop_${C.id}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const g = symbolGeom(C), z8 = constWord(8, 0);
  const instances: InstanceDef[] = [{ name: 'c', def: C, at: [12, 6], label: 'Computer with a NIC' }, { name: 'z8', def: z8, at: [2, 6 + g.h + 6] }];
  const nets: NetDef[] = [
    { name: 'clk', ends: ['clk', 'c.clk'], tags: true }, { name: 'zero8', ends: ['z8.y', 'c.switches'], tags: true },
    { name: 'txd', ends: ['c.txd', 'c.rxd'], tags: true }, { name: 'txen', ends: ['c.txen', 'c.crs', 'txen'], tags: true },
  ];
  const outs: [string, number][] = [['consoleData', 8], ['consoleValid', 1], ['leds', 8], ['retire', 1], ['pcOut', 32]];
  for (const [p] of outs) nets.push({ name: p, ends: [`c.${p}`, p] });
  const ports: PortDef[] = [bit('clk', 'in', 'left', true), ...outs.map(([p, w]) => (w === 1 ? bit(p, 'out') : bus(p, w, 'out'))), bit('txen', 'out')];
  const pins: Record<string, [number, number]> = { clk: [0, 6] };
  let y = 4;
  for (const p of ports) if (p.dir === 'out') { pins[p.name] = [12 + g.w + 24, y]; y += 3; }
  const d = define({
    id, name: 'A computer with a NIC, looped back', category: 'cpu',
    summary: 'A bus computer with a NIC whose transmitter feeds its own receiver: a frame it sends to its own address comes back in through the receive ring.',
    ports, symbol: { kind: 'box', label: 'NIC LOOP' },
    netlist: () => ({ pins, instances, nets }),
  });
  cache.set(id, d);
  return d;
}
