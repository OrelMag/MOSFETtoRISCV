// The device puzzles on a CPU: the RV32I single-cycle computer of the stream puzzles (computers.ts) ready-wired to a
// device, and a reference program per device. The device sits on the memory map where the stream computer has its two
// ports, and its `en` pin is the store strobe, so the program paces the world:
//
//   lw  rd, 0(s0)   (s0 = 0x8000_0000)  reads the sense pins, packed from bit 0 in the device's pin order (a 2-bit pin
//                                       takes two bits, low first), zero above
//   sw  rs, 4(s0)                       the world takes one step at this store's clock edge, the drive pins being the
//                                       stored word's bits, packed the same way
//
// The drive pins hang straight off the store data (no register): the device samples them just before the edge that
// writes, so a register written on that edge would hand it the old word. The world stands still between stores, so the
// next load already sees where the step took it. 64 words of RAM at 0 … 0xFC as on the stream computer; no halt part: the
// program loops for ever and Check stops each test when the world is done, breaks a rule or reaches its step limit.
// Graded like the stream puzzles: cycles × NANDs against the reference program on this computer (DEVICE_CPU_REFS,
// re-measured by tests/puzzle-devices.test.ts). No DOM.

import { constWord } from '../lib/alu';
import { Builder } from '../lib/builder';
import { busMux2 } from '../lib/combinational';
import { merger, splitter } from '../lib/define';
import { AND, NOT } from '../lib/gates';
import { resolveComponent } from '../lib/resolve';
import { TIE1 } from '../lib/transistors';
import type { ComponentDef, PortDef } from '../sim/types';
import { deviceDef } from '../editor/devparts';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc, PartRef } from '../editor/model';
import { partDef } from '../editor/parts';
import { DEVICES, type DeviceId, type DevicePin } from './devices';
import { romRefOf } from './computers';
import type { RefPoint } from './refs';

/** The pins as bit fields of a word, from bit 0: `name` bit n, or `name` bits hi:lo. */
export const pinFields = (pins: DevicePin[]): string => {
  let at = 0;
  return pins.map((p) => {
    const s = p.width === 1 ? `bit ${at} ${p.name}` : `bits ${at + p.width - 1}:${at} ${p.name}`;
    at += p.width;
    return s;
  }).join(', ');
};

/** What a program does on the device computer (HTML), for the strip and the start dialog. */
export const deviceIo = (dev: DeviceId): string =>
  `<code>lui s0, 0x80000</code>, then <code>lw rd, 0(s0)</code> reads the device (${pinFields(DEVICES[dev].sense)}) and `
  + `<code>sw rs, 4(s0)</code> drives it (${pinFields(DEVICES[dev].drive)}): the world takes one step at each such store, so store once a step. `
  + '64 words of RAM at 0 … 0xFC.';

const RAM_REF: PartRef = { ram: { k: 6, w: 32 } };
const CLK: PortDef = { name: 'clk', width: 1, dir: 'in', clock: true };

function must<T extends object>(r: T | { error: string }): T {
  if ('error' in r) throw new Error(`device computer: ${r.error}`);
  return r;
}

/** The netlist: rv32i_core, the program ROM, 64 words of RAM, the device on the I/O half of the map. */
function deviceComputerDef(dev: DeviceId, rom: ComponentDef): ComponentDef {
  const m = DEVICES[dev];
  const ram = must(partDef(RAM_REF, () => undefined));
  const b = new Builder(10, 12, 6);
  b.pins('clk');
  const core = b.op(resolveComponent('rv32i_core')!, ['clk', '', b.name(b.op1(constWord(32, 0), [], 'hart 0'), 'hartid'), '', b.name(b.op1(TIE1, [], 'granted'), 'grant')], 'RV32I core', 'cpu');
  const addr = b.name(`${core}.memAddr`, 'addr', true), dw = b.name(`${core}.memWData`, 'wdata', true);
  const we = b.name(`${core}.memWE`, 'we', true);
  b.next();
  const r = b.op(rom, [b.name(`${core}.pcOut`, 'pc', true)], 'program', 'rom');
  const instr = b.name(`${r}.data`, 'instr', true);
  const as = b.op(splitter([2, 6, 23, 1], 4), [addr], 'address');
  const bs = b.op(splitter([2, 1, 29], 4), [addr], 'bit 2');
  b.next();
  const io = b.name(`${as}.o3`, 'io', true), b2 = b.name(`${bs}.o1`, 'b2', true);
  const ramWe = b.name(b.op1(AND, [we, b.name(b.op1(NOT, [io]), 'ram')], 'RAM write'), 'ram_we');
  const step = b.name(b.op1(AND, [we, b.name(b.op1(AND, [io, b2], '= device'), 'dev_sel')], 'step'), 'step', true);
  const dwid = m.drive.reduce((s, p) => s + p.width, 0), swid = m.sense.reduce((s, p) => s + p.width, 0);
  const ds = b.op(splitter([...m.drive.map((p) => p.width), 32 - dwid], 4), [dw], 'drive bits');
  b.next();
  const mem = b.op(ram, [`${as}.o1`, dw, ramWe, 'clk'], 'data (64 words)', 'ram');
  const d = b.op(deviceDef(dev, true), [...m.drive.map((p, i) => b.name(`${ds}.o${i}`, p.name, true)), step, 'clk'], m.title.toLowerCase(), 'dev');
  b.next();
  const sense = b.op1(merger([...m.sense.map((p) => p.width), 32 - swid], 2), [...m.sense.map((p) => b.name(`${d}.${p.name}`, p.name, true)), b.name(b.op1(constWord(32 - swid, 0), [], '0'), 'zero')], 'sense word');
  b.name(sense, 'sense');
  b.next();
  b.wire(b.name(b.op1(busMux2(32), [b.name(`${mem}.dout`, 'ram_data'), sense, io], 'read data'), 'rdata'), `${core}.memRData`);
  b.wire(instr, `${core}.instr`);
  return {
    id: `pzdev_cpu_${dev}`, name: 'device computer', category: 'cpu', symbol: { kind: 'box', label: 'COMPUTER' },
    ports: [CLK],
    netlist: () => ({ pins: { clk: [0, 4] }, instances: b.instances, nets: b.nets() }),
  };
}

/** The ready-wired computer as a chip document, its ROM holding `src` (the reference program when left out). */
export function deviceComputerChip(dev: DeviceId, id: string, name: string, src = DEVICE_PROGRAMS[dev]): ChipDoc {
  const romRef = romRefOf('rv32', src);
  const rom = must(partDef(romRef, () => undefined));
  const ram = must(partDef(RAM_REF, () => undefined));
  const doc = must(docFromDef(deviceComputerDef(dev, rom), {
    id, name,
    refOf: (q) => {
      if (q === rom) return romRef;
      if (q === ram) return RAM_REF;
      if (q === TIE1) return { const: { width: 1, value: 1 } };
      if (q === deviceDef(dev, true)) return { device: dev, en: true };
      return undefined;
    },
  }));
  return { ...doc, notes: `RV32I single-cycle computer ready for the ${DEVICES[dev].title.toLowerCase()}. ${deviceIo(dev).replace(/<[^>]+>/g, '')}` };
}

/** The empty program a puzzle starts from on the computer: the device's map in comments, a loop that stores nothing. */
export const starterProgram = (dev: DeviceId): string => `# ${DEVICES[dev].title} on the RV32I computer
# lw rd, 0(s0) reads: ${pinFields(DEVICES[dev].sense)}
# sw rs, 4(s0) drives: ${pinFields(DEVICES[dev].drive)}
# The world takes one step at each store to 4(s0).
        lui  s0, 0x80000
loop:   lw   t0, 0(s0)
        # decide the drive word in t1 from t0 (and what you remember)
        li   t1, 0
        sw   t1, 4(s0)
        j    loop
`;

/** The reference programs: REFERENCE_CONTROLLERS (devrefs.ts) written in RV32I, step for step. */
export const DEVICE_PROGRAMS: Record<DeviceId, string> = {
  crossing: `# Crossing: four states (0 cars go, 1 yellow, 2 walk, 3 all red) and a step counter.
        lui  s0, 0x80000
        li   s1, 0            # the state
        li   s2, 0            # steps in it so far (3 bits)
loop:   lw   t0, 0(s0)        # bit 0: req
        slli t2, s1, 2        # 4 x state: a nibble of each table below
        li   t1, 0x1924       # lamps per state: green 4, yellow 2, red + walk 9, red 1
        srl  t1, t1, t2
        andi t1, t1, 15
        sw   t1, 4(s0)        # one world step
        li   t1, 0x0315       # steps each state lasts, less one: 5, 1, 3, 0
        srl  t1, t1, t2
        andi t1, t1, 15
        blt  s2, t1, stay     # not long enough yet
        bnez s1, next         # only cars-go waits for a press
        andi t0, t0, 1
        beqz t0, stay
next:   addi s1, s1, 1
        andi s1, s1, 3
        li   s2, 0
        j    loop
stay:   addi s2, s2, 1
        andi s2, s2, 7
        j    loop
`,
  maze: `# Maze runner: the left-hand rule; s1 = 1 right after a left turn (then always forward).
        lui  s0, 0x80000
        li   s1, 0
loop:   lw   t0, 0(s0)        # bit 0 wall ahead, 1 wall left, 2 wall right, 3 goal
        andi t1, t0, 8
        bnez t1, wait         # at the goal: no command
        bnez s1, fwd          # just turned left: forward
        andi t1, t0, 2
        beqz t1, left         # the left is open
        andi t1, t0, 1
        bnez t1, right        # walls ahead and on the left
fwd:    li   t1, 1
        li   s1, 0
        j    out
left:   li   t1, 2
        li   s1, 1
        j    out
right:  li   t1, 4
        li   s1, 0
        j    out
wait:   li   t1, 0
        li   s1, 0
out:    sw   t1, 4(s0)        # one world step
        j    loop
`,
  vend: `# Vending machine: s1 = credit in 5c units (4 bits), s2 = paying out.
        lui  s0, 0x80000
        li   s1, 0
        li   s2, 0
loop:   lw   t0, 0(s0)        # bits 1:0 coin, bit 2 buy, bit 3 refund
        li   t1, 0            # vend
        li   t2, 0            # change: 1 a 5c, 2 a 10c
        bnez s2, payout
        andi t3, t0, 4
        beqz t3, step         # no buy
        li   t3, 6
        blt  s1, t3, step     # under 30c
        li   t1, 1            # drop an item
        j    step
payout: li   t2, 2            # 10c while 10c or more is left
        li   t3, 2
        bge  s1, t3, step
        mv   t2, s1           # else 5c if 5c is left (credit 1 or 0)
step:   slli t3, t2, 1
        or   t3, t3, t1
        sw   t3, 4(s0)        # one world step: bit 0 vend, bits 2:1 change
        andi t3, t0, 3        # the coin's value in 5c units: 0, 1, 2, 5
        slli t3, t3, 2
        li   t4, 0x5210
        srl  t4, t4, t3
        andi t4, t4, 15
        add  s1, s1, t4
        sub  s1, s1, t2
        beqz t1, nosale
        addi s1, s1, -6
nosale: andi s1, s1, 15
        andi t3, t0, 8        # refund
        or   t3, t3, t1
        or   s2, s2, t3       # pay out after a sale or a refund ...
        bnez s1, loop
        li   s2, 0            # ... until nothing is left
        j    loop
`,
};

/** The reference program on the computer: its mean cycles over the tests and NANDs (program ROM left out). */
export const DEVICE_CPU_REFS: Record<DeviceId, RefPoint> = {
  crossing: { cpu: 'rv32', nands: 71917, cycles: 612.2, words: 24 },
  maze: { cpu: 'rv32', nands: 71917, cycles: 500.3, words: 23 },
  vend: { cpu: 'rv32', nands: 71917, cycles: 614.2, words: 37 },
};

