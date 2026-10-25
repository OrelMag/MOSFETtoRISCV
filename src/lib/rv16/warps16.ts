// Act 9's second half (roadmap Phase 15, 3c): the coalescer and the two-warp core, each built only
// from parts its level unlocks, so each is that level's reference.
//
//   COAL16     four word addresses and the mask in: the line of the lowest active lane (a line is four
//              RV16 words, address bits 15 … 2), the active lanes in it (served now), the rest (left)
//   RV16_WARPS two warps of four lanes taking turns every cycle (a barrel) over a data memory that
//              answers one cycle late: a load's word comes back while the other warp issues and is
//              written through a second register write port, so no warp ever waits for it
//
// The serving rule is chapter 32's (lib/warpmem.ts serveLanes, 16-byte lines of RV32 bytes): the leader
// picks the line, every active lane in it rides along. The warp core's golden model is
// riscv/rv16/warps16.ts.

import type { ComponentDef, PortDef } from '../../sim/types';
import { constWord } from '../alu';
import { Builder } from '../builder';
import { andN, busMux2, equal } from '../combinational';
import { DEC3 } from './logic';
import { RASTER16 } from './raster16';
import { FB16, RAST16 } from '../../gfx/raster16';
import { define, merger, ones, splitter } from '../define';
import { AND, NOT, OR } from '../gates';
import { bitwise, orN } from '../wide';
import { BRANCH16, CTL16, IMM16, NEXTPC16 } from './cpu';
import { LANE_PORTS, LANEDEC16, LANES16, MASK16, NL, STACK16, VRF16 } from './lanes16';
import { choose4, MUX16, RV16_DFF, RV16_DFFE, RV16_MUX4, RV16_REG16, RV16_REG4 } from './logic';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> => Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));
const L = [0, 1, 2, 3];
const each = (p: string) => L.map((i) => `${p}${i}`);

// ---- coalescer ---------------------------------------------------------------------------------------

/** Line of a word address: four 16-bit words share address bits 15 … 2. */
export const lineOf16 = (a: number) => (a & 0xffff) >>> 2;

/**
 * One access of the coalescer: the leader (lowest active lane) picks the line; served = the active lanes
 * in it, left = the other active lanes. No lane active: nothing served, line = lane 3's (a don't-care).
 */
export function coalesce16(addrs: number[], mask: number): { line: number; served: number; left: number } {
  const lead = L.find((i) => (mask >> i) & 1) ?? 3;
  const line = lineOf16(addrs[lead]);
  let served = 0;
  for (const i of L) if ((mask >> i) & 1 && lineOf16(addrs[i]) === line) served |= 1 << i;
  return { line, served, left: mask & ~served & 15 };
}

export const COAL16: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins(...each('a'), 'mask');
  const m = b.op(splitter(ones(NL), 2), ['mask'], 'lanes');
  const mb = (i: number) => `${m}.o${i}`;
  const hi = L.map((i) => `${b.op(splitter([2, 14], 2), [`a${i}`], `a${i} → line`)}.o1`);
  b.next();
  // the leader: 0 if m0, 1 if m1, 2 if m2, else 3 (as the mask's)
  const n0 = b.op1(NOT, [mb(0)]), n1 = b.op1(NOT, [mb(1)]), n2 = b.op1(NOT, [mb(2)]);
  b.next();
  const lo = b.op1(AND, [n0, b.op1(OR, [mb(1), n2])], 'lead bit 0');
  const hiB = b.op1(AND, [n0, n1], 'lead bit 1');
  b.next();
  const lead = b.op1(merger([1, 1], 2), [lo, hiB], 'leader');
  const z2 = b.op1(constWord(2, 0), []);
  const zs = L.map((i) => b.op1(merger([2, 14], 2), [z2, hi[i]], `line ${i}`));
  b.next();
  const ll = b.name(b.op1(RV16_MUX4, [...zs, lead], 'leader\'s line'), 'lline', true);
  b.next();
  const lsp = b.op(splitter([2, 14], 2), [ll]);
  const eq = [1, 2, 3].map((i) => b.op1(equal(14), [hi[i], `${lsp}.o1`], `lane ${i} same line?`));
  b.next();
  // lane 0, when active, is the leader: always in its own line
  const sv = [mb(0), ...[1, 2, 3].map((i, k) => b.op1(AND, [mb(i), eq[k]], `serve ${i}`))];
  b.next();
  const served = b.name(b.op1(merger(ones(NL), 2), sv, 'served'), 'served', true);
  b.next();
  b.wire(`${lsp}.o1`, 'line');
  b.wire(served, 'served');
  b.wire(b.op1(bitwise('xor', NL), ['mask', served], 'left = mask − served'), 'left');
  const R = b.right;
  return define({
    id: 'rv16_coal4', name: 'Coalescer (4 lanes, RV16)', category: 'memory',
    summary: 'One access for every lane whose word is in the same line: the leader (lowest active lane) picks the line (address bits 15 … 2: four 16-bit words), three 14-bit equality comparators find the other active lanes in it (served) and the rest wait for the next access (left).',
    ports: [...each('a').map((p) => bus(p, 16, 'in')), bus('mask', NL, 'in'), bus('line', 14, 'out'), bus('served', NL, 'out'), bus('left', NL, 'out')],
    symbol: { kind: 'box', label: 'COALESCER' },
    spec: (v) => {
      const r = coalesce16(v.slice(0, 4), v[4]);
      return [r.line, r.served, r.left];
    },
    netlist: () => ({ pins: { ...pinsAt([...each('a'), 'mask'], 0, 6), ...pinsAt(['line', 'served', 'left'], R, 6) }, instances: b.instances, nets: b.nets() }),
  });
})();


// ---- two warps -----------------------------------------------------------------------------------------

/**
 * The two-warp core's pins: the lane core's, plus the warp issuing this cycle and a second register write
 * port (lwe, lwa, lwd<i>) for the loads coming back, which belong to the warp that issued last cycle.
 * rwe / rwa / rwd<i> carry every other register write, of the warp issuing now.
 */
export const WARP_PORTS: PortDef[] = (() => {
  const k = LANE_PORTS.findIndex((p) => p.name === 'pc') + 1;
  return [...LANE_PORTS.slice(0, k), bit('warp', 'out'), ...LANE_PORTS.slice(k), bus('lwe', NL, 'out'), bus('lwa', 3, 'out'), ...each('lwd').map((p) => bus(p, 16, 'out'))];
})();

/**
 * Two warps of the SIMT core, alternating every cycle (warp 0 first after reset). Shared: fetch,
 * decode, control, the four lanes, branch and next-PC logic. Per warp: everything that is state. A
 * load writes nothing when it issues; its lanes and rd wait one cycle in a register, and the word the
 * memory returns then is written to the other warp's registers while this cycle's warp writes its own.
 * bar: the first warp to arrive sets its waiting bit and issues nothing more while the other still has
 * lanes; the other's arrival clears it. A warp with no lane left (tmc x0) has ended and issues nothing.
 */
function rv16Warps(raster: boolean): ComponentDef {
  const b = new Builder(10, 16, 6);
  b.pins('clk', 'rst', 'instr', ...each('drdata'));
  const nrst = b.op1(NOT, ['rst'], 'not reset');
  // the warp issuing now: 0 after reset, then 1, 0, 1, …
  const wff = b.add(RV16_DFF, 'warp');
  b.wire('clk', `${wff}.clk`);
  const wq = b.name(`${wff}.q`, 'warp', true);
  const w0 = b.name(b.op1(NOT, [wq], 'warp 0 issues'), 'sel0', true);
  b.wire(b.op1(AND, [w0, nrst], 'next: the other'), `${wff}.d`);
  const sel = [w0, wq];
  const f = b.op(splitter([2, 2, 3, 3, 3, 3], 4), ['instr'], 'fields');
  const cond = `${f}.o0`, rd = b.name(`${f}.o2`, 'rd', true);
  const rs1 = b.name(`${f}.o3`, 'rs1f', true), rs2 = b.name(`${f}.o4`, 'rs2f', true);
  b.next();
  const ctl = b.op(CTL16, ['instr'], 'control');
  const imm = b.op(IMM16, ['instr'], 'immediates');
  const ld = b.op(LANEDEC16, ['instr'], 'lane decode');
  // bar: SYSTEM (op 0) with funct3 7
  const opb = b.op(splitter(ones(4), 2), [b.op1(merger([2, 2], 2), [`${f}.o0`, `${f}.o1`])], 'op');
  const f3b = b.op(splitter(ones(3), 2), [`${f}.o5`], 'funct3');
  b.next();
  const immv = b.name(choose4(b, [`${imm}.i`, `${imm}.sb`, `${imm}.j`, `${imm}.u`], `${ctl}.isel`, 'imm').y, 'imm', true);
  const sys = b.op1(NOT, [b.op1(orN(4), L.map((i) => `${opb}.o${i}`), 'op ≠ 0')], 'SYSTEM?');
  const f37 = b.op1(AND, [b.op1(AND, [`${f3b}.o0`, `${f3b}.o1`]), `${f3b}.o2`], 'funct3 = 7');
  const wbs = b.op(splitter([1, 1], 2), [`${ctl}.wb`], 'wb');
  b.next();
  const bar = b.op1(AND, [sys, f37], 'bar');
  const isLoad = b.name(b.op1(AND, [`${ctl}.rwe`, b.op1(AND, [`${wbs}.o0`, b.op1(NOT, [`${wbs}.o1`])], 'wb = memory')], 'load'), 'isLoad', true);
  const rwe = b.op1(OR, [`${ctl}.rwe`, `${ld}.tid`], 'writes a register');
  b.next();
  // the per-warp state; the waiting bits decide whether this warp may issue at all
  const st = [0, 1].map((w) => {
    const r = { pc: b.add(RV16_REG16, `warp ${w} PC`), mask: b.add(MASK16, `warp ${w} mask`), stack: b.add(STACK16, `warp ${w} stack`), vrf: b.add(VRF16, `warp ${w} registers`), wait: b.add(RV16_DFF, `warp ${w} at bar`) };
    for (const x of Object.values(r)) b.wire('clk', `${x}.clk`);
    return r;
  });
  const wait = st.map((s, w) => b.name(`${s.wait}.q`, `wait${w}`, true));
  const any = st.map((s, w) => b.name(`${s.mask}.any`, `any${w}`, true));
  b.next();
  // go: the instruction counts. Not when this warp waits at bar while the other still has lanes, nor
  // when it has no lane left (it has ended: a later tmc must not bring it back)
  const waitW = b.op1(busMux2(1), [wait[0], wait[1], wq], 'this warp waits?');
  const otherAny = b.op1(busMux2(1), [any[1], any[0], wq], 'the other has lanes?');
  const anyW = b.op1(busMux2(1), [any[0], any[1], wq], 'this warp has lanes?');
  b.next();
  // k_frame: held while the rasterizer is busy, if lane 0 would store to it or a lane would read the screen
  const holdN = raster ? b.add(NOT, 'not held', 'holdN') : '';
  const go0 = b.op1(AND, [b.op1(NOT, [b.op1(AND, [waitW, otherAny], 'blocked')]), anyW], raster ? 'may go' : 'go');
  const go = b.name(raster ? b.op1(AND, [go0, `${holdN}.y`], 'go') : go0, 'go', true);
  b.next();
  const gs = [0, 1].map((w) => b.name(b.op1(AND, [sel[w], go], `warp ${w} goes`), `go${w}`, true));
  b.next();
  // operands: both warps' registers, read with the same numbers; the issuing warp's go to the lanes
  const a = L.map((i) => b.name(b.op1(MUX16, [`${st[0].vrf}.a${i}`, `${st[1].vrf}.a${i}`, wq], `rs1, lane ${i}`), `r1_${i}`, true));
  const r2 = L.map((i) => b.name(b.op1(MUX16, [`${st[0].vrf}.b${i}`, `${st[1].vrf}.b${i}`, wq], `rs2, lane ${i}`), `r2_${i}`, true));
  const leadW = b.op1(busMux2(2), [`${st[0].mask}.lead`, `${st[1].mask}.lead`, wq], 'leader');
  const pcW = b.name(b.op1(MUX16, [`${st[0].pc}.q`, `${st[1].pc}.q`, wq], 'pc'), 'pc', true);
  b.next();
  const ln = b.op(LANES16, [...a, ...r2, immv, `${ctl}.bimm`, `${ctl}.alu`], 'lanes');
  const la = b.name(b.op1(RV16_MUX4, [...a, leadW], 'leader rs1'), 'leadA', true);
  const lb = b.op1(RV16_MUX4, [...r2, leadW], 'leader rs2');
  b.next();
  const take = b.op1(BRANCH16, [la, lb, cond], 'branch?');
  const tm = b.op(splitter([NL, 16 - NL], 2), [la], 'tmc mask');
  const np = b.op(NEXTPC16, [pcW, immv, la, `${ctl}.br`, take, `${ctl}.jal`, `${ctl}.jalr`], 'next PC');
  const pc1 = b.name(`${np}.pc1`, 'pc1', true);
  b.next();
  // results of the issuing warp (a load's comes back next cycle): ALU, pc + 1, the immediate, or tid
  const shared = b.op1(MUX16, [pc1, immv, `${wbs}.o0`], 'pc + 1 / imm');
  b.next();
  const res = L.map((i) => b.op1(MUX16, [`${ln}.y${i}`, shared, `${wbs}.o1`], `result ${i}`));
  b.next();
  const tid = L.map((i) => b.op1(merger([2, 1, 13], 2), [b.op1(constWord(2, i), []), wq, b.op1(constWord(13, 0), [])], `tid ${i}`));
  b.next();
  const wd = L.map((i) => b.name(b.op1(MUX16, [res[i], tid[i], `${ld}.tid`], `or tid ${i}`), `wd${i}`, true));
  b.next();
  // the loads in flight: their lanes and rd, for one cycle
  const lp = b.add(RV16_REG4, 'load lanes');
  const lr = b.add(RV16_REG4, 'load rd');
  const one = b.op1(constWord(1, 1), []);
  for (const x of [lp, lr]) { b.wire('clk', `${x}.clk`); b.wire(one, `${x}.en`); }
  b.wire(b.op1(merger([3, 1], 2), [rd, b.op1(constWord(1, 0), [])], 'rd'), `${lr}.d`);
  const lrd = b.name(`${b.op(splitter([3, 1], 2), [`${lr}.q`])}.o0`, 'lrd', true);
  const lwe = b.name(`${lp}.q`, 'lwe', true);
  b.next();
  // per warp: the mask, the stack, the PC, the registers (written by this cycle's results or by the load)
  const nLoad = b.op1(NOT, [isLoad], 'not a load');
  const four = (x: string) => b.op1(merger(ones(NL), 2), L.map(() => x));
  const loadLanes: string[] = [], issueWe: string[] = [], dwe: string[] = [];
  st.forEach((s, w) => {
    const gw = gs[w];
    for (const [p, v] of [['rst', 'rst'], ['rwe', b.op1(AND, [rwe, gw])], ['mwe', b.op1(AND, [`${ctl}.mwe`, gw])]]) b.wire(v, `${s.mask}.${p}`);
    const sp = b.op1(AND, [`${ld}.split`, gw], `split ${w}`), jn = b.op1(AND, [`${ld}.join`, gw], `join ${w}`);
    for (const [p, v] of [['rst', 'rst'], ['split', sp], ['join', jn], ['mask', `${s.mask}.mask`], ['p', `${ln}.nz`], ['pc1', pc1]]) b.wire(v, `${s.stack}.${p}`);
    const tmcW = b.op1(AND, [`${ld}.tmc`, gw], `tmc ${w}`);
    b.wire(b.op1(OR, [tmcW, `${s.stack}.ld`], `mask ${w} loads`), `${s.mask}.ld`);
    b.wire(b.op1(busMux2(NL), [`${s.stack}.nmask`, `${tm}.o0`, `${ld}.tmc`], `next mask ${w}`), `${s.mask}.d`);
    issueWe.push(b.op1(bitwise('and', NL), [`${s.mask}.we`, four(nLoad)], `warp ${w} writes`));
    loadLanes.push(b.op1(bitwise('and', NL), [`${s.mask}.we`, four(isLoad)], `warp ${w} loads`));
    dwe.push(`${s.mask}.dwe`);
    // registers: this warp's results while it issues, else the returning load (the other warp's slot)
    b.wire(b.op1(busMux2(3), [lrd, rd, sel[w]], `rd ${w}`), `${s.vrf}.wa`);
    b.wire(b.op1(bitwise('or', NL), [issueWe[w], b.op1(bitwise('and', NL), [lwe, four(sel[1 - w])])], `we ${w}`), `${s.vrf}.we`);
    L.forEach((i) => b.wire(b.op1(MUX16, [`drdata${i}`, wd[i], sel[w]], `wd ${w}.${i}`), `${s.vrf}.wd${i}`));
    b.wire(rs1, `${s.vrf}.ra1`);
    b.wire(rs2, `${s.vrf}.ra2`);
    // the PC: next PC (or a join's jump), 0 at reset; it moves only when its warp goes
    let nx = b.op1(MUX16, [pc1, `${np}.target`, `${np}.ld`], `load? ${w}`);
    nx = b.op1(MUX16, [nx, `${s.stack}.jpc`, `${s.stack}.jump`], `join jump? ${w}`);
    b.wire(b.op1(MUX16, [nx, b.op1(constWord(16, 0), []), 'rst'], `reset? ${w}`), `${s.pc}.d`);
    b.wire(b.op1(OR, [gw, 'rst'], `PC ${w} moves`), `${s.pc}.en`);
    // bar: arriving first sets this warp's bit; the other's arrival clears it
    const barGo = b.op1(AND, [bar, gw], `bar ${w}`);
    const barOther = b.op1(AND, [bar, gs[1 - w]], `bar ${1 - w}`);
    const set = b.op1(AND, [barGo, b.op1(NOT, [wait[1 - w]])], `${w} waits`);
    const keep = b.op1(AND, [wait[w], b.op1(NOT, [barOther])], `${w} still waits`);
    b.wire(b.op1(AND, [b.op1(OR, [set, keep]), nrst]), `${s.wait}.d`);
  });
  b.next();
  b.wire(b.op1(bitwise('and', NL), [b.op1(bitwise('or', NL), loadLanes, 'loads'), four(nrst)], 'none at reset'), `${lp}.d`);
  b.wire(b.op1(bitwise('or', NL), issueWe, 'rwe'), 'rwe');
  b.wire(b.op1(bitwise('or', NL), dwe, 'dwe'), 'dwe');
  b.wire(pcW, 'pc');
  b.wire(wq, 'warp');
  b.wire(rd, 'rwa');
  wd.forEach((x, i) => b.wire(x, `rwd${i}`));
  L.forEach((i) => { b.wire(`${ln}.y${i}`, `daddr${i}`); b.wire(r2[i], `dwdata${i}`); b.wire(`drdata${i}`, `lwd${i}`); });
  b.wire(lwe, 'lwe');
  b.wire(lrd, 'lwa');
  if (raster) {
    b.next();
    const all3 = (v: string) => { const t3 = b.op(splitter(ones(3), 2), [v]); return b.op1(andN(3), [0, 1, 2].map((i) => `${t3}.o${i}`)); };
    // the device: lane 0's stores to RAST16 … RAST16 + 6; the colour's store starts the triangle next cycle
    const a0 = b.op(splitter([3, 13], 2), [`${ln}.y0`], 'lane 0 address');
    const inDev = b.op1(AND, [b.op1(equal(13), [`${a0}.o1`, b.op1(constWord(13, RAST16 >> 3), [])], '0xFFF0 … 0xFFF7?'),
      b.op1(NOT, [all3(`${a0}.o0`)], 'not 0xFFF7')], 'a rasterizer register');
    const maskW = b.op1(busMux2(NL), [`${st[0].mask}.mask`, `${st[1].mask}.mask`, wq], 'this warp\'s lanes');
    const mk = b.op(splitter(ones(NL), 2), [maskW]);
    const devStore = b.op1(andN(3), [`${ctl}.mwe`, `${mk}.o0`, inDev], 'lane 0 stores to it');
    // a load from the screen, FB16 … FB16 + 1023: address bits 15 … 10 = 111100
    const fb = L.map((i) => b.op1(AND, [`${mk}.o${i}`, b.op1(equal(6), [`${b.op(splitter([10, 6], 2), [`${ln}.y${i}`])}.o1`, b.op1(constWord(6, FB16 >> 10), [])])]));
    const fbLoad = b.op1(AND, [isLoad, b.op1(orN(4), fb)], 'a lane reads the screen');
    b.next();
    const rs = b.add(RASTER16, 'rasterizer', 'rast');
    const goF = b.add(RV16_DFF, 'start next cycle', 'startF');
    b.wire('clk', `${goF}.clk`);
    const devBusy = b.name(b.op1(OR, [`${rs}.busy`, `${goF}.q`], 'rasterizer busy'), 'rbusy', true);
    b.wire(b.op1(AND, [devBusy, b.op1(OR, [devStore, fbLoad])], 'held'), `${holdN}.a`);
    // the registers, written when lane 0's store goes (dwe bit 0)
    const dw = b.op(splitter(ones(NL), 2), [b.op1(bitwise('or', NL), dwe)]);
    const wr = b.op1(AND, [`${dw}.o0`, inDev], 'device write');
    const dec = b.op(splitter(ones(8), 2), [b.op1(DEC3, [`${a0}.o0`, wr], 'which register')]);
    // a vertex is 7 bits: lane 0's rs2 bits 3:0 into a 4-bit register, bits 6:4 into three enable flip-flops
    const vs = b.op(splitter([4, 1, 1, 1, 9], 2), [r2[0]], 'a vertex: rs2 bits 6:0');
    const VP = ['v0x', 'v0y', 'v1x', 'v1y', 'v2x', 'v2y'];
    VP.forEach((p, k) => {
      const en = `${dec}.o${k}`;
      const lo = b.op(RV16_REG4, [`${vs}.o0`, en, 'clk'], `${p} bits 3:0`, `r_${p}`);
      const hi = [4, 5, 6].map((j, i) => b.op1(RV16_DFFE, [`${vs}.o${i + 1}`, en, 'clk'], `${p} bit ${j}`, `r_${p}${j}`));
      b.wire(b.op1(merger([4, 1, 1, 1], 2), [`${lo}.q`, ...hi]), `${rs}.${p}`);
    });
    const cr = b.add(RV16_REG16, 'colour', 'r_col');
    b.wire(r2[0], `${cr}.d`); b.wire(`${dec}.o6`, `${cr}.en`); b.wire('clk', `${cr}.clk`);
    b.wire(`${dec}.o6`, `${goF}.d`);
    for (const [d, p] of [[`${cr}.q`, 'col'], [`${goF}.q`, 'go'], ['clk', 'clk'], ['rst', 'rst']]) b.wire(d, `${rs}.${p}`);
    b.wire(`${rs}.fa`, 'fa'); b.wire(`${rs}.fd`, 'fd'); b.wire(`${rs}.fwe`, 'fwe');
  }
  const R = b.right;
  if (raster) {
    return define({
      id: 'rv16_frame', name: 'RV16 two-warp core with a rasterizer', category: 'cpu',
      summary: 'The two-warp core with the rasterizer as a device: lane 0\'s stores to 0xFFF0 … 0xFFF5 set the vertices, its store to 0xFFF6 the colour, and the rasterizer starts in the next cycle, writing the screen through fa / fd / fwe. While it is busy, a warp whose instruction would store to it (lane 0) or load from the screen (0xF000 … 0xF3FF) does not issue: its turn passes.',
      ports: FRAME_PORTS,
      symbol: { kind: 'box', label: 'RV16 × 2 WARPS + RASTER' },
      netlist: () => ({
        pins: { ...pinsAt(['clk', 'rst', 'instr', ...each('drdata')], 0, 4), ...pinsAt(['pc', 'warp', ...each('daddr'), ...each('dwdata'), 'dwe', 'rwe', 'rwa', ...each('rwd'), 'lwe', 'lwa', ...each('lwd'), 'fa', 'fd', 'fwe'], R, 4) },
        instances: b.instances, nets: b.nets(),
      }),
    });
  }
  return define({
    id: 'rv16_warps', name: 'RV16 two-warp core (2 × 4 lanes)', category: 'cpu',
    summary: 'Two warps of the SIMT core take turns every cycle: one fetch, decode, control and set of lanes; per warp a PC, a mask, a split / join stack, lane registers and a waiting bit for bar. The data memory answers one cycle late: a load\'s lanes and rd wait a cycle in a register, and the word is written to its warp\'s registers (lwe, lwa, lwd) while the other warp issues, so neither ever waits for memory.',
    ports: WARP_PORTS,
    symbol: { kind: 'box', label: 'RV16 × 2 WARPS' },
    netlist: () => ({
      pins: { ...pinsAt(['clk', 'rst', 'instr', ...each('drdata')], 0, 4), ...pinsAt(['pc', 'warp', ...each('daddr'), ...each('dwdata'), 'dwe', 'rwe', 'rwa', ...each('rwd'), 'lwe', 'lwa', ...each('lwd')], R, 4) },
      instances: b.instances, nets: b.nets(),
    }),
  });
}

/** k_frame's core: the two-warp core's pins, plus the rasterizer's pixel writes. */
export const FRAME_PORTS: PortDef[] = [...WARP_PORTS, bus('fa', 10, 'out'), bus('fd', 16, 'out'), bit('fwe', 'out')];

export const RV16_WARPS: ComponentDef = rv16Warps(false);
export const RV16_FRAME: ComponentDef = rv16Warps(true);

