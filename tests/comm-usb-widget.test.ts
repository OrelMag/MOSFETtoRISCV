// The scene's rig (widgets/usb.ts UsbRig) on the real gates behind a stand-in for the stage: the host enumerates, the model stays equal, and Back's replay lands on the same state.

import { describe, expect, it } from 'vitest';
import { UsbHost } from '../src/comm/usb';
import { usbBlockCosts, UsbRig } from '../src/widgets/usb';
import { usbDevice } from '../src/lib/usb';
import { simulate } from '../src/sim/harness';
import type { Stage } from '../src/view/stage';
import { out, set } from './util';

function stage() {
  const sim = simulate(usbDevice());
  return { sim, value: (p: string) => out(sim, p) } as unknown as Stage & { sim: ReturnType<typeof simulate> };
}
const edge = (st: Stage & { sim: ReturnType<typeof simulate> }, rig: UsbRig) => { rig.before(st); set(st.sim, { clk: 1 }); set(st.sim, { clk: 0 }); rig.after(st); };

describe('the scene\'s rig', () => {
  it('enumerates through the gates with the model equal on every clock, and Back replays to the same state', () => {
    const st = stage(), rig = new UsbRig();
    for (let i = 0; i < 5000; i++) edge(st, rig);
    const snap = rig.save();
    rig.event({ clock: rig.clock, what: 'corrupt' });
    while (!rig.host.done && rig.clock < 40000) edge(st, rig);
    expect(rig.host.failed).toBeNull();
    expect(rig.host.configured).toBe(true);
    expect(rig.mismatches).toBe(0);
    expect(rig.compared).toBe(rig.clock);
    expect(rig.clashes).toBe(0);
    expect(rig.host.corrupted).toBe(1);
    // Back to the first checkpoint: a fresh rig replayed to it equals the one that ran there
    const again = new UsbRig();
    again.replayTo(snap.clock, snap.events);
    const ref = new UsbRig(), st2 = stage();
    for (let i = 0; i < 5000; i++) edge(st2, ref);
    expect(again.clock).toBe(ref.clock);
    expect(again.host.log).toEqual(ref.host.log);
    expect(again.model).toEqual(ref.model);
    expect(again.host.out).toEqual(ref.host.out);
  }, 120000);
  it('Replug starts the host over and the device goes back to Default, address 0', () => {
    const st = stage(), rig = new UsbRig();
    while (!rig.host.done && rig.clock < 40000) edge(st, rig);
    expect(out(st.sim, 'addr')).toBe(5);
    rig.event({ clock: rig.clock, what: 'replug' });
    for (let i = 0; i < 400; i++) edge(st, rig);
    expect([out(st.sim, 'state'), out(st.sim, 'addr')]).toEqual([1, 0]);
    expect(rig.host).toBeInstanceOf(UsbHost);
    expect(rig.mismatches).toBe(0);
  }, 120000);
  it('the block costs are the netlist\'s', () => {
    const c = usbBlockCosts();
    expect(c.total).toBeGreaterThan(c.blocks.rx + c.blocks.pkt + c.blocks.ctl + c.blocks.tx);
    expect(c.blocks['tx.rom']).toBeGreaterThan(100);
    expect(c.blocks['crc.crc16']).toBeGreaterThan(c.blocks['crc.crc5']);
    console.log(JSON.stringify(c));
  });
});
