// A gate window on the model-speed bench (net/lanbench.ts): at a quiet moment one computer's state goes into its gates (Appendix B's way: registers, CSRs, the
// timer and the NIC's configuration forced into their flip-flops, the RAM poked into its leaves), and the gates take that computer's place on the wire. The golden
// model and the NIC model step beside them, told the time by the gates: every register after every retired instruction, every NIC output every clock.
// Quiet means no frame in or out at this computer and no bus transaction of the NIC, so there is no mid-frame state to load. Closing waits for the same.

import { idleIn, type NicIn } from '../comm/nic';
import { FLASH } from '../lib/uartlink';
import { lanSoc } from '../lib/lan';
import { busComputer } from '../lib/soc';
import type { RamState } from '../lib/bigmem';
import { DualSim } from '../sim/dualsim';
import { findNode, flatten, hintBits, type FlatDesign, type HierNode } from '../sim/flatten';
import type { GateSim } from '../sim/gatesim';
import { B0, B1 } from '../sim/types';
import { pack } from '../sim/values';
import type { Endpoint, Host, LanBench } from './lanbench';

const OUTS = ['awready', 'wready', 'bvalid', 'arready', 'rvalid', 'm_awvalid', 'm_wvalid', 'm_bready', 'm_arvalid', 'm_rready', 'txd', 'txen', 'irq'] as const;
/** Held bus fields: they mean something only under their valid, and a window does not load what they last carried. */
const GUARDED = [['rdata', 'rvalid'], ['m_awaddr', 'm_awvalid'], ['m_wdata', 'm_wvalid'], ['m_wstrb', 'm_wvalid'], ['m_araddr', 'm_arvalid']] as const;

function forceFlop(sim: GateSim, node: HierNode, path: string, bit: number): void {
  const b = bit ? B1 : B0, nb = bit ? B0 : B1;
  for (const latch of ['master', 'slave']) {
    const q = hintBits(node, `${path}.${latch}.sr.q`), qn = hintBits(node, `${path}.${latch}.sr.q_n`);
    if (!q || !qn) throw new Error(`gate window: no flip-flop at ${path}`);
    sim.forceNets(q, [b]);
    sim.forceNets(qn, [nb]);
  }
}
/** An n-bit register(n) under node. */
function forceReg(sim: GateSim, node: HierNode, path: string, n: number, v: number): void {
  for (let j = 0; j < n; j++) forceFlop(sim, node, `${path}.ff${j}.ff`, Math.floor((v >>> 0) / 2 ** j) % 2);
}
/** The lib/rtl.ts way: a flip-flop is known by the name of the net it drives. */
function forceNamed(sim: GateSim, scope: HierNode, name: string, bit: number): void {
  // lib/rtl.ts keeps names unique across a block, so a second "head0" is "head0_<signal>"
  const nets = scope.def.netlist!().nets, alt = new RegExp(`^${name}_[0-9]+$`), i = nets.findIndex((n) => n.name === name || (n.name !== undefined && alt.test(n.name)));
  const id = i >= 0 ? scope.nets?.[i]?.[0] : undefined;
  if (id === undefined) throw new Error(`gate window: no net ${name} in ${scope.name}`);
  for (const [k, c] of scope.children!) {
    if (c.ports.q?.[0] === id && c.children?.has('master')) { forceFlop(sim, scope, k, bit); return; }
  }
  throw new Error(`gate window: no flip-flop drives ${name} in ${scope.name}`);
}
const forceBits = (sim: GateSim, scope: HierNode, name: string, n: number, v: number) => { for (let i = 0; i < n; i++) forceNamed(sim, scope, `${name}${i}`, Math.floor((v >>> 0) / 2 ** i) % 2); };

/** No frame at this computer's pins and its NIC's engines at rest, at an instruction boundary. */
export function isQuiet(bench: LanBench, p: number): boolean {
  const h = bench.hosts[p], c = h.bus.nic!.core;
  return h.atBoundary && c.masterIdle && !c.doneq && !c.ts && !c.act && !c.f && !c.wv && !c.cm && !c.kick && c.tx.state === 0 && c.rx.state === 0 && !c.rx.valid
    && bench.tx[p].state === 0 && bench.rx[p].state === 0 && !c.wants;
}

/** Flattening is the slow part: per program, once. */
const designs = new Map<number[] | ArrayLike<number>, FlatDesign>();
export function computerDesign(words: ArrayLike<number>, imemK: number): FlatDesign {
  let d = designs.get(words);
  if (!d) designs.set(words, (d = flatten(busComputer(Array.from(words), FLASH, lanSoc(imemK)))));
  return d;
}

export function loadComputer(dual: DualSim, h: Host, now: number): void {
  dual.preferFast = false;
  const sim = dual.gate, d = sim.design, core = findNode(d.root, ['cpu'])!, cpu = h.iss;
  sim.reset('zero');
  sim.setInput('clk', 0); sim.setInput('switches', 0); sim.setInput('rxd', 0); sim.setInput('crs', 0);
  sim.settle();
  for (let i = 1; i < 32; i++) forceReg(sim, core, `rf.w${i}`, 32, cpu.x[i]);
  forceReg(sim, core, 'pc', 32, cpu.pc);
  forceReg(sim, core, 'csr.rMIE', 1, cpu.mie ? 1 : 0);
  forceReg(sim, core, 'csr.rMPIE', 1, cpu.mpie ? 1 : 0);
  forceReg(sim, core, 'csr.rMIEN', 2, (cpu.mtie ? 1 : 0) | (cpu.meie ? 2 : 0));
  forceReg(sim, core, 'csr.rTvec', 30, cpu.mtvec >>> 2);
  forceReg(sim, core, 'csr.rScratch', 32, cpu.mscratch);
  forceReg(sim, core, 'csr.rEpc', 30, cpu.mepc >>> 2);
  forceReg(sim, core, 'csr.rCause', 32, cpu.mcause);
  forceReg(sim, core, 'csr.rTval', 32, cpu.mtval);
  forceReg(sim, core, 'io.mtime.r', 32, now);
  forceReg(sim, core, 'io.rCmp', 32, cpu.mtimecmp);
  const ram = findNode(d.root, ['ram'])!, words = h.bus.ram;
  for (let l = 0; l < 4; l++) {
    const mem = new Uint32Array(words.length);
    for (let i = 0; i < words.length; i++) mem[i] = (words[i] >>> (8 * l)) & 255;
    sim.poke(ram.children!.get(`lane${l}`)!.leafIndex!, { mem, x: new Uint8Array(words.length), clk: 0, we: 0, a: 0, d: 0, writes: 0 } satisfies RamState);
  }
  const nic = findNode(d.root, ['nic'])!, c = h.bus.nic!.core, regs = nic.children!.get('regs')!, rx = nic.children!.get('rx')!, tx = nic.children!.get('tx')!;
  forceNamed(sim, regs, 'en', c.en); forceNamed(sim, regs, 'promisc', c.promisc);
  forceNamed(sim, regs, 'ie0', c.ie & 1); forceNamed(sim, regs, 'ie1', c.ie >> 1);
  forceBits(sim, regs, 'rxbase', 10, c.rxbase >>> 6); forceBits(sim, regs, 'txbase', 10, c.txbase >>> 6);
  forceBits(sim, regs, 'macl', 32, c.macl); forceBits(sim, regs, 'mach', 16, c.mach);
  forceNamed(sim, regs, 's_rx', c.sRx); forceNamed(sim, regs, 's_tx', c.sTx); forceNamed(sim, regs, 's_miss', c.sMiss); forceNamed(sim, regs, 's_bad', c.sBad);
  forceBits(sim, rx, 'head', 3, c.rxhead); forceBits(sim, tx, 'head', 3, c.txhead);
  // what rests at a value other than power-on's: the receive engine's flag and the transmitter's gap counter (full, or the first frame would wait a gap out)
  forceNamed(sim, rx, 'fin', c.fin);
  const csma = tx.children!.get('mactx')!.children!.get('csma')!;
  forceBits(sim, csma, 'gap', 9, c.tx.gap); forceBits(sim, csma, 'lfsr', 10, c.tx.lfsr);
  sim.settle();
  dual.preferFast = true;
  dual.prepare();
  dual.settle();
}

export interface WindowReport { clocks: number; retired: number; mismatch: string | null }

/** The gates in one computer's place on the bench. */
export class GateWindow implements Endpoint {
  rxd = 0; crs = 0;
  readonly sim: DualSim;
  private readonly root: HierNode; private readonly nicNode: HierNode; private readonly rf: HierNode;
  private readonly host: Host;
  private readonly inKeys = Object.keys(idleIn()) as (keyof NicIn)[];
  clocks = 0; retired = 0;
  /** The first disagreement between the gates and the models. */
  mismatch: string | null = null;
  /** After each clock: the instruction just retired, if any. */
  onClock?: (c: number, retired: boolean) => void;

  constructor(readonly bench: LanBench, readonly p: number, imemK: number, design?: FlatDesign, sim?: DualSim) {
    if (!isQuiet(bench, p)) throw new Error('gate window: not at a quiet moment');
    this.host = bench.hosts[p];
    this.sim = sim ?? new DualSim(design ?? computerDesign(this.host.iss.imem, imemK));
    this.root = this.sim.design.root;
    this.nicNode = this.root.children!.get('nic')!;
    this.rf = this.root.children!.get('cpu')!.children!.get('rf')!;
    loadComputer(this.sim, this.host, bench.c);
    this.host.bus.nic!.replay = true;
    bench.ends[p] = this;
  }
  private out(p: string): number { return pack(this.sim.getBits(this.root.ports[p])); }
  private np(p: string): number { return pack(this.sim.getBits(this.nicNode.ports[p])) >>> 0; }
  get txd(): number { return this.out('txd'); }
  get txen(): number { return this.out('txen'); }
  private reg(i: number): number { return pack(this.sim.getBits(this.rf.children!.get(`w${i}`)!.ports.q)) >>> 0; }

  clock(c: number): void {
    const { sim, host } = this, nic = host.bus.nic!;
    sim.setInput('rxd', this.rxd); sim.setInput('crs', this.crs); sim.settle();
    const retire = this.out('retire') === 1;
    const i = idleIn();
    for (const k of this.inKeys) (i as unknown as Record<string, number>)[k] = this.np(k);
    const o = nic.step(i) as unknown as Record<string, number>;
    if (!this.mismatch) for (const k of OUTS) if (this.np(k) !== o[k] >>> 0) { this.mismatch = `NIC ${k} at clock ${c}: gates ${this.np(k)}, model ${o[k] >>> 0}`; break; }
    if (!this.mismatch) for (const [k, v] of GUARDED) if (o[v] && this.np(k) !== o[k] >>> 0) { this.mismatch = `NIC ${k} at clock ${c}: gates ${this.np(k)}, model ${o[k] >>> 0}`; break; }
    if (o.m_awvalid && o.m_wvalid && i.m_awready && i.m_wready) {
      const ram = host.bus.ram, w = (o.m_awaddr >>> 2) % ram.length;
      let mask = 0;
      for (let b = 0; b < 4; b++) if ((o.m_wstrb >> b) & 1) mask |= 255 << (8 * b);
      ram[w] = ((ram[w] & ~mask) | (o.m_wdata & mask)) >>> 0;
    }
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    this.clocks++;
    if (retire) {
      this.retired++;
      host.bus.now = c + 1;
      host.iss.mtime = c;
      const pc = host.iss.pc;
      host.iss.step();
      if (!this.mismatch) for (let r = 1; r < 32; r++) if (this.reg(r) !== host.iss.x[r] >>> 0) { this.mismatch = `x${r} after the instruction at 0x${pc.toString(16)}, clock ${c}: gates 0x${this.reg(r).toString(16)}, model 0x${(host.iss.x[r] >>> 0).toString(16)}`; break; }
    }
    this.lastRetired = retire;
    this.onClock?.(c, retire);
  }
  private lastRetired = false;

  /** Back to the model, when the next quiet moment comes: true once done. */
  tryClose(): boolean {
    if (!this.lastRetired || !isQuiet(this.bench, this.p)) return false;
    this.host.bus.nic!.replay = false;
    this.bench.ends[this.p] = this.host;
    return true;
  }
  report(): WindowReport { return { clocks: this.clocks, retired: this.retired, mismatch: this.mismatch }; }
}

