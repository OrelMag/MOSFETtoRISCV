// Chapter 31: the graphics pipeline. A vertex kernel on a warp core (one warp of four lanes with multipliers)
// writes each frame's screen vertices into a vertex buffer; the command unit reads the triangles and their
// vertices from the same memory and feeds chapter 30's rasterizer, depth test and framebuffer; the scan-out
// sends the front frame to the screen. The reference is gfx/pipeline.ts, the kernels riscv/gfxprograms.ts.
//
//   CMD_UNIT  a state machine, one flip-flop a state: launch the kernel on the next frame and clear the back
//             frame; read the triangle count; per triangle, read its word and its three vertices (four cycles on
//             the memory's extra read port), start the rasterizer and wait for it; ask for a swap and wait for the
//             flip at vsync and for the kernel; then the next frame from the other vertex buffer.
//   GPU31     the warp core, the command unit, the rasterizer with depth, the ROP, the two frames, the scan-out.

import type { ComponentDef, PortDef } from '../sim/types';
import { BG, GFX, GFX_DMEM_K, type Mesh, meshData, vertexKernel } from '../riscv/gfxprograms';
import { assemble } from '../riscv/asm';
import { constWord } from './alu';
import { Builder } from './builder';
import { busMux2, equal, incrementer } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, NOT, OR, XOR } from './gates';
import { onehotMux } from './lanes';
import { frameBuffers, rasterizer, ROP, SCAN_OUT, VERTEX_PINS } from './raster';
import { register } from './sequential';
import { TIE1 } from './transistors';
import { warpCore } from './warps';
import { orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> => Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));
const K = GFX_DMEM_K;

/** The command unit's states, one flip-flop each (none set: waiting for the kernel's first run, after power-on). */
export const CU_STATES = ['launch', 'clear', 'count', 'tri', 'v0', 'v1', 'v2', 'go', 'draw', 'swap', 'flip'] as const;
export type CuState = typeof CU_STATES[number] | 'start';
const S = Object.fromEntries(CU_STATES.map((s, i) => [s, i])) as Record<typeof CU_STATES[number], number>;

/**
 * halted: the kernel is done; xq: the word at xa; busy: the rasterizer; front: the scan-out's front frame. Out: xa,
 * launch (the kernel, for the next frame), the triangle for the rasterizer (vertices, z, colour), clr and go, swap.
 */
export const CMD_UNIT: ComponentDef = (() => {
  const b = new Builder(10, 12, 4);
  const ins = ['halted', 'xq', 'busy', 'front', 'clk'];
  b.pins(...ins);
  const one = b.op1(TIE1, [], undefined, 'one');
  const st = b.add(register(CU_STATES.length), 'state, one-hot', 'st');
  b.wire('clk', `${st}.clk`); b.wire(one, `${st}.en`);
  const t = b.add(register(4), 'triangle', 't');
  const nt = b.add(register(4), 'triangles', 'nt');
  const tri = b.add(register(20), 'its indices, colour', 'tri');
  const vr = [0, 1, 2].map((k) => b.add(register(24), `vertex ${k}`, `vr${k}`));
  const par = b.add(register(1), 'vertex buffer', 'par');
  const fr = b.add(register(1), 'front at the swap', 'fr');
  for (const r of [t, nt, tri, ...vr, par, fr]) b.wire('clk', `${r}.clk`);
  b.next();
  const ss = b.op(splitter(ones(CU_STATES.length)), [`${st}.q`], undefined, 'ss');
  const s = (k: keyof typeof S) => `${ss}.o${S[k]}`;
  for (const k of CU_STATES) b.name(s(k), k, true);
  const start = b.name(b.op1(NOT, [b.op1(orN(CU_STATES.length), CU_STATES.map((k) => s(k)), 'any state', 'anySt')], 'start (none)', 'start'), 'start', true);
  const xs = b.op(splitter([12, 4, 8, 8]), ['xq'], undefined, 'xs');
  const flipped = b.op1(XOR, ['front', `${fr}.q`], 'flipped?', 'flipped');
  const idle = b.op1(NOT, ['busy'], 'rasterizer idle', 'idle');
  const t1 = b.op1(incrementer(4), [`${t}.q`], 't + 1', 'tInc');
  b.next();
  const last = b.op1(equal(4), [t1, `${nt}.q`], 'last triangle?', 'last');
  const ready = b.op1(AND, [flipped, 'halted'], 'flipped, kernel done', 'ready');
  const dDone = b.op1(AND, [s('draw'), idle], 'triangle drawn', 'dDone');
  b.next();
  // next state
  const or2 = (a: string, c: string, nm: string) => b.op1(OR, [a, c], undefined, nm);
  const and2 = (a: string, c: string, nm: string) => b.op1(AND, [a, c], undefined, nm);
  const nLast = b.op1(NOT, [last], undefined, 'nLast');
  const next: Record<keyof typeof S, string> = {
    launch: or2(and2(start, 'halted', 'go0'), and2(s('flip'), ready, 'goF'), 'nLaunch'),
    clear: or2(s('launch'), and2(s('clear'), 'busy', 'clBusy'), 'nClear'),
    count: and2(s('clear'), idle, 'nCount'),
    tri: or2(s('count'), and2(dDone, nLast, 'more'), 'nTri'),
    v0: s('tri'), v1: s('v0'), v2: s('v1'), go: s('v2'),
    draw: or2(s('go'), and2(s('draw'), 'busy', 'drBusy'), 'nDraw'),
    swap: and2(dDone, last, 'nSwap'),
    flip: or2(s('swap'), and2(s('flip'), b.op1(NOT, [ready], undefined, 'nReady'), 'flWait'), 'nFlip'),
  };
  b.wire(b.op1(merger(ones(CU_STATES.length)), CU_STATES.map((k) => next[k]), 'next state', 'nst'), `${st}.d`);
  // the triangle counter: 0 at count, + 1 after each triangle
  b.wire(b.op1(busMux2(4), [t1, b.op1(constWord(4, 0), [], undefined, 'z4'), s('count')], undefined, 'tD'), `${t}.d`);
  b.wire(or2(s('count'), dDone, 'tEn'), `${t}.en`);
  b.wire(b.op1(splitter([4, 28]), ['xq'], undefined, 'xn'), `${nt}.d`); b.wire(s('count'), `${nt}.en`);
  b.wire(b.op1(merger([12, 8]), [`${xs}.o0`, `${xs}.o2`], undefined, 'triD'), `${tri}.d`); b.wire(s('tri'), `${tri}.en`);
  const xv = b.op1(splitter([24, 8]), ['xq'], undefined, 'xv');
  vr.forEach((r, k) => { b.wire(xv, `${r}.d`); b.wire(s(`v${k}` as 'v0'), `${r}.en`); });
  // the vertex buffer flips when the next frame starts (not the first)
  b.wire(b.op1(NOT, [`${par}.q`], undefined, 'nPar'), `${par}.d`); b.wire(and2(s('flip'), ready, 'parEn'), `${par}.en`);
  b.wire('front', `${fr}.d`); b.wire(s('swap'), `${fr}.en`);
  b.next();
  // the address: the count, a triangle, or one of its vertices in this frame's buffer
  const ts = b.op(splitter([4, 4, 4, 8]), [`${tri}.q`], undefined, 'ts');
  const idx = b.op1(onehotMux(3, 3), [b.op1(merger([1, 1, 1]), [s('v0'), s('v1'), s('v2')], undefined, 'vSel'),
    ...[0, 1, 2].map((k) => b.op1(splitter([3, 1]), [`${ts}.o${k}`], undefined, `i${k}`))], 'vertex index', 'idx');
  const vAddr = b.op1(merger([3, 1, 3]), [idx, `${par}.q`, b.op1(constWord(3, GFX.vbuf >> 4), [], undefined, 'vb')], 'vertex buffer + i', 'vAddr');
  const tAddr = b.op1(merger([4, 3]), [`${t}.q`, b.op1(constWord(3, GFX.tri >> 4), [], undefined, 'tb')], 'triangle list + t', 'tAddr');
  const nAddr = b.op1(constWord(K, GFX.nt), [], 'the count', 'nAddr');
  const isV = b.op1(orN(3), [s('v0'), s('v1'), s('v2')], undefined, 'isV');
  b.next();
  b.wire(b.op1(onehotMux(3, K), [b.op1(merger([1, 1, 1]), [s('count'), s('tri'), isV], undefined, 'aSel'), nAddr, tAddr, vAddr], 'address', 'xaM'), 'xa');
  // the rasterizer's inputs
  vr.forEach((r, k) => {
    const v = b.op(splitter([8, 8, 8]), [`${r}.q`], undefined, `v${k}s`);
    b.wire(`${v}.o0`, `v${k}x`); b.wire(`${v}.o1`, `v${k}y`); b.wire(`${v}.o2`, `z${k}`);
  });
  b.wire(b.op1(busMux2(8), [`${ts}.o3`, b.op1(constWord(8, BG), [], 'background', 'bg'), s('launch')], 'colour', 'colM'), 'col');
  b.wire(s('launch'), 'launch');
  b.wire(s('launch'), 'clr');
  b.wire(or2(s('launch'), s('go'), 'goOut'), 'go');
  b.wire(s('swap'), 'swap');
  b.wire(`${st}.q`, 'state');
  const outs = ['xa', 'launch', ...VERTEX_PINS, 'z0', 'z1', 'z2', 'col', 'clr', 'go', 'swap', 'state'];
  const R = b.right;
  return define({
    id: 'cmd_unit', name: 'Command unit', category: 'cpu',
    summary: 'Runs a frame: launches the vertex kernel on the next frame and clears the back frame (the rasterizer walking the screen), reads the triangle count, '
      + 'then for each triangle its word (three vertex indices, a colour) and its three vertices from this frame\'s vertex buffer, four reads on the memory\'s spare port, '
      + 'starts the rasterizer and waits for it. Then it asks for a swap and waits for the flip at vsync and for the kernel, and starts the next frame from the other buffer. One flip-flop a state.',
    ports: [bit('halted', 'in'), bus('xq', 32, 'in'), bit('busy', 'in'), bit('front', 'in'), bit('clk', 'in', 'bottom', true),
      bus('xa', K, 'out'), bit('launch', 'out'), ...VERTEX_PINS.map((p) => bus(p, 8, 'out')), bus('z0', 8, 'out'), bus('z1', 8, 'out'), bus('z2', 8, 'out'), bus('col', 8, 'out'),
      bit('clr', 'out'), bit('go', 'out'), bit('swap', 'out'), bus('state', CU_STATES.length, 'out')],
    symbol: { kind: 'box', label: 'COMMAND UNIT' },
    netlist: () => ({ pins: { ...pinsAt(ins, 0, 6), ...pinsAt(outs, R, 4) }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The command unit's state from its register's value. */
export function cuState(q: number): CuState {
  const i = CU_STATES.findIndex((_, k) => (q >> k) & 1);
  return i < 0 ? 'start' : CU_STATES[i];
}

const gpuCache = new Map<string, ComponentDef>();

/** The whole pipeline for a mesh: the vertex kernel's warp core, the command unit, chapter 30's GPU. */
export function gpu31(m: Mesh): ComponentDef {
  const hit = gpuCache.get(m.id);
  if (hit) return hit;
  const words = assemble(vertexKernel(m)).words;
  const CORE = warpCore(words, { warps: 1, lanes: 4, mul: true, dmemK: K, data: meshData(m), host: true });
  const b = new Builder(10, 14, 4);
  b.pins('clk');
  const core = b.add(CORE, 'vertex kernel', 'core');
  b.next();
  const cu = b.add(CMD_UNIT, 'command unit', 'cmd');
  b.next();
  const r = b.add(rasterizer(true), 'rasterizer', 'rast');
  const sc = b.add(SCAN_OUT, 'scan-out', 'scan');
  b.next();
  const rop = b.op(ROP, [`${r}.fa`, `${r}.fd`, `${r}.fz`, `${r}.fclr`, `${r}.fwe`, b.op1(constWord(1, m.zt ? 1 : 0), [], m.zt ? 'depth test on' : 'depth test off', 'zt'),
    b.op1(constWord(3, 7), [], 'opaque', 'alpha'), '', 'clk'], 'depth test, blend', 'rop');
  b.next();
  const fb = b.op(frameBuffers(), [`${sc}.ra`, `${rop}.wa`, `${rop}.wd`, `${rop}.we`, `${sc}.front`, 'clk'], 'framebuffer', 'fb');
  b.wire(`${fb}.wq`, `${rop}.wq`);
  for (const [d, p] of [['clk', 'clk'], [`${cu}.launch`, 'launch'], [`${cu}.xa`, 'xa']]) b.wire(d, `${core}.${p}`);
  for (const [d, p] of [[`${core}.halted`, 'halted'], [`${core}.xq`, 'xq'], [`${r}.busy`, 'busy'], [`${sc}.front`, 'front'], ['clk', 'clk']]) b.wire(d, `${cu}.${p}`);
  for (const p of [...VERTEX_PINS, 'z0', 'z1', 'z2', 'col', 'clr', 'go']) b.wire(`${cu}.${p}`, `${r}.${p}`);
  b.wire('clk', `${r}.clk`);
  b.wire(`${cu}.swap`, `${sc}.swap`); b.wire(b.op1(TIE1, [], 'flip at vsync', 'sync'), `${sc}.sync`); b.wire('clk', `${sc}.clk`);
  b.next();
  b.wire(`${fb}.rq`, 'pixels');
  b.wire(`${sc}.vsync`, 'vsync');
  b.wire(`${r}.busy`, 'busy');
  const R = b.right;
  const d = define({
    id: `gpu31_${m.id}`, name: `Graphics pipeline (${m.id})`, category: 'cpu',
    summary: 'A vertex kernel on a warp core (one warp, four lanes with multipliers) rotates the mesh into a vertex buffer, a frame ahead; the command unit reads the triangles and their vertices from that memory and feeds the rasterizer, '
      + 'the depth test and the back frame; the scan-out sends the front frame to the screen, and the command unit swaps them at vsync.',
    ports: [bit('clk', 'in', 'bottom', true), bus('pixels', 32, 'out'), bit('vsync', 'out'), bit('busy', 'out')],
    symbol: { kind: 'box', label: 'GPU' },
    netlist: () => ({ pins: { clk: [0, 4], ...pinsAt(['pixels', 'vsync', 'busy'], R, 8) }, instances: b.instances, nets: b.nets() }),
  });
  gpuCache.set(m.id, d);
  return d;
}
