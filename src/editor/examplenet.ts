// Examples ▸ Two computers on a switch: chapter 50's last scene as a sandbox chip. Two RV32I bus cores, each with a boot ROM, a RAM and a
// NIC (slave code 0x7; its master link sits on the interconnect's second master port), joined by a four-port learning switch through a
// MAC pair a port. Computer A sends a frame to B's address, B prints it and answers; the first frame is flooded (the switch has not met
// B), the answer goes to A's port alone, and the later frames of A go to B's port alone: watch the switch's counters.
//
// Everything is built on first use (build functions): the NIC, the switch and the MACs are large, and nothing here may be registered
// at import (tests/editor-unravel.test.ts round-trips every registered part). No chapter 50 stack: the drivers are short assembly,
// and the frames are raw Ethernet (type 0x0800, a five-byte payload), so a boot ROM of 256 words holds each.

import { MAP } from '../bus/model';
import { sandboxBus } from '../lib/axi';
import { SANDBOX_PARTS } from '../lib/soc';
import { switchId } from '../lib/ethswitch';
import { symbolGeom, type Vec } from '../sim/geometry';
import { SANDBOX_SWITCH } from './commparts';
import type { ChipDoc, PartRef } from './model';
import { Sheet, chipBox } from './example6502';
import { isError, partDef } from './parts';

/** How many times A says ping. */
export const LAN_ROUNDS = 3;
/** The two stations' addresses: 02:00:00:00:00:0a and :0b. */
export const LAN_MAC = { A: 0x0a, B: 0x0b } as const;

const size = (ref: PartRef): Vec => {
  const d = partDef(ref, () => undefined);
  if (isError(d)) throw new Error(d.error);
  const g = symbolGeom(d);
  return [g.w, g.h];
};

/** The NIC's ring set-up (rings at 0x1000 and 0x1040 of 8 descriptors; 128-byte buffers at 0x1100 and 0x1500) and the doorbell routine. */
const driver = (me: number) => `        li   s0, 0x80000000     # console
        li   s1, 0x70000000     # NIC: CTRL +0, STATUS +4, IE +8, RXBASE +12, TXBASE +16, MACL +20, MACH +24, KICK +28
        li   s2, 0x1000         # receive ring: 8 descriptors of (buffer address, OWN | length)
        li   s3, 0x1040         # transmit ring
        li   t0, 0
init:   slli t1, t0, 3          # 8 bytes a descriptor
        slli t3, t0, 7          # 128-byte buffers
        add  t2, s2, t1
        li   t4, 0x1100
        add  t4, t4, t3
        sw   t4, 0(t2)          # receive buffer i
        li   t5, 0x80000000
        sw   t5, 4(t2)          # OWN: the NIC may fill it
        add  t2, s3, t1
        li   t4, 0x1500
        add  t4, t4, t3
        sw   t4, 0(t2)          # transmit buffer i
        sw   zero, 4(t2)        # ours until we hand it over
        addi t0, t0, 1
        li   t6, 8
        blt  t0, t6, init
        sw   s2, 12(s1)         # RXBASE
        sw   s3, 16(s1)         # TXBASE
        li   t0, 2
        sw   t0, 20(s1)         # MACL: 02:00:00:00
        li   t0, 0x${me.toString(16)}00
        sw   t0, 24(s1)         # MACH: 00:${me.toString(16).padStart(2, '0')}   (this station is 02:00:00:00:00:${me.toString(16).padStart(2, '0')})
        li   t0, 1
        sw   t0, 0(s1)          # CTRL: enable
        li   s4, 0              # next transmit descriptor
        li   s5, 0              # next receive descriptor`;

/** send: a0..a3 = words 1..4 of the frame (the rest is the destination's first four bytes, zeros, the length 60); recv: wait for a frame, print its five payload bytes. */
const SUBS = `send:   slli t0, s4, 3
        add  t0, s3, t0         # transmit descriptor
        lw   t1, 0(t0)          # its buffer
        li   t2, 2
        sw   t2, 0(t1)          # destination 02:00:00:00 …
        sw   a0, 4(t1)          # … :xx:xx, then the source's first two bytes
        sw   a1, 8(t1)          # the source's last four
        sw   a2, 12(t1)         # type 0800, payload bytes 0 and 1
        sw   a3, 16(t1)         # payload bytes 2 to 4
        li   t3, 5
pad:    slli t4, t3, 2
        add  t4, t4, t1
        sw   zero, 0(t4)        # zeros up to 60 bytes
        addi t3, t3, 1
        li   t5, 15
        blt  t3, t5, pad
        li   t2, 0x8000003c     # OWN | 60 bytes
        sw   t2, 4(t0)
        li   t2, 1
        sw   t2, 28(s1)         # KICK: the doorbell
        addi s4, s4, 1
        andi s4, s4, 7
        ret
recv:   slli t0, s5, 3
        add  t0, s2, t0         # receive descriptor
wait:   lw   t1, 4(t0)
        bltz t1, wait           # OWN still set: nothing yet
        lw   t2, 0(t0)          # its buffer
        lw   t3, 12(t2)         # type, payload 0 and 1
        srli t4, t3, 16
        andi t4, t4, 255
        sw   t4, 0(s0)          # print the payload
        srli t4, t3, 24
        sw   t4, 0(s0)
        lw   t3, 16(t2)
        andi t4, t3, 255
        sw   t4, 0(s0)
        srli t4, t3, 8
        andi t4, t4, 255
        sw   t4, 0(s0)
        srli t4, t3, 16
        andi t4, t4, 255
        sw   t4, 0(s0)
        li   t1, 0x80000000
        sw   t1, 4(t0)          # give the buffer back
        addi s5, s5, 1
        andi s5, s5, 7
        ret`;

// the frames: words 1..4 for "ping" from A to B, "pong" from B to A (little-endian bytes)
const frameWords = (to: number, from: number, word: string) => {
  const w = (b0: number, b1: number, b2: number, b3: number) => `0x${(((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0).toString(16).padStart(8, '0')}`;
  const c = (i: number) => word.charCodeAt(i);
  return [w(0, to, 2, 0), w(0, 0, 0, from), w(8, 0, c(0), c(1)), w(c(2), c(3), 10, 0)];
};
const sendCode = (to: number, from: number, word: string) => frameWords(to, from, word).map((x, i) => `        li   a${i}, ${x}`).join('\n') + '\n        jal  ra, send';

/** Computer A: says ping to B, prints the answer, LAN_ROUNDS times, then stops on `j .`. */
export const LAN_PING_SOURCE = `# computer A (02:00:00:00:00:0a): ping B, print what comes back, ${LAN_ROUNDS} times
${driver(LAN_MAC.A)}
        li   s6, ${LAN_ROUNDS}
round:
${sendCode(LAN_MAC.B, LAN_MAC.A, 'ping')}
        jal  ra, recv           # the answer: a frame from B
        addi s6, s6, -1
        bnez s6, round
halt:   j    halt
${SUBS}`;

/** Computer B: prints every frame it receives and answers pong. */
export const LAN_PONG_SOURCE = `# computer B (02:00:00:00:00:0b): print each frame's payload, answer pong
${driver(LAN_MAC.B)}
again:  jal  ra, recv
${sendCode(LAN_MAC.A, LAN_MAC.B, 'pong')}
        j    again
${SUBS}`;

export const LAN_NOTES = 'Two computers and a switch, as chapter 50 ends. Each computer (double-click to open it) is an RV32I bus core with a boot ROM, a 16 KB RAM and a NIC at 0x7000_0000 '
  + '(chapter 50\'s: eight registers, two rings of descriptors in RAM, DMA as the interconnect\'s second master, a MAC inside), on a bus of its own. A is 02:00:00:00:00:0a and B :0b. '
  + `A sends B a raw 60-byte Ethernet frame saying ping and prints B's pong, ${LAN_ROUNDS} times; B prints each frame it receives and answers. `
  + 'Open the switch (double-click): a MAC RX and a MAC TX a port join the computers\' serial pairs (one bit every four clocks) to the byte streams of chapter 49\'s four-port learning switch; ports 2 and 3 are unplugged. '
  + 'Select the switch part inside to read its learned table and per-port counters live. The first ping is flooded (the switch has not met B yet), the pong goes to port 0 alone, and A\'s later pings go to port 1 alone: learned 2, flooded 1. '
  + 'A frame crosses the wire in about 2 300 clocks and the switch stores it before forwarding, so a ping and its pong take about 10 000: Run at the maximum clock rate and wait. '
  + 'The CPU drawer does not follow these cores (their memory is behind a bus): watch the consoles, or select a NIC and read its registers.';

/** One computer as a chip: clk, rxd, crs in; txd, txen and the console's wires out. */
export function lanComputerChip(id: string, name: string, role: 'A' | 'B'): ChipDoc {
  const s = new Sheet();
  const codes = [MAP.ram, MAP.nic, 0xf], bus = sandboxBus(codes);
  const lib = (d: { id: string }): PartRef => ({ lib: d.id });
  const bootRef: PartRef = { rom: { k: 8, w: 32, addr: 'rv32', lang: 'asm', src: role === 'A' ? LAN_PING_SOURCE : LAN_PONG_SOURCE } };
  const [bw, bh] = size(bootRef);
  const cpu = lib(SANDBOX_PARTS.cpu), busRef = lib(bus), ram = lib(SANDBOX_PARTS.ram), nic: PartRef = { lib: 'nic_b' }, def = lib(SANDBOX_PARTS.def);
  s.pin('clk', 'in', [2, 2], 1, { kind: 'clock' });
  s.pin('rxd', 'in', [2, 8]);
  s.pin('crs', 'in', [2, 14]);
  s.part('boot', bootRef, [6, 6], { label: 'boot ROM' });
  s.part('zero', { const: { width: 8, value: 0 } }, [6, 6 + bh + 6], { label: 'switches' });
  const x2 = 6 + bw + 16, [cw] = size(cpu);
  s.part('cpu', cpu, [x2, 6], { label: 'RV32I core' });
  const x3 = x2 + cw + 16, [uw] = size(busRef);
  s.part('bus', busRef, [x3, 6], { label: 'interconnect' });
  const x4 = x3 + uw + 16;
  let y = 6;
  for (const [n, ref, label] of [['ram', ram, 'RAM 16 KB'], ['nic', nic, 'NIC'], ['none', def, 'default slave']] as const) {
    s.part(n, ref, [x4, y], { label });
    y += size(ref)[1] + 6;
  }
  s.pin('txd', 'out', [x4 + 30, 8]);
  s.pin('txen', 'out', [x4 + 30, 14]);
  s.pin('conData', 'out', [x4 + 30, 20], 8);
  s.pin('conWe', 'out', [x4 + 30, 26]);
  s.tap('cpu.req', 'req'); s.tap('bus.m0_req', 'req'); s.tap('bus.m0_rsp', 'rsp'); s.tap('cpu.rsp', 'rsp');
  // the NIC is the second master: its DMA requests go where the example of the UART tied an idle request
  s.tap('nic.m_req', 'dma_req'); s.tap('bus.m1_req', 'dma_req'); s.tap('bus.m1_rsp', 'dma_rsp'); s.tap('nic.m_rsp', 'dma_rsp');
  ['ram', 'nic', 'none'].forEach((n, k) => {
    s.tap(`bus.s${k}_req`, `${n}_req`); s.tap(`${n}.req`, `${n}_req`);
    s.tap(`${n}.rsp`, `${n}_rsp`); s.tap(`bus.s${k}_rsp`, `${n}_rsp`);
  });
  s.tap('cpu.pcOut', 'pc'); s.tap('boot.addr', 'pc'); s.tap('boot.data', 'instr'); s.tap('cpu.romData', 'instr');
  s.tap('zero.y', 'sw'); s.tap('cpu.switches', 'sw');
  s.tap('nic.irq', 'irq'); s.tap('cpu.irq', 'irq');
  s.tap('pin:rxd', 'rxd'); s.tap('nic.rxd', 'rxd'); s.tap('pin:crs', 'crs'); s.tap('nic.crs', 'crs');
  s.tap('nic.txd', 'txd'); s.tap('pin:txd', 'txd'); s.tap('nic.txen', 'txen'); s.tap('pin:txen', 'txen');
  s.tap('cpu.consoleData', 'conData'); s.tap('pin:conData', 'conData');
  s.tap('cpu.consoleValid', 'conWe'); s.tap('pin:conWe', 'conWe');
  for (const p of ['cpu', 'bus', 'ram', 'nic', 'none']) s.tap(`${p}.clk`, 'clk');
  s.tap('pin:clk', 'clk');
  return s.doc(id, name, {
    notes: `Computer ${role} of Examples ▸ Two computers on a switch: an RV32I bus core, its boot ROM (${role === 'A' ? 'says ping to B, prints B\'s pong' : 'prints each frame, answers pong'}), a 16 KB RAM at 0 and a NIC at 0x7000_0000 on one bus (the NIC's DMA is the second master); txd / txen are the NIC's serial pair out, rxd / crs in; conData / conWe the core's console.`,
  });
}

/** The switch with two ports plugged in: a MAC receiver and a MAC transmitter each, ports 2 and 3 idle; the counters out. */
export function lanSwitchChip(id: string, name: string): ChipDoc {
  const s = new Sheet();
  const SW: PartRef = { lib: switchId(SANDBOX_SWITCH) };
  const RX: PartRef = { lib: 'eth_mac_rx' }, TX: PartRef = { lib: 'eth_mac_tx' };
  const [sw, shh] = size(SW);
  const [rw, rh] = size(RX), [tw, th] = size(TX);
  void sw;
  const x1 = 30, xs = x1 + rw + 26;
  s.pin('clk', 'in', [2, 2], 1, { kind: 'clock' });
  (['A', 'B'] as const).forEach((c, i) => {
    s.pin(`${c}_txd`, 'in', [2, 8 + 6 * i]); s.pin(`${c}_txen`, 'in', [2, 14 + 6 * i]);
  });
  s.part('sw', SW, [xs, 4], { label: '4-port switch' });
  const xe = xs + sw + 26;
  const rows = [4 + shh + 8, 4 + shh + 8 + Math.max(rh, th) + 6];
  (['A', 'B'] as const).forEach((c, i) => {
    const p = i;
    s.part(`rx${p}`, RX, [x1, rows[i]], { label: `port ${p} MAC RX` });
    s.part(`tx${p}`, TX, [xe, rows[i]], { label: `port ${p} MAC TX` });
    s.tap(`pin:${c}_txd`, `${c}_txd`); s.tap(`rx${p}.rxd`, `${c}_txd`);
    s.tap(`pin:${c}_txen`, `${c}_txen`); s.tap(`rx${p}.crs`, `${c}_txen`);
    s.pin(`${c}_rxd`, 'out', [xe + tw + 24, rows[i] + 4 + 6 * i]); s.pin(`${c}_crs`, 'out', [xe + tw + 24, rows[i] + 10 + 6 * i]);
    s.tap(`tx${p}.txd`, `${c}_rxd`); s.tap(`pin:${c}_rxd`, `${c}_rxd`);
    s.tap(`tx${p}.txen`, `${c}_crs`); s.tap(`pin:${c}_crs`, `${c}_crs`);
    for (const n of ['data', 'valid', 'last']) { s.tap(`rx${p}.${n}`, `rx${p}_${n}`); }
    s.tap(`rx${p}.err`, `rx${p}_err`);
    s.tap(`sw.rxData${p}`, `rx${p}_data`); s.tap(`sw.rxValid${p}`, `rx${p}_valid`); s.tap(`sw.rxLast${p}`, `rx${p}_last`); s.tap(`sw.rxErr${p}`, `rx${p}_err`);
    s.tap(`sw.txData${p}`, `tx${p}_data`); s.tap(`sw.txValid${p}`, `tx${p}_valid`); s.tap(`sw.txLast${p}`, `tx${p}_last`);
    s.tap(`tx${p}.data`, `tx${p}_data`); s.tap(`tx${p}.valid`, `tx${p}_valid`); s.tap(`tx${p}.last`, `tx${p}_last`);
    s.tap(`tx${p}.ready`, `tx${p}_ready`); s.tap(`sw.txReady${p}`, `tx${p}_ready`);
    s.tap(`rx${p}.ready`, `rx${p}_ready`); s.tap(`sw.rxReady${p}`, `rx${p}_ready`);
  });
  // constants: the MACs' reset low, promiscuous, no address filter, no carrier sensed or collision on the transmit side; ports 2 and 3 unplugged
  const zy = rows[1] + Math.max(rh, th) + 8;
  s.part('zero', { const: { width: 1, value: 0 } }, [x1, zy], { label: 'low' });
  s.part('one', { const: { width: 1, value: 1 } }, [x1, zy + 6], { label: 'high' });
  s.part('zero8', { const: { width: 8, value: 0 } }, [x1, zy + 12], { label: 'no data' });
  s.part('addr0', { const: { width: 48, value: 0 } }, [x1, zy + 18], { label: 'address (unused: promiscuous)' });
  s.part('seed', { const: { width: 10, value: 0x155 } }, [x1, zy + 24], { label: 'backoff seed (unused)' });
  const lows = ['rx0.rst', 'rx1.rst', 'tx0.rst', 'tx1.rst', 'tx0.crs', 'tx1.crs', 'tx0.col', 'tx1.col'];
  for (const e of ['sw.rxValid2', 'sw.rxValid3', 'sw.rxLast2', 'sw.rxLast3', 'sw.rxErr2', 'sw.rxErr3', ...lows]) s.tap(e, 'low');
  s.tap('zero.y', 'low');
  for (const e of ['sw.txReady2', 'sw.txReady3', 'rx0.promisc', 'rx1.promisc']) s.tap(e, 'high');
  s.tap('one.y', 'high');
  s.tap('sw.rxData2', 'nodata'); s.tap('sw.rxData3', 'nodata'); s.tap('zero8.y', 'nodata');
  s.tap('rx0.addr', 'noaddr'); s.tap('rx1.addr', 'noaddr'); s.tap('addr0.y', 'noaddr');
  s.tap('tx0.seed', 'seed'); s.tap('tx1.seed', 'seed'); s.tap('seed.y', 'seed');
  for (const e of ['sw', 'rx0', 'rx1', 'tx0', 'tx1']) s.tap(`${e}.clk`, 'clk');
  s.tap('pin:clk', 'clk');
  // the counters out
  let py = 4;
  for (const c of ['learned', 'evicted', 'flooded', 'filtered']) {
    s.pin(c, 'out', [xs + sw + 60, py], 16); s.tap(`sw.${c}`, c); s.tap(`pin:${c}`, c); py += 6;
  }
  return s.doc(id, name, {
    notes: 'Chapter 49\'s switch with two of its four ports plugged in. Each plugged port is a MAC receiver (the bits of the computer\'s transmitter become the byte stream the switch takes) and a MAC transmitter (the switch\'s byte stream becomes bits for the computer\'s receiver); the receivers accept every destination (promiscuous), as a switch port must. Ports 2 and 3 are unplugged: nothing arrives, and their transmit sides are always ready, so a flooded frame leaves. Select the switch to read its learned table and counters.',
  });
}

/** The sandbox's Two computers on a switch: A and B (chips of their own) either side of the switch chip, a console under each, the switch's counters as numbers. */
export function lanTopChip(id: string, name: string, docs: { a: ChipDoc; b: ChipDoc; sw: ChipDoc }): ChipDoc {
  const s = new Sheet();
  const A = chipBox(docs.a), B = chipBox(docs.b), S = chipBox(docs.sw);
  const ga = symbolGeom(A), gs = symbolGeom(S);
  const con: PartRef = { console: { cols: 24, rows: 6 } };
  s.pin('clk', 'in', [2, 2], 1, { kind: 'clock' });
  const xa = 14, ya = 6, xs = xa + ga.w + 24, xb = xs + gs.w + 24;
  s.part('a', { chip: docs.a.id }, [xa, ya], { label: 'Computer A' }, A);
  s.part('sw', { chip: docs.sw.id }, [xs, ya], { label: 'Switch' }, S);
  s.part('b', { chip: docs.b.id }, [xb, ya], { label: 'Computer B' }, B);
  for (const [c, p] of [['A', 'a'], ['B', 'b']] as const) {
    s.tap(`${p}.txd`, `${c}_txd`); s.tap(`sw.${c}_txd`, `${c}_txd`);
    s.tap(`${p}.txen`, `${c}_txen`); s.tap(`sw.${c}_txen`, `${c}_txen`);
    s.tap(`sw.${c}_rxd`, `${c}_rxd`); s.tap(`${p}.rxd`, `${c}_rxd`);
    s.tap(`sw.${c}_crs`, `${c}_crs`); s.tap(`${p}.crs`, `${c}_crs`);
  }
  for (const p of ['a', 'b', 'sw']) s.tap(`${p}.clk`, 'clk');
  s.tap('pin:clk', 'clk');
  const yc = ya + Math.max(ga.h, gs.h) + 6;
  s.part('conA', con, [xa, yc], { label: 'console A (what A heard)' });
  s.part('conB', con, [xb, yc], { label: 'console B (what B heard)' });
  for (const [c, p] of [['conA', 'a'], ['conB', 'b']] as const) {
    s.tap(`${p}.conData`, `${p}Data`); s.tap(`${c}.data`, `${p}Data`);
    s.tap(`${p}.conWe`, `${p}We`); s.tap(`${c}.we`, `${p}We`);
    s.tap(`${c}.clk`, 'clk');
  }
  let vy = yc;
  for (const c of ['learned', 'evicted', 'flooded', 'filtered']) {
    s.part(`v_${c}`, { display: 'value', width: 16 }, [xs, vy], { label: `${c} (frames)` });
    s.tap(`sw.${c}`, c); s.tap(`v_${c}.a`, c);
    vy += 6;
  }
  return s.doc(id, name, { notes: LAN_NOTES });
}
