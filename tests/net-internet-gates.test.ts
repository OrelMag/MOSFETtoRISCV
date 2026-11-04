// Chapter 53's "same bytes": at every hop of the path, the frame the model's router sends equals what net/fastpath.ts sends and what the
// gates send, every output of every clock, with the router's table written through the cfg port as a slow path writes it.

import { describe, expect, it } from 'vitest';
import { tick } from './yieldtick';
import { routerFastPath } from '../src/lib';
import { hostId, Internet, loadWrites, ROUTERS } from '../src/net/internet';
import { engineMs } from '../src/net/internetdelay';
import { C_FORWARD, C_LOCAL, C_TTL, FastPathModel, S_RX, type FpIn } from '../src/net/fastpath';
import { parseIp, PROTO_TCP } from '../src/net/ipv4';
import { PATH_FRAMES } from '../src/widgets/internet';
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

/** One model through the whole walk, as the chapter's panel: every output of every clock, table writes included. */
function same(sim: Sim, m: FastPathModel, where: string): void {
  for (const [k, v] of Object.entries(m.outputs())) expect(harnessOut(sim, k), `${k} at ${where}`).toBe(v);
}

/** One router's table written, then one frame through gates and model together. */
function hop(sim: Sim, m: FastPathModel, net: Internet, r: number, frame: number[]) {
  const where = ROUTERS[r].name;
  for (const [n, w] of loadWrites(net.tableOf(r)).entries()) {
    const x: FpIn = { rxd: 0, rxv: 0, rxl: 0, txr: 1, ...w };
    drive(sim, x); same(sim, m, `${where} write ${n}`); m.step(x); pulse(sim);
  }
  const out: number[] = [];
  let i = 0, port = -1, cause = -1, cycles = 0, started = false;
  for (let guard = 0; guard < 8000; guard++) {
    const o = m.outputs();
    if (i >= frame.length && o.state === S_RX && started && !o.txv) break;
    const v = i < frame.length && o.rxr ? 1 : 0;
    const x: FpIn = { rxd: v ? frame[i] : 0, rxv: v, rxl: v && i === frame.length - 1 ? 1 : 0, txr: 1 };
    drive(sim, x);
    same(sim, m, `${where} cycle ${cycles}`);
    if (o.txv) { out.push(o.txd); port = o.port; cause = o.cause; }
    if (v) { i++; started = true; }
    m.step(x); pulse(sim);
    cycles++;
  }
  return { out, port, cause, cycles };
}

const LAPTOP = hostId('laptop');
const net = new Internet();

async function walk(start: number[]) {
  const sim = simulate(DEF), m = new FastPathModel(new Array<number>(TRIE_NODES).fill(0), new Array<number>(128).fill(0));
  const j = net.send(LAPTOP, start);
  const seen: string[] = [];
  for (const h of j.hops) {
    const g = hop(sim, m, net, h.router, h.frameIn);
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
  it('the chapter\'s frames are the ones it names: a request, a probe, a probe of TTL 3', () => {
    expect(PATH_FRAMES.length).toBe(3);
    expect(parseIp(PATH_FRAMES[0].frame().slice(14)).proto).toBe(PROTO_TCP);
    expect(parseIp(PATH_FRAMES[2].frame().slice(14)).ttl).toBe(3);
  });
  for (const [k, f] of PATH_FRAMES.entries()) {
    it(`${f.name}: every hop, byte for byte`, async () => {
      const seen = await walk(f.frame());
      expect(seen).toEqual(k === 2 ? ['f1', 'f2', 'r1'] : ['f1', 'f2', 'r1', 'r2', 'k1', 'k2', 'k3', 't1', 't2', 't3', 'q1', 'q2']);
    }, 180_000);
  }
});
