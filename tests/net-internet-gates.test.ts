// Chapter 53's "same bytes": at every hop of the path, the frame the model's router sends equals what net/fastpath.ts sends and what the
// gates send, every output of every clock, with the router's table written through the cfg port as a slow path writes it.

import { describe, expect, it } from 'vitest';
import { tick } from './yieldtick';
import { routerFastPath } from '../src/lib';
import { hostFrame, hostId, hostIp, Internet, loadWrites, probeFrame, ROUTERS, TCP_ACK, TCP_PSH, tcpSegment } from '../src/net/internet';
import { engineMs } from '../src/net/internetdelay';
import { C_FORWARD, C_LOCAL, C_TTL, FastPathModel, S_RX, type FpIn } from '../src/net/fastpath';
import { PROTO_TCP } from '../src/net/ipv4';
import { TRIE_NODES } from '../src/net/trie';
import { simulate } from '../src/sim/harness';
import { out as harnessOut } from './util';
import { CLOCK_NS } from '../src/dram/timing';
import { engineCycles } from '../src/widgets/router';

const DEF = routerFastPath(new Array<number>(TRIE_NODES).fill(0), new Array<number>(128).fill(0), '_path_test');
type Sim = ReturnType<typeof simulate>;

function drive(sim: Sim, x: FpIn): void {
  sim.setInput('rxd', x.rxd); sim.setInput('rxv', x.rxv); sim.setInput('rxl', x.rxl); sim.setInput('txr', x.txr);
  sim.setInput('cfg_we', x.cfgWe ?? 0); sim.setInput('cfg_t', x.cfgT ?? 0); sim.setInput('cfg_a', x.cfgA ?? 0); sim.setInput('cfg_d', x.cfgD ?? 0);
  sim.settle();
}
const pulse = (sim: Sim) => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };

/** One router's table written, then one frame through gates and model together. */
function hop(sim: Sim, net: Internet, r: number, frame: number[]) {
  const m = new FastPathModel(new Array(TRIE_NODES).fill(0), new Array(128).fill(0));
  m.trie.fill(0); m.adj.fill(0);
  const load = loadWrites(net.tableOf(r));
  // the buffer and registers of the gates hold the last frame; the table writes and the frame are all that must matter
  for (const w of load) { const x: FpIn = { rxd: 0, rxv: 0, rxl: 0, txr: 1, ...w }; drive(sim, x); m.step(x); pulse(sim); }
  const out: number[] = [];
  let i = 0, port = -1, cause = -1, cycles = 0, started = false, bad = '';
  for (let guard = 0; guard < 8000; guard++) {
    const o = m.outputs();
    if (i >= frame.length && o.state === S_RX && started && !o.txv) break;
    const v = i < frame.length && o.rxr ? 1 : 0;
    const x: FpIn = { rxd: v ? frame[i] : 0, rxv: v, rxl: v && i === frame.length - 1 ? 1 : 0, txr: 1 };
    drive(sim, x);
    for (const k of ['rxr', 'txv', 'txl', 'state'] as const) if (harnessOut(sim, k) !== o[k] && !bad) bad = `${k} at cycle ${cycles}`;
    if (o.txv) { if (harnessOut(sim, 'txd') !== o.txd && !bad) bad = `txd at cycle ${cycles}`; if (harnessOut(sim, 'port') !== o.port && !bad) bad = `port at ${cycles}`; if (harnessOut(sim, 'cause') !== o.cause && !bad) bad = `cause at ${cycles}`; out.push(o.txd); port = o.port; cause = o.cause; }
    if (v) { i++; started = true; }
    m.step(x); pulse(sim);
    cycles++;
  }
  return { out, port, cause, cycles, bad };
}

const LAPTOP = hostId('laptop'), WWW = hostId('www');
const net = new Internet();

async function walk(start: number[]) {
  const sim = simulate(DEF);
  const j = net.send(LAPTOP, start);
  const seen: string[] = [];
  for (const h of j.hops) {
    const g = hop(sim, net, h.router, h.frameIn);
    expect(g.bad, ROUTERS[h.router].name).toBe('');
    seen.push(ROUTERS[h.router].name);
    if (h.result.kind === 'forward') {
      expect(g.cause).toBe(C_FORWARD);
      expect(g.port).toBe(h.result.port);
      expect(g.out, ROUTERS[h.router].name).toEqual(h.result.frame);
      expect(g.cycles).toBe(engineCycles(h.frameIn.length, h.result.reads));
      expect(engineMs(h.frameIn.length, h.result.reads)).toBeCloseTo(g.cycles * CLOCK_NS / 1e6, 9);
    } else if (h.result.kind === 'expired') { expect(g.cause).toBe(C_TTL); expect(g.out).toEqual(h.frameIn); }
    else if (h.result.kind === 'local') expect(g.cause).toBe(C_LOCAL);
    await tick();
  }
  return seen;
}

describe('the path on gates', () => {
  it('a probe, every hop from the laptop to www, byte for byte', async () => {
    const seen = await walk(probeFrame(LAPTOP, hostIp(WWW), 64));
    expect(seen).toEqual(['f1', 'f2', 'r1', 'r2', 'k1', 'k2', 'k3', 't1', 't2', 't3', 'q1', 'q2']);
  }, 180_000);
  it('a request larger than a minimum frame', async () => {
    const data = Array.from('GET / HTTP/1.1\r\nHost: www.quillon.example\r\n\r\n', (c) => c.charCodeAt(0));
    const f = hostFrame(LAPTOP, hostIp(WWW), 64, PROTO_TCP, tcpSegment(hostIp(LAPTOP), hostIp(WWW), 49200, 80, 1, 1, TCP_ACK | TCP_PSH, data));
    await walk(f);
  }, 180_000);
  it('a TTL that runs out goes up to the slow path unchanged', async () => {
    const seen = await walk(probeFrame(LAPTOP, hostIp(WWW), 3));
    expect(seen).toEqual(['f1', 'f2', 'r1']);
  }, 120_000);
});
