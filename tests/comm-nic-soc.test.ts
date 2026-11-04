// A computer with a NIC (lib/soc.ts nic option) running the assembly driver (riscv/nicprograms.ts) with its transmitter looped back to its receiver:
// the golden model beside the gates, the NIC's model fed the inputs the gates saw and compared on every output every clock, the instruction-set
// simulator compared with the register file after every retired instruction; then what the driver costs, polled against by interrupt, read off the gates.

import { describe, expect, it } from 'vitest';
import { BusModel, MAP } from '../src/bus/model';
import type { NicIn } from '../src/comm/nic';
import { STACK_LAYOUT as L, STACK_RAM_K } from '../src/comm/stack/layout';
import { busComputer, type SocOptions } from '../src/lib/soc';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { NIC_COSTS, nicIrqSource, nicPollSource } from '../src/riscv/nicprograms';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';
import { NIC_OUTS } from './nickit';
import { tick } from './yieldtick';

const IMEM_K = 8;
const words = (src: string) => { const a = assemble(src); if (a.errors.length) throw new Error(`${a.errors[0].message} (line ${a.errors[0].line})`); return a.words; };
const SOC: SocOptions = { imemK: IMEM_K, ramK: STACK_RAM_K, nic: true };

/** The computer, its transmitter wired to its receiver; `lock` compares the ISS and the NIC model with the gates. */
function build(src: string, lock: boolean) {
  const program = words(src);
  const sim = new GateSim(flatten(busComputer(program, [0], SOC)));
  sim.reset('zero');
  sim.setInput('clk', 0); sim.setInput('switches', 0); sim.setInput('rxd', 0); sim.setInput('crs', 0);
  sim.settle();
  const bus = new BusModel(STACK_RAM_K, [], 4096, { nic: {} });
  bus.nic!.replay = true;
  const iss = new ISS(program, { system: true, imemWords: 2 ** IMEM_K, bus });
  const root = sim.design.root, nicNode = root.children!.get('nic')!, rf = root.children!.get('cpu')!.children!.get('rf')!;
  const out = (p: string) => pack(sim.getBits(root.ports[p]));
  const np = (p: string) => pack(sim.getBits(nicNode.ports[p])) >>> 0;
  const reg = (i: number) => (i === 0 ? 0 : pack(sim.getBits(rf.children!.get(`w${i}`)!.ports.q)) >>> 0);
  const IN_PORTS = ['awvalid', 'awaddr', 'wvalid', 'wdata', 'wstrb', 'bready', 'arvalid', 'araddr', 'rready', 'm_awready', 'm_wready', 'm_bvalid', 'm_arready', 'm_rvalid', 'm_rdata', 'rxd', 'crs'] as const;
  let c = 0, retired = 0, irqAt = -1;
  const step = (): { retire: boolean } => {
    // the line: the transmitter's pair straight into the receiver
    sim.setInput('rxd', out('txd')); sim.setInput('crs', out('txen')); sim.settle();
    const retire = out('retire') === 1;
    if (lock) {
      const i = {} as NicIn;
      for (const p of IN_PORTS) (i as unknown as Record<string, number>)[p] = np(p);
      const o = bus.nic!.step(i);
      for (const k of NIC_OUTS) expect(np(k), `NIC ${k} at clock ${c}`).toBe((o[k] as number) >>> 0);
      // the NIC's DMA write lands in the model's RAM at its handshake
      if (o.m_awvalid && o.m_wvalid && i.m_awready && i.m_wready) {
        const w = (o.m_awaddr >>> 2) % bus.ram.length;
        let mask = 0;
        for (let b = 0; b < 4; b++) if ((o.m_wstrb >> b) & 1) mask |= 255 << (8 * b);
        bus.ram[w] = ((bus.ram[w] & ~mask) | (o.m_wdata & mask)) >>> 0;
      }
    }
    if (np('irq') === 1 && irqAt < 0) irqAt = c;
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    c++;
    if (retire) {
      retired++;
      if (lock) {
        bus.now = c;
        iss.mtime = c - 1; // the timer counts clocks; the golden model counts instructions, so it is told
        const info = iss.step();
        for (let r = 1; r < 32; r++) expect(reg(r), `x${r} after ${info.text} at 0x${info.pc.toString(16)} (clock ${c - 1})`).toBe(iss.x[r] >>> 0);
      }
    }
    return { retire };
  };
  return { sim, bus, iss, step, reg, out, np, get clocks() { return c; }, get retired() { return retired; }, get irqAt() { return irqAt; } };
}

describe('the computer with a NIC, in lock-step', () => {
  it('polled driver: rings set up, a frame sent to itself and taken in; registers every instruction, NIC every output every clock', async () => {
    const m = build(nicPollSource(), true);
    for (let n = 0; n < 12000 && m.reg(23) !== 1; n++) { m.step(); if (n % 3000 === 0) await tick(); }
    expect(m.reg(23)).toBe(1); // s7: done
    expect(m.reg(24)).toBe(64); // s8: the length the NIC wrote
    // the frame is in receive buffer 0, as sent
    const sent = Array.from({ length: 64 }, (_, i) => (m.bus.ram[(L.txBuf + i) >>> 2] >>> (8 * (i & 3))) & 255);
    const got = Array.from({ length: 64 }, (_, i) => (m.bus.ram[(L.rxBuf + i) >>> 2] >>> (8 * (i & 3))) & 255);
    expect(got).toEqual(sent);
    expect(m.bus.ram[(L.rxRing + 4) >>> 2] >>> 0).toBe(64);
    expect(m.bus.ram[(L.txRing + 4) >>> 2] >>> 0).toBe(64);
    void MAP;
  }, 300000);
});

/** Run a driver and read the cost of each step off the gates. */
export async function measureDriver(src: string) {
  const m = build(src, false);
  const hpc = assemble(src).labels?.get?.('handler') as number | undefined;
  let irqRise = -1, handlerAt = -1, handlerClocks = 0, mainClocks = 0, txStart = -1, txEnd = -1, inHandler = false;
  const root = m.sim.design.root;
  for (let n = 0; n < 12000 && m.reg(23) !== 1; n++) {
    const pc = pack(m.sim.getBits(root.ports.pcOut)) >>> 0;
    const h = hpc !== undefined && pc >= hpc && inHandler === (pc >= hpc);
    if (hpc !== undefined && pc >= hpc) { if (handlerAt < 0) handlerAt = m.clocks; handlerClocks++; inHandler = true; } else if (m.reg(20) !== 0) mainClocks++;
    void h;
    if (m.out('txen') === 1 && txStart < 0) txStart = m.clocks;
    if (m.out('txen') === 0 && txStart >= 0 && txEnd < 0) txEnd = m.clocks;
    m.step();
    if (m.np('irq') === 1 && irqRise < 0) irqRise = m.clocks;
    if (n % 3000 === 0) await tick();
  }
  const r = (i: number) => m.reg(i);
  return { done: r(23), kick: r(20), seen: r(21), count: r(22), len: r(24), setup: r(25), doorbell: r(26) - r(20), irqRise, handlerAt, handlerClocks, mainClocks, txStart, txEnd, clocks: m.clocks };
}

describe('what the driver costs, read off the gates', () => {
  it('polled and by interrupt: the same frame arrives after the same time; the interrupt frees the CPU', async () => {
    const poll = await measureDriver(nicPollSource()), irq = await measureDriver(nicIrqSource());
    expect(poll.done).toBe(1);
    expect(irq.done).toBe(1);
    expect(poll.len).toBe(64);
    expect(irq.len).toBe(64);
    const got = {
      // the cable: preamble, SFD, 64 bytes, FCS = 76 bytes of 32 clocks
      wireClocks: poll.txEnd - poll.txStart,
      // from the doorbell store to the transmitter's first bit
      doorbellToWire: poll.txStart - poll.kick,
      // from the doorbell to the CPU seeing the frame in its receive descriptor, polled and by interrupt
      pollSeen: poll.seen - poll.kick, irqSeen: irq.seen - irq.kick,
      // one pass of the poll loop (addi, lw, bltz) and how many there were
      pollPass: Math.round((poll.seen - poll.kick) / poll.count), polls: poll.count,
      // the interrupt: asserted at, first handler instruction at, handler clocks, share of the clocks the main loop had
      irqEntry: irq.handlerAt - irq.irqRise, handler: irq.handlerClocks,
      freePermille: Math.round((1000 * irq.mainClocks) / (irq.mainClocks + irq.handlerClocks)),
      doorbell: poll.doorbell,
    };
    console.log(JSON.stringify(got), JSON.stringify({ poll, irq }));
    expect(got).toEqual({ ...NIC_COSTS });
  }, 300000);
});
