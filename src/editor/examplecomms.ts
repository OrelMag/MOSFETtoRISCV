// Examples ▸ Two computers: chapter 43's last scene as a sandbox chip. Two RV32I bus cores, each with a boot ROM, a RAM and a
// UART slave (0x3000_0000) on its own bus, and a console; A's tx goes through a line part to B's rx and B's tx through
// another to A's rx. Each computer is a chip of its own (double-click to open: the core, the bus, the slaves), so the top
// level is four boxes, two lines and two consoles. The CPU drawer sits out (resolveCpu: a bus core's memory and interrupts
// are behind the bus; detectCpu leaves a sysbuscore part alone), so watch the consoles.

import { MAP } from '../bus/model';
import { sandboxBus } from '../lib/axi';
import { SANDBOX_PARTS } from '../lib/soc';
import { AXI_UART_B, lineDef } from '../lib/uart';
import { symbolGeom, type Vec } from '../sim/geometry';
import type { ChipDoc, PartRef } from './model';
import { Sheet, chipBox } from './example6502';
import { isError, partDef } from './parts';

/** Clock cycles a bit lasts at divisor 1: the UART counts 16 ticks to a bit, a tick every `div` cycles. */
export const TWO_DIV = 1;
/** How many times A says ping. */
export const TWO_ROUNDS = 3;

/** The computers' UART at 0x3000_0000: data +0, status +4 (bit 0 receive FIFO not empty, bit 1 transmit FIFO full), divisor +8. */
const PRELUDE = `        li   s0, 0x80000000     # console
        li   s1, 0x30000000     # UART: data +0, status +4, divisor +8
        li   t0, ${TWO_DIV}
        sw   t0, 8(s1)          # bit rate = clock / (16 · divisor)`;

const SUBS = `send:   lw   t1, 4(s1)          # status
        andi t1, t1, 2          # transmit FIFO full?
        bnez t1, send
        sw   a0, 0(s1)          # queue the byte; the UART frames it
        ret
recv:   lw   t1, 4(s1)
        andi t1, t1, 1          # receive FIFO empty?
        beqz t1, recv
        lw   a0, 0(s1)          # the oldest received byte
        ret`;

const say = (word: string) => [...word, '\n'].map((c) => `        li   a0, ${c.charCodeAt(0)}${c === '\n' ? '             # new line ends the message' : `            # ${c}`}\n        jal  ra, send`).join('\n');

/** Computer A: says ping, prints what comes back (up to the newline), TWO_ROUNDS times, then stops on `j .`. */
export const PING_SOURCE = `# computer A: ping, wait for the answer, ${TWO_ROUNDS} times
${PRELUDE}
        li   s2, ${TWO_ROUNDS}
round:
${say('ping')}
reply:  jal  ra, recv           # the answer arrives a bit at a time
        sw   a0, 0(s0)          # print it
        li   t0, 10
        bne  a0, t0, reply
        addi s2, s2, -1
        bnez s2, round
halt:   j    halt
${SUBS}`;

/** Computer B: prints every byte it receives and, at each newline, answers pong. */
export const PONG_SOURCE = `# computer B: print what arrives; at each new line answer pong
${PRELUDE}
wait:   jal  ra, recv
        sw   a0, 0(s0)          # print it
        li   t0, 10
        bne  a0, t0, wait
${say('pong')}
        j    wait
${SUBS}`;

export const TWO_NOTES = 'Two computers talking over a wire, as chapter 43 ends. Each computer (double-click to open it) is an RV32I bus core with a boot ROM, a 16 KB RAM and a UART at 0x3000_0000 '
  + '(data +0, status +4: bit 0 receive FIFO not empty, bit 1 transmit FIFO full; divisor +8), on a bus of its own (the bus has two master ports; the second asks for nothing), and a console on the core. '
  + `A says ping and prints the answer, ${TWO_ROUNDS} times; B prints what it hears and answers pong at each new line. `
  + 'Each wire between them is a line part: a model of a cable (it delays what was sent by 2 clock cycles and flips it for a cycle while its noise input is 1), the one box here that does not end in transistors; everything else opens down to MOSFETs. '
  + `Both computers run on the one clock (the run loop drives every clock pin together), at ${16 * TWO_DIV} cycles a bit: to see what a wrong divisor does, edit one computer's program (the ROM part inside it: Edit program…) and change the \`li t0, ${TWO_DIV}\`. `
  + 'Hold the button NOISE A→B while a byte is in flight and B prints a wrong character, or nothing (a framing error: select the UART inside and read its status). '
  + 'The CPU drawer does not follow these cores (their memory and interrupts are behind the bus, so the golden model has nothing to compare): watch the consoles, or look inside. '
  + 'Export Verilog for FPGA…: each line becomes a pair of ports (x_…_d out, x_…_q in) to join with a wire on the board; the delay and the noise are the model\'s and are not exported.';

const size = (ref: PartRef): Vec => {
  const d = partDef(ref, () => undefined);
  if (isError(d)) throw new Error(d.error);
  const g = symbolGeom(d);
  return [g.w, g.h];
};

const COMPUTER_CODES = [MAP.ram, MAP.uart, 0xf];
const BUS = sandboxBus(COMPUTER_CODES);

/** One computer as a chip: clk and rx in, tx and the console's wires out. `role` names it in the notes. */
export function uartComputerChip(id: string, name: string, role: 'A' | 'B'): ChipDoc {
  const s = new Sheet();
  const lib = (d: { id: string }): PartRef => ({ lib: d.id });
  const bootRef: PartRef = { rom: { k: 7, w: 32, addr: 'rv32', lang: 'asm', src: role === 'A' ? PING_SOURCE : PONG_SOURCE } };
  const [bw, bh] = size(bootRef);
  const cpu = lib(SANDBOX_PARTS.cpu), bus = lib(BUS), ram = lib(SANDBOX_PARTS.ram), uart = lib(AXI_UART_B), def = lib(SANDBOX_PARTS.def);
  s.pin('clk', 'in', [2, 2], 1, { kind: 'clock' });
  s.pin('rx', 'in', [2, 8]);
  const x2 = 6 + bw + 16, [cw] = size(cpu);
  s.part('cpu', cpu, [x2, 6], { label: 'RV32I core' });
  // the boot ROM and the switches level with the core's inputs they feed, so both wires run straight
  s.part('zero', { const: { width: 8, value: 0 } }, [x2 - 12, s.port('cpu', 'switches').pos[1] - 1], { label: 'switches' });
  s.part('boot', bootRef, [6, s.port('cpu', 'romData').pos[1] - 2], { label: 'boot ROM' });
  void bh;
  const x3 = x2 + cw + 16, [uw] = size(bus);
  s.part('bus', bus, [x3, 6], { label: 'interconnect' });
  const x4 = x3 + uw + 16;
  let y = 6;
  for (const [n, ref, label] of [['ram', ram, 'RAM 16 KB'], ['uart', uart, 'UART'], ['none', def, 'default slave']] as const) {
    s.part(n, ref, [x4, y], { label });
    y += size(ref)[1] + 6;
  }
  s.pin('tx', 'out', [x4 + 26, s.port('uart', 'tx').pos[1]]);
  s.pin('conData', 'out', [x4 + 26, 8], 8);
  s.pin('conWe', 'out', [x4 + 26, 12]);
  // A request runs forward (core → interconnect → slave) and is a wire, each in a lane of its own; a response runs back and is a
  // pair of pointers, as are the clock, the pc back to the ROM, the interrupt and the console's wires across the slaves.
  // The bus has two masters; the second (a DMA engine in the other examples) asks for nothing: its request is all zeros, under the core.
  const zy = 6 + size(cpu)[1] + 6;
  s.part('z1', { const: { width: 53, value: 0 } }, [x3 - 15, zy], { label: 'no second master' });
  s.part('z2', { const: { width: 52, value: 0 } }, [x3 - 15, zy + 4]);
  s.part('zm', { merge: [53, 52] }, [x3 - 6, zy + 2]);
  s.wire('z1.y', 'zm.i0'); s.wire('z2.y', 'zm.i1');
  s.elbow('zm.out', 'bus.m1_req', x3 - 3);
  s.elbow('cpu.req', 'bus.m0_req', x3 - 9);
  s.tap('bus.m0_rsp', 'rsp'); s.tap('cpu.rsp', 'rsp');
  ['ram', 'uart', 'none'].forEach((n, k) => {
    s.elbow(`bus.s${k}_req`, `${n}.req`, x3 + uw + [12, 8, 4][k]);
    s.tap(`${n}.rsp`, `${n}_rsp`); s.tap(`bus.s${k}_rsp`, `${n}_rsp`);
  });
  s.tap('cpu.pcOut', 'pc'); s.tap('boot.addr', 'pc'); s.wire('boot.data', 'cpu.romData');
  s.wire('zero.y', 'cpu.switches');
  s.tap('uart.irq', 'irq'); s.tap('cpu.irq', 'irq');
  s.tap('pin:rx', 'rx'); s.tap('uart.rx', 'rx');
  s.wire('uart.tx', 'pin:tx');
  s.tap('cpu.consoleData', 'conData'); s.tap('pin:conData', 'conData');
  s.tap('cpu.consoleValid', 'conWe'); s.tap('pin:conWe', 'conWe');
  for (const p of ['cpu', 'bus', 'ram', 'uart', 'none']) s.tap(`${p}.clk`, 'clk');
  s.tap('pin:clk', 'clk');
  return s.doc(id, name, {
    notes: `Computer ${role} of Examples ▸ Two computers: an RV32I bus core, its boot ROM (${role === 'A' ? 'says ping, prints the answers' : 'prints what arrives, answers pong'}), a 16 KB RAM at 0 and a UART at 0x3000_0000 on one bus; tx and rx are the UART's line pins, conData / conWe the core's console.`,
  });
}

/** The sandbox's Two computers: A and B (chips of their own) joined by two line parts, a console under each. */
export function twoComputersChip(id: string, name: string, docs: { a: ChipDoc; b: ChipDoc }, delay = 2): ChipDoc {
  const s = new Sheet();
  const L = lineDef(delay), gl = symbolGeom(L);
  const A = chipBox(docs.a), B = chipBox(docs.b), ga = symbolGeom(A);
  const con: PartRef = { console: { cols: 24, rows: 6 } };
  const [, ch] = size(con);
  s.pin('clk', 'in', [2, 2], 1, { kind: 'clock' });
  s.pin('noiseAB', 'in', [2, 6], 1, { kind: 'button' });
  s.pin('noiseBA', 'in', [2, 10], 1, { kind: 'button' });
  const xa = 16, ya = 6, xl = xa + ga.w + 18, xb = xl + gl.w + 18;
  s.part('a', { chip: docs.a.id }, [xa, ya], { label: 'Computer A' }, A);
  s.part('b', { chip: docs.b.id }, [xb, ya], { label: 'Computer B' }, B);
  // the lines sit level with the pins they join: A's tx → ab.d above, B's tx → ba.d (mirrored, so d faces B) below
  const at = (port: Vec, g: Vec): Vec => [Math.round(port[0] - g[0]), Math.round(port[1] - g[1])];
  const dPos = gl.ports.d.pos as Vec;
  const atx = s.port('a', 'tx').pos, btx = s.port('b', 'tx').pos;
  s.part('ab', { lib: L.id }, [xl, at(atx, dPos)[1]], { label: 'A → B' });
  s.part('ba', { lib: L.id }, [xl, Math.max(at(btx, [gl.w - dPos[0], dPos[1]])[1], at(atx, dPos)[1] + gl.h + 6)], { label: 'B → A', flip: true });
  // the ring as wires: A's tx into A → B, on into B's rx; B's tx (its lowest output) round under B into B → A, and on round under
  // A into A's rx. The consoles' wires would cross it: pointers.
  s.wire('a.tx', 'ab.d');
  s.elbow('ab.q', 'b.rx', xb - 8);
  const [bt, bad] = [s.port('b', 'tx').pos, s.port('ba', 'd').pos], under = ya + ga.h + 5;
  s.wire('b.tx', 'ba.d', [[bt[0] + 1, bt[1]], [bt[0] + 1, under], [bad[0] + 4, under], [bad[0] + 4, bad[1]]]);
  const [baq, arx] = [s.port('ba', 'q').pos, s.port('a', 'rx').pos];
  s.wire('ba.q', 'a.rx', [[xa - 4, baq[1]], [xa - 4, arx[1]]]);
  s.tap('pin:noiseAB', 'noiseAB'); s.tap('ab.noise', 'noiseAB');
  s.tap('pin:noiseBA', 'noiseBA'); s.tap('ba.noise', 'noiseBA');
  for (const p of ['a', 'b', 'ab', 'ba']) s.tap(`${p}.clk`, 'clk');
  s.tap('pin:clk', 'clk');
  const yc = ya + Math.max(ga.h, 30) + 6;
  s.part('conA', con, [xa, yc], { label: 'console A (what A heard)' });
  s.part('conB', con, [xb, yc], { label: 'console B (what B heard)' });
  void ch;
  for (const [c, p] of [['conA', 'a'], ['conB', 'b']] as const) {
    s.tap(`${p}.conData`, `${p}Data`); s.tap(`${c}.data`, `${p}Data`);
    s.tap(`${p}.conWe`, `${p}We`); s.tap(`${c}.we`, `${p}We`);
    s.tap(`${c}.clk`, 'clk');
  }
  return s.doc(id, name, { notes: TWO_NOTES });
}
