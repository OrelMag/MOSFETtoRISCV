import { describe, expect, it } from 'vitest';
import { lineStream } from '../src/comm/uart';
import { BusModel } from '../src/bus/model';
import { busComputer, socDevices, type SocOptions } from '../src/lib/soc';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { uartPollSource } from '../src/riscv/uartprograms';
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
