import { describe, expect, it } from 'vitest';
import { lineStream } from '../src/comm/uart';
import { BusModel } from '../src/bus/model';
import { busComputer, socDevices, type SocOptions } from '../src/lib/soc';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { RxFeeder } from '../src/comm/uartdrive';
import { UART_COSTS, uartCostIrq, uartCostPoll, uartIrqSource, uartPollSource } from '../src/riscv/uartprograms';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';
import { tick } from './yieldtick';

const IMEM_K = 8, RAM_K = 8;
const words = (src: string) => { const a = assemble(src); if (a.errors.length) throw new Error(a.errors[0].message); return a.words; };

/** The computer with a UART and a ROM program, the golden model beside it, a line fed to the rx pin. */
async function run(src: string, line: (k: number) => number, cycles: number, lock = true) {
  const o: SocOptions = { imemK: IMEM_K, ramK: RAM_K, uart: true, keys: true };
  const program = words(src);
  const sim = new GateSim(flatten(busComputer(program, [], o)));
  sim.reset('zero');
  sim.setInput('clk', 0); sim.setInput('switches', 0); sim.setInput('uartRx', 1);
  sim.settle();
  const bus = new BusModel(RAM_K, [], 4096, { ...socDevices(o), uart: { rx: line } });
  bus.uart!.trace = [];
  const iss = new ISS(program, { system: true, imemWords: 2 ** IMEM_K, bus });
  const root = sim.design.root, rf = root.children!.get('cpu')!.children!.get('rf')!;
  const out = (p: string) => pack(sim.getBits(root.ports[p]));
  const regs = () => [0, ...Array.from({ length: 31 }, (_, i) => pack(sim.getBits(rf.children!.get(`w${i + 1}`)!.ports.q)) >>> 0)];
  let gateConsole = '';
  const txLog: number[] = [];
  let retired = 0;
  for (let c = 0; c < cycles; c++) {
    sim.setInput('uartRx', line(c)); sim.settle();
    const retire = out('retire') === 1;
    if (out('consoleValid') === 1) gateConsole += String.fromCharCode(out('consoleData'));
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    txLog.push(out('uartTx'));
    if (c % 4000 === 0) await tick();
    if (!retire) continue;
    retired++;
    if (!lock) continue;
    bus.now = c + 1;
    const info = iss.step();
    const x = regs();
    for (let r = 1; r < 32; r++) expect(x[r], `x${r} after ${info.text} at 0x${info.pc.toString(16)} (cycle ${c})`).toBe(iss.x[r] >>> 0);
  }
  return { sim, bus, iss, gateConsole, txLog, retired };
}

describe('the computer with a UART, in lock-step with the golden model', () => {
  it('polled echo: bytes from the line reach the console, registers and the transmitted frame agree every cycle', async () => {
    const div = 1, msg = 'ok!';
    const line = lineStream([...msg].map((ch) => ch.charCodeAt(0)), 16 * div, 3000.5, 0);
    const r = await run(uartPollSource(div), line, 3000 + 16 * 10 * 4 + 400);
    expect(r.gateConsole).toBe(msg);
    expect(r.iss.console).toBe(msg);
    // the transmitted frames ("Hi") on the gates' pin match the model's, edge by edge
    r.bus.uart!.advanceTo(r.txLog.length);
    expect(r.txLog).toEqual(r.bus.uart!.trace!.slice(0, r.txLog.length));
    expect(r.txLog.includes(0)).toBe(true);
  }, 240000);
});

/** What the CPU does per received byte, polling against interrupts, measured on the gates (pc and the UART's own ports every cycle). */
async function measureCosts(div: number, n: number) {
  const o: SocOptions = { imemK: IMEM_K, ramK: RAM_K, uart: true };
  const bytes = Array.from({ length: n }, (_, i) => 0x41 + i);
  const line = lineStream(bytes, 16 * div, 600.5, 0);
  const res: Record<string, { cycles: number; latency: number[]; entry: number[]; handler: number; free: number; sum: number }> = {};
  for (const kind of ['poll', 'irq'] as const) {
    const src = kind === 'poll' ? uartCostPoll(div, n) : uartCostIrq(div, n);
    const asm = assemble(src), program = asm.words;
    const hpc = asm.labels?.get?.('handler') as number | undefined;
    const sim = new GateSim(flatten(busComputer(program, [], o)));
    sim.reset('zero'); sim.setInput('clk', 0); sim.setInput('switches', 0); sim.setInput('uartRx', 1); sim.settle();
    const root = sim.design.root, u = root.children!.get('uart')!, rf = root.children!.get('cpu')!.children!.get('rf')!;
    const reg = (i: number) => pack(sim.getBits(rf.children!.get(`w${i}`)!.ports.q)) >>> 0;
    const uart = (p: string) => pack(sim.getBits(u.ports[p]));
    const core = u.children!.get('core')!;
    const status = () => pack(sim.getBits(core.ports.status));
    let rise = -1, irqAt = -1, inH = 0, prevInH = false, handlerCycles = 0, mainCycles = 0, c = 0;
    const latency: number[] = [], entry: number[] = [];
    for (; c < 4000 + n * 16 * 10 * div * 2; c++) {
      sim.setInput('uartRx', line(c)); sim.settle();
      const pc = pack(sim.getBits(root.ports.pcOut)) >>> 0;
      const irq = uart('irq') === 1, rxne = (status() & 1) === 1;
      if (rxne && rise < 0) rise = c;
      if (!rxne && rise >= 0) { latency.push(c - rise); rise = -1; }
      if (kind === 'irq') {
        const inHandler = hpc !== undefined && pc >= hpc;
        if (irq && irqAt < 0 && !inHandler) irqAt = c;
        if (inHandler && !prevInH) { if (irqAt >= 0) entry.push(c - irqAt); irqAt = -1; inH++; }
        prevInH = inHandler;
        if (inHandler) handlerCycles++; else mainCycles++;
      }
      sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
      if (reg(23) === 1) break; // s7
      if (c % 4000 === 0) await tick();
    }
    res[kind] = { cycles: c, latency, entry, handler: handlerCycles, free: mainCycles, sum: reg(22) };
    void inH;
  }
  return res;
}

describe('polling against interrupts, measured on the gates (riscv/uartprograms.ts UART_COSTS)', () => {
  it('pins the constants the chapter quotes', async () => {
    const r = await measureCosts(1, 8);
    expect(r.poll.sum).toBe(r.irq.sum);
    expect(Math.min(...r.poll.latency)).toBe(UART_COSTS.pollLatency[0]);
    expect(Math.max(...r.poll.latency)).toBe(UART_COSTS.pollLatency[1]);
    expect(r.irq.latency.every((x) => x === UART_COSTS.irqLatency)).toBe(true);
    expect(r.irq.handler / 8).toBe(UART_COSTS.handlerPerByte);
    expect(Math.round((1000 * r.irq.free) / r.irq.cycles)).toBe(UART_COSTS.freePermille);
  }, 240000);
});

describe('Send to rx on a fresh scene', () => {
  it('"Hello" queued at cycle 0 waits for the program to set the divisor and arrives intact', async () => {
    const o: SocOptions = { imemK: IMEM_K, ramK: RAM_K, uart: true };
    const sim = new GateSim(flatten(busComputer(words(uartIrqSource(2)), [0], o)));
    sim.reset('zero'); sim.setInput('clk', 0); sim.setInput('switches', 0); sim.setInput('uartRx', 1); sim.settle();
    const root = sim.design.root, core = root.children!.get('uart')!.children!.get('core')!;
    const out = (p: string) => pack(sim.getBits(root.ports[p]));
    const f = new RxFeeder(1);
    f.send('Hello');
    let cons = '';
    for (let c = 0; c < 6000; c++) {
      sim.setInput('uartRx', f.level(pack(sim.getBits(core.ports.div)))); sim.settle();
      if (out('consoleValid') === 1) cons += String.fromCharCode(out('consoleData'));
      sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
      if (c % 3000 === 0) await tick();
    }
    expect(cons).toBe('Hello');
  }, 120000);
});
