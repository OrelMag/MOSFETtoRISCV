// Chapter codes's setting: computer A sends computer B a stream across a router, the Python TCP on both, on the model-speed bench (net/lanbench.ts). Shared by the chapter's
// panels, scripts/tcp-costs.ts (src/net/tcpcosts.json) and the tests.

import { ip4 } from '../comm/netframes';
import { DEFAULT_STACK } from '../comm/stack/all';
import { stackProgram, type StackBuild } from '../comm/stack';
import { TCP } from '../comm/stack/tcp';
import { tcpReceiver, tcpSender, type TcpHost } from '../comm/stack/tcpapps';
import { Host, LanBench, RouterMiddle } from './lanbench';

export const HOST_A: TcpHost = { ip: ip4(10, 0, 1, 2), mac: [2, 0, 0, 0, 1, 2], gw: ip4(10, 0, 1, 1), gwMac: [2, 0, 0, 0, 1, 1] };
export const HOST_B: TcpHost = { ip: ip4(10, 0, 2, 2), mac: [2, 0, 0, 0, 2, 2], gw: ip4(10, 0, 2, 1), gwMac: [2, 0, 0, 0, 2, 1] };

export interface BenchOptions {
  /** Frames the router's queue towards B holds, the one in service included. */
  queue?: number;
  /** Clocks a byte takes on the link to B (the wire's 32 or more). */
  byteClocks?: number;
  /** One way through the router, clocks. */
  delay?: number;
  /** Decides a frame's fate. */
  lose?: (from: number, frame: number[]) => boolean;
  /** Clocks between the receiving application's reads. */
  readEvery?: number;
}

const builds = new Map<string, StackBuild>();
function build(app: string): StackBuild {
  let b = builds.get(app);
  if (!b) {
    b = stackProgram([...DEFAULT_STACK, TCP], app);
    if (b.compiled.error) throw new Error(`${b.compiled.error.message} (${JSON.stringify(b.where(b.compiled.error.line))})`);
    builds.set(app, b);
  }
  return b;
}

/** A word of RAM holding a global of the program. */
export const homeOf = (b: StackBuild, name: string): number => {
  const h = b.compiled.layout!.homes.find((x) => x.name === name);
  if (h?.addr === undefined) throw new Error(`no home for ${name}`);
  return h.addr;
};

export function tcpBench(bytes: number, o: BenchOptions = {}) {
  const a = build(tcpSender(HOST_A, HOST_B.ip, bytes)), b = build(tcpReceiver(HOST_B, { readEvery: o.readEvery }));
  const k = Math.max(12, Math.ceil(Math.log2(Math.max(a.compiled.words.length, b.compiled.words.length) + 1)));
  const router = new RouterMiddle({ ports: [{ host: HOST_A.mac, mac: HOST_A.gwMac }, { host: HOST_B.mac, mac: HOST_B.gwMac }], queue: o.queue ?? 8, byteClocks: [32, o.byteClocks ?? 32], delay: o.delay ?? 2000, lose: o.lose });
  const bench = new LanBench([new Host(a.compiled.words, k), new Host(b.compiled.words, k)], router);
  return { bench, router, a, b, k };
}

export type TcpBenchRun = ReturnType<typeof tcpBench>;

/** Done when the receiver has printed its verdict. */
export const benchDone = (t: TcpBenchRun): boolean => t.bench.hosts[1].iss.console.endsWith('\n');

export interface CwndPoint { c: number; cwnd: number }
export interface BenchMeasure {
  bytes: number; clocks: number; frames: number; drops: number; misses: number; fast: number; timeouts: number;
  console: { a: string; b: string };
  cwnd: CwndPoint[];
  /** Clocks of the receiver by layer of the stack, while it ran. */
  layers: Record<string, number>;
}

/** Run a transfer to its end, counting what the chapter quotes; `tick` lets a long run yield. */
export async function measureBench(bytes: number, o: BenchOptions, tick: () => Promise<void> = async () => {}, max = 40_000_000): Promise<BenchMeasure> {
  const t = tcpBench(bytes, o), { bench, a, b, router } = t, [ha, hb] = bench.hosts;
  const hc = homeOf(a, 'cwnd'), hd = homeOf(a, 'dupacks'), hr = homeOf(a, 'retries');
  const cwnd: CwndPoint[] = [], layers: Record<string, number> = {};
  let last = -1, misses = 0, fast = 0, timeouts = 0, lastRetries = 0, lastDup = 0;
  router.log = [];
  while (bench.c < max && !benchDone(t)) {
    bench.clock();
    const core = hb.bus.nic!.core;
    // the status bit is the NIC's own count of a frame with no free descriptor: sticky, so it is read and cleared here, as a driver would
    if (core.sMiss) { misses++; core.sMiss = 0; }
    const pc = hb.iss.pc;
    const l = b.layerOfPc(pc) ?? 'frame';
    layers[l] = (layers[l] ?? 0) + 1;
    if ((bench.c & 63) === 0) {
      const c = ha.word(hc), d = ha.word(hd), r = ha.word(hr);
      if (c !== last) { cwnd.push({ c: bench.c, cwnd: c }); last = c; }
      if (d >= 3 && lastDup < 3) fast++;
      if (r > lastRetries) timeouts++;
      lastDup = d; lastRetries = r;
    }
    if ((bench.c & 0x3ffff) === 0) await tick();
  }
  return { bytes, clocks: bench.c, frames: router.log.length, drops: router.drops, misses, fast, timeouts, console: { a: ha.iss.console, b: hb.iss.console }, cwnd, layers };
}
