// Shared by the USB tests: the gate-level device behind the bench's DeviceIO, and a pair that steps the model beside it and compares every output after every clock.

import { type DevIn, type DeviceIO, UsbDevice } from '../src/comm/usb';
import { usbDevice } from '../src/lib/usb';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { simulate } from '../src/sim/harness';
import type { Sim } from '../src/sim/sim';
import { pack } from '../src/sim/values';

export const USB_OUT = ['odp', 'odm', 'oe', 'state', 'addr', 'tog', 'armed', 'stall', 'rem', 'rxact', 'txact'] as const;
export type UsbOut = Record<(typeof USB_OUT)[number], number>;

export function modelOut(d: UsbDevice): UsbOut {
  return { odp: d.odp, odm: d.odm, oe: d.oe, state: d.st, addr: d.addr, tog: d.tog, armed: d.armed, stall: d.stall, rem: d.rem, rxact: d.rxact, txact: 1 - d.txIdle };
}

export class GateDev implements DeviceIO {
  sim: Sim;
  o: UsbOut;
  constructor(sim?: Sim) {
    this.sim = sim ?? simulate(usbDevice());
    this.o = this.read();
  }
  private read(): UsbOut {
    const root = this.sim.design.root, g = (p: string) => pack(this.sim.getBits(root.ports[p]));
    return Object.fromEntries(USB_OUT.map((k) => [k, g(k)])) as UsbOut;
  }
  get oe(): number { return this.o.oe; }
  get odp(): number { return this.o.odp; }
  get odm(): number { return this.o.odm; }
  step(i: DevIn): void {
    const s = this.sim;
    s.setInput('rst', i.rst); s.setInput('dp', i.dp); s.setInput('dm', i.dm); s.setInput('nak', i.nak);
    s.settle();
    s.setInput('clk', 1); s.settle(); s.setInput('clk', 0); s.settle();
    this.o = this.read();
  }
}

/** The cycle engine's version of the same device. */
export function cycleDev(): GateDev {
  const sim = new DualSim(flatten(usbDevice()));
  sim.preferFast = true;
  sim.reset('zero');
  sim.setInput('clk', 0);
  for (const p of ['rst', 'dp', 'dm', 'nak']) sim.setInput(p, 0);
  sim.settle(); sim.prepare(); sim.settle();
  return new GateDev(sim);
}

/** Gates and model stepped together; the first clock at which any output differs is recorded (and thrown, when `strict`). */
export class Pair implements DeviceIO {
  model = new UsbDevice();
  gates: GateDev;
  clock = 0;
  mismatch: string | null = null;
  constructor(gates?: GateDev, public strict = true) { this.gates = gates ?? new GateDev(); }
  get oe(): number { return this.model.oe; }
  get odp(): number { return this.model.odp; }
  get odm(): number { return this.model.odm; }
  step(i: DevIn): void {
    this.model.step(i);
    this.gates.step(i);
    const w = modelOut(this.model), g = this.gates.o;
    for (const k of USB_OUT) {
      if (w[k] !== g[k] && !this.mismatch) {
        this.mismatch = `clock ${this.clock}: ${k} gates ${g[k]}, model ${w[k]}`;
        if (this.strict) throw new Error(this.mismatch);
      }
    }
    this.clock++;
  }
}
