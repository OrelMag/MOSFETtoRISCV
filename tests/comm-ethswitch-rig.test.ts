// The chapter's bench (widgets/ethswitch.ts Rig) on a real gate-level switch with a stand-in stage: what its log, counters and
// sources button say must follow what the switch did.
import { describe, expect, it } from 'vitest';
import { addrOf, hashAddr, hostMac, PORTS } from '../src/comm/ethswitch';
import { ethSwitch } from '../src/lib/ethswitch';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';
import { genLabel, Rig } from '../src/widgets/ethswitch';
import type { Stage } from '../src/view/stage';

const OPTS = { cellK: 7, tableK: 4, tickLog2: 5 };

function bench() {
  const def = ethSwitch(OPTS), sim = new GateSim(flatten(def));
  sim.reset('zero');
  for (const p of def.ports) if (p.dir === 'in') sim.setInput(p.name, 0);
  sim.settle();
  const stage = { sim } as unknown as Stage, rig = new Rig(OPTS);
  const run = (n: number) => { for (let i = 0; i < n; i++) { rig.before(stage); sim.setInput('clk', 1); sim.settle(); rig.after(); sim.setInput('clk', 0); sim.settle(); } };
  const out = (p: string) => pack(sim.getBits(sim.design.root.ports[p]));
  return { rig, run, out };
}

describe('the bench rig on the gates', () => {
  it('logs a flood for an unknown unicast address and a unicast only once the table knows the destination', () => {
    const { rig, run } = bench();
    rig.send(0, [0x02, 0, 0, 0, 0x99, 0x01], 64);
    run(400);
    const first = rig.seen.filter((f) => f.dst[4] === 0x99);
    expect(first.length).toBe(3);
    expect(first.every((f) => f.kind === 'flood')).toBe(true);
    rig.teach(); run(500);
    rig.send(0, hostMac(1), 64); run(300);
    const uni = rig.seen.filter((f) => f.src[5] === 1 && f.dst[5] === 2);
    expect(uni.length).toBe(1);
    expect(uni[0].kind).toBe('unicast');
    expect(uni[0].port).toBe(1);
    expect(rig.mismatches).toBe(0);
  }, 120000);

  it('frames out add up to sent − dropped − filtered + two copies per flooded frame', () => {
    const { rig, run, out } = bench();
    rig.teach(); run(500);
    rig.send(0, hostMac(0), 64);                          // to its own port: filtered
    rig.send(1, [0x02, 0, 0, 0, 0x99, 0x02], 64);         // unknown: flooded
    rig.send(2, hostMac(3), 64); rig.send(3, hostMac(1), 80); rig.send(1, hostMac(2), 64);
    run(1500);
    const frames = [0, 1, 2, 3].reduce((a, p) => a + out(`frames${p}`), 0), drops = [0, 1, 2, 3].reduce((a, p) => a + out(`drops${p}`), 0);
    expect(out('filtered')).toBe(1);
    expect(frames).toBe(rig.sent - drops - out('filtered') + 2 * out('flooded'));
    expect(PORTS).toBe(4);
  }, 120000);

  it('Reset and Back leave the sources button reading what the rig does', () => {
    const { rig } = bench();
    rig.gen.on = true;
    const saved = rig.save();
    rig.reset();
    expect(rig.gen.on).toBe(false);
    expect(genLabel(rig.gen.on)).toBe('Start sources');
    rig.restore(saved);
    expect(rig.gen.on).toBe(true);
    expect(genLabel(rig.gen.on)).toBe('Stop sources');
  });

  it('the capture of a port leaves out the frames it dropped and takes frames out from the gates', () => {
    const { rig, run } = bench();
    rig.teach(); run(500);
    for (let k = 0; k < 12; k++) rig.send(0, hostMac(1), 64, { delay: 0 });
    run(2500);
    expect(rig.rxCaps[0].length + rig.rxDropped[0]).toBe(13);
    expect(rig.txCaps[1].length).toBeGreaterThan(0);
  }, 120000);
});

describe('the hash', () => {
  it('addresses that differ within the low t bits never collide; higher differences can', () => {
    expect(hashAddr(0x7f, 4)).toBe(hashAddr(0x80, 4));
    const base = addrOf([2, 0, 0, 0, 0, 0]);
    expect(new Set(Array.from({ length: 16 }, (_, k) => hashAddr(base + k, 4))).size).toBe(16);
  });
});
