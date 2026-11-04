// Chapter 49's switch: the gates against the golden model, every output every cycle, on seeded traffic; then what the model
// promises about the traffic itself (delivery, order, floods, no echo), its counters and the closed forms the chapter quotes.

import { describe, expect, it } from 'vitest';
import { BROADCAST, ETHERTYPE_LOCAL, frameBody, parseFrame, type Mac } from '../src/comm/ethframe';
import { addrOf, bitOf, HOL_LIMIT, holSaturation, hostMac, hashAddr, idleIn, MacTable, PORTS, rng, SwitchModel, teachFrames, trafficFrame, type SwitchIn, type SwitchOpts } from '../src/comm/ethswitch';
import { ethSwitch } from '../src/lib/ethswitch';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { ComponentDef } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { tick } from './yieldtick';

function bench(def: ComponentDef) {
  const sim = new GateSim(flatten(def));
  sim.reset('zero');
  for (const p of def.ports) if (p.dir === 'in') sim.setInput(p.name, 0);
  sim.settle();
  const out = (p: string) => pack(sim.getBits(sim.design.root.ports[p]));
  const apply = (i: SwitchIn) => {
    for (let k = 0; k < PORTS; k++) {
      const r = i.rx[k];
      sim.setInput(`rxData${k}`, r.data); sim.setInput(`rxValid${k}`, r.valid); sim.setInput(`rxLast${k}`, r.last); sim.setInput(`rxErr${k}`, r.err);
      sim.setInput(`txReady${k}`, i.txReady[k]);
    }
    sim.settle();
  };
  const edge = () => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };
  return { sim, out, apply, edge };
}

interface Src { gap: number; ready: number; err: number; len: [number, number]; unknown?: number; bcast?: number; idle?: number }

/** Seeded traffic: frames to known hosts, broadcasts and unknown unicasts, a few with a bad FCS flag, gaps in valid and in ready. */
function source(seed: number, opts: Src) {
  const R = rng(seed);
  const cur = Array.from({ length: PORTS }, () => ({ b: null as number[] | null, k: 0, err: false, wait: Math.floor(R() * 30) }));
  let id = 1;
  const make = (p: number): number[] => {
    const r = R();
    let dst: Mac;
    if (r < (opts.bcast ?? 0.05)) dst = BROADCAST;
    else if (r < (opts.bcast ?? 0.05) + (opts.unknown ?? 0.05)) dst = [0x02, 0, 0, 0, 0x99, Math.floor(R() * 200)];
    else { let d = Math.floor(R() * PORTS); if (d === p && R() < 0.8) d = (d + 1) % PORTS; dst = hostMac(d); }
    const len = opts.len[0] + Math.floor(R() * (opts.len[1] - opts.len[0] + 1));
    const payload = Array.from({ length: Math.max(4, len - 14) }, (_, k) => (k < 4 ? (id >> (8 * (3 - k))) & 255 : Math.floor(R() * 256)));
    id++;
    return frameBody({ dst, src: hostMac(p), type: 0x0800, payload });
  };
  return {
    next(): SwitchIn {
      const i = idleIn();
      for (let p = 0; p < PORTS; p++) {
        const c = cur[p];
        if (!c.b) { if (c.wait > 0) c.wait--; else { c.b = make(p); c.k = 0; c.err = R() < opts.err; } }
        if (c.b && R() >= opts.gap) {
          i.rx[p] = { valid: 1, data: c.b[c.k], last: c.k === c.b.length - 1 ? 1 : 0, err: c.k === c.b.length - 1 && c.err ? 1 : 0 };
          if (++c.k === c.b.length) { c.b = null; c.wait = (opts.idle ?? 0) + Math.floor(R() * 40); }
        }
        i.txReady[p] = R() < opts.ready ? 1 : 0;
      }
      return i;
    },
  };
}

const NAMES = (k: number) => [`txData${k}`, `txValid${k}`, `txLast${k}`, `drops${k}`, `bad${k}`, `frames${k}`];

async function lockstep(o: Partial<SwitchOpts>, cycles: number, seed: number, src: Src) {
  const def = ethSwitch(o), g = bench(def), m = new SwitchModel(o), s = source(seed, src);
  let moved = 0;
  for (let c = 0; c < cycles; c++) {
    const i = s.next();
    g.apply(i);
    const w = m.out();
    for (let k = 0; k < PORTS; k++) {
      const want = [w.tx[k].data, w.tx[k].valid, w.tx[k].last, w.drops[k], w.bad[k], w.frames[k]];
      NAMES(k).forEach((n, x) => { if (g.out(n) !== want[x]) expect.fail(`cycle ${c}: ${n} gates ${g.out(n)} model ${want[x]}`); });
      if (w.tx[k].valid && i.txReady[k]) moved++;
    }
    for (const n of ['learned', 'evicted', 'flooded', 'filtered'] as const) if (g.out(n) !== w[n]) expect.fail(`cycle ${c}: ${n} gates ${g.out(n)} model ${w[n]}`);
    g.edge(); m.step(i);
    if (c % 400 === 0) await tick();
  }
  return { m, moved, g };
}

const SRC: Src = { gap: 0.1, ready: 0.8, err: 0.1, len: [60, 100] };

describe('switch: gates against the golden model, every output every cycle', () => {
  it('store-and-forward, one FIFO per input', async () => {
    const r = await lockstep({ cellK: 7 }, 2500, 1, SRC);
    expect(r.moved).toBeGreaterThan(500);
    expect(r.m.table.learned).toBeGreaterThan(2);
  }, 240000);
  it('store-and-forward, virtual output queues', async () => {
    const r = await lockstep({ cellK: 7, voq: true }, 2500, 2, SRC);
    expect(r.moved).toBeGreaterThan(500);
  }, 240000);
  it('cut-through, FIFO and VOQ', async () => {
    for (const voq of [false, true]) {
      const r = await lockstep({ cellK: 7, cut: true, voq }, 2500, 3 + Number(voq), SRC);
      expect(r.moved).toBeGreaterThan(500);
    }
  }, 240000);
  it('eight cells per input: FIFO store-and-forward, VOQ cut-through; two cells', async () => {
    for (const o of [{ cellK: 7, cells: 8 }, { cellK: 7, cells: 8, voq: true, cut: true }, { cellK: 6, cells: 2, voq: true }]) {
      const r = await lockstep(o, 2200, 21, { ...SRC, len: [60, 62] });
      expect(r.moved).toBeGreaterThan(300);
    }
  }, 240000);
  it('a small table collides and evicts, a short age expires entries, and the table counters match', async () => {
    const r = await lockstep({ cellK: 7, tableK: 2, tickLog2: 1 }, 3000, 7, { ...SRC, unknown: 0.2 });
    expect(r.m.table.evicted).toBeGreaterThan(0);
  }, 240000);
});

describe('hash and table model', () => {
  it('xor-fold: every address bit moves exactly one hash bit; consecutive addresses never collide', () => {
    const t = 6, base = addrOf([0x02, 0, 0, 0, 0, 0]);
    const seen = new Set<number>();
    for (let k = 0; k < 64; k++) seen.add(hashAddr(base + k, t));
    expect(seen.size).toBe(64);
    for (let b = 0; b < 48; b++) { const flipped = bitOf(base, b) ? base - 2 ** b : base + 2 ** b; expect(hashAddr(flipped, t) ^ hashAddr(base, t)).toBe(1 << (b % t)); }
  });
  it('learn, look up, flood a miss and a group address, filter the sender port, age out', () => {
    const T = new MacTable(5, 1);
    const A = addrOf(hostMac(0)), B = addrOf(hostMac(1)), G = addrOf(BROADCAST);
    expect(T.op(B, A, 0).mask).toBe(0b1110);
    expect(T.op(A, B, 1).mask).toBe(0b0001);
    expect(T.op(G, A, 0).mask).toBe(0b1110);
    expect(T.op(A, addrOf(hostMac(2)), 0).mask).toBe(0);
    expect(T.liveEntries().length).toBe(3);
    for (let k = 0; k < 64 * 2 * 4; k++) T.idle();
    expect(T.liveEntries().length).toBe(0);
    expect(T.peek(B, A, 0).hit).toBe(false);
  });
});

describe('what the switch promises', () => {
  const run = async (o: Partial<SwitchOpts>, seed: number, cycles: number, src: Src) => {
    const s = source(seed, src), m = new SwitchModel(o);
    const sent: Array<{ port: number; bytes: number[]; err: boolean; at: number }> = [];
    const cur = Array.from({ length: PORTS }, () => ({ b: [] as number[], err: false }));
    const got: Array<{ port: number; bytes: number[] }> = [];
    const outCur: number[][] = Array.from({ length: PORTS }, () => []);
    for (let c = 0; c < cycles; c++) {
      const i = s.next();
      for (let p = 0; p < PORTS; p++) if (i.rx[p].valid) { cur[p].b.push(i.rx[p].data); if (i.rx[p].err) cur[p].err = true; if (i.rx[p].last) { sent.push({ port: p, bytes: cur[p].b, err: cur[p].err, at: c }); cur[p] = { b: [], err: false }; } }
      const w = m.out();
      for (let k = 0; k < PORTS; k++) if (w.tx[k].valid && i.txReady[k]) { outCur[k].push(w.tx[k].data); if (w.tx[k].last) { got.push({ port: k, bytes: outCur[k] }); outCur[k] = []; } }
      m.step(i);
      if (c % 5000 === 0) await tick();
    }
    return { sent, got, m, cycles };
  };
  it('every frame reaches the right outputs once, in order per flow, floods skip the source, nothing returns to its source', async () => {
    for (const o of [{ cellK: 7 }, { cellK: 7, voq: true }, { cellK: 7, cut: true }]) {
      const { sent, got, m, cycles } = await run(o, 11, 40000, { gap: 0.3, ready: 0.9, err: 0.05, len: [60, 90], unknown: 0.1, idle: 250 });
      expect(m.out().drops.reduce((a, b) => a + b, 0)).toBe(0);
      const idOf = (b: number[]) => (b[14] << 24) | (b[15] << 16) | (b[16] << 8) | b[17];
      const byId = new Map<number, number[]>();
      for (const g of got) { const k = idOf(g.bytes); byId.set(k, [...(byId.get(k) ?? []), g.port]); }
      let checked = 0;
      for (const f of sent) {
        if (f.at > cycles - 4000) continue;
        const ports = byId.get(idOf(f.bytes));
        if (f.err && !o.cut) { expect(ports).toBeUndefined(); continue; }
        if (!ports) continue; // filtered by the table
        expect(ports).not.toContain(f.port);
        expect(new Set(ports).size).toBe(ports.length);
        if (f.bytes[0] & 1) expect(ports.length).toBe(3);
        checked++;
      }
      expect(checked).toBeGreaterThan(100);
      const flow = new Map<string, number[]>();
      for (const f of sent) { const key = `${f.port}>${f.bytes.slice(0, 6).join('.')}`; flow.set(key, [...(flow.get(key) ?? []), idOf(f.bytes)]); }
      const outOrder = new Map<string, number[]>();
      for (const g of got) { const p = parseFrame([...g.bytes, 0, 0, 0, 0]); const key = `${p.src[5] - 1}>${p.dst.join('.')}@${g.port}`; outOrder.set(key, [...(outOrder.get(key) ?? []), idOf(g.bytes)]); }
      for (const [k, ids] of outOrder) { const sentIds = flow.get(k.split('@')[0])!; const pos = ids.map((x) => sentIds.indexOf(x)); expect(pos, k).toEqual([...pos].sort((a, b) => a - b)); }
      expect(m.table.learned).toBeGreaterThanOrEqual(4);
      for (let p = 0; p < PORTS; p++) { const e = m.table.entries[hashAddr(addrOf(hostMac(p)), m.o.tableK)]; expect(e.valid && e.port === p).toBe(true); }
    }
  }, 240000);
});

describe('closed forms and the classic experiment', () => {
  it('N = 4 inputs with a FIFO each saturate near 0.655; large N near 2 - sqrt(2)', () => {
    const n4 = holSaturation(4, false, 400000, 5);
    expect(n4).toBeGreaterThan(0.64);
    expect(n4).toBeLessThan(0.67);
    expect(Math.abs(holSaturation(64, false, 20000, 6) - HOL_LIMIT)).toBeLessThan(0.025);
    expect(holSaturation(4, true, 1000)).toBe(1);
  });
});

// tshark called these malformed when they were tagged IPv4 and ARP without an IP or ARP header (its check reads the
// rig's capture, not these): they carry demo bytes, and must say so.
describe('the traffic frames say what they are', () => {
  it('trafficFrame and the teach frames use the local experimental type', () => {
    const typeOf = (f: number[]) => (f[12] << 8) | f[13];
    expect(ETHERTYPE_LOCAL).toBe(0x88b5);
    expect(typeOf(trafficFrame(0, 1, 7, 64))).toBe(ETHERTYPE_LOCAL);
    expect(typeOf(trafficFrame(2, 3, 9, 200))).toBe(ETHERTYPE_LOCAL);
    expect(teachFrames().map(typeOf)).toEqual(Array(PORTS).fill(ETHERTYPE_LOCAL));
  });
});
