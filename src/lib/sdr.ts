// The software radio's front end in gates (chapter "A software radio"): a complex mixer (a phase register and two sine tables, four multipliers) and, behind it, a CIC on I and on Q.
// dsp/sdr.ts's MixModel and FrontModel are compared with both, every clock (tests/dsp-sdr.test.ts). Registers wrap by design, as in lib/multirate.ts; the mixer drops its low bits (a floor).

import { NCO_AMP, NCO_BITS, NCO_K, NCO_SHIFT, oscTables, W_CIC, W_IN, W_MIX, CIC_N, CIC_R } from '../dsp/sdr';
import type { ComponentDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { addSub, rca } from './combinational';
import { define } from './define';
import { cut, placed } from './fft';
import { cicDecimator } from './multirate';
import { lookupRom } from './modem';
import { treeMul } from './muldiv';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clkPort: PortDef = { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true };

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

function built(b: Builder, ports: PortDef[]) {
  const R = b.right;
  let li = 0, ri = 0;
  const pins: Record<string, [number, number]> = {};
  for (const p of ports) {
    if (p.side === 'bottom') pins[p.name] = [8, b.height + 3];
    else if (p.dir === 'in') pins[p.name] = [0, 2 + 3 * li++];
    else pins[p.name] = [R, 2 + 3 * ri++];
  }
  return { pins, instances: b.instances, nets: b.nets() };
}

const word = (v: number, w: number) => ((v % 2 ** w) + 2 ** w) % 2 ** w;

/** One period of the oscillator in 2^k steps, a signed byte each: the word is the table index. */
export const sdrRom = (kind: 'cos' | 'sin', k: number = NCO_K): ComponentDef => lookupRom(`sdr_rom_${kind}${k}`, `ROM: ${kind} in ${2 ** k} steps`, k, 8,
  oscTables(k)[kind].map((v) => word(v, 8)), `${2 ** k} signed bytes: round(${NCO_AMP} · ${kind}(2π i / ${2 ** k})). ${NCO_AMP} stands for 1.0.`);

/** A phase register that adds the tuning word every clock, and the two tables read at its top bits: cos θ and sin θ, together. */
export const sdrNco = (k: number = NCO_K): ComponentDef => memo(`sdr_nco${k}`, () => {
  const b = new Builder(10, 12, 4);
  b.pins('ftw', 'clk');
  const gnd = b.op(TIE0, [], undefined, 'gnd'), one = b.op(TIE1, [], undefined, 'one');
  const acc = b.add(register(NCO_BITS), 'phase', 'acc');
  b.next();
  const s = b.op(rca(NCO_BITS), [`${acc}.q`, 'ftw', `${gnd}.y`], 'phase + word', 'add');
  b.wire(`${s}.s`, `${acc}.d`); b.wire(`${one}.y`, `${acc}.en`); b.wire('clk', `${acc}.clk`);
  const top = b.op1(cut(NCO_BITS, NCO_BITS - k, k), [`${acc}.q`], 'top bits', 'top');
  b.next();
  const c = b.op1(sdrRom('cos', k), [top], 'cos θ', 'cos'), sn = b.op1(sdrRom('sin', k), [top], 'sin θ', 'sin');
  b.next();
  b.wire(c, 'c'); b.wire(sn, 's');
  const ports = [bus('ftw', NCO_BITS, 'in'), clkPort, bus('c', 8, 'out'), bus('s', 8, 'out')];
  return define({
    id: `sdr_nco${k}`, name: 'NCO: cos and sin of a turning phase', category: 'sequential',
    summary: `A ${NCO_BITS}-bit register adds the tuning word at every clock, so the phase turns at word / 2^${NCO_BITS} of the sample rate. Its top ${k} bits address two tables, one of cos and one of sin.`,
    ports, symbol: { kind: 'box', label: 'NCO', w: 8 }, netlist: () => built(b, ports),
  });
});

/**
 * (xr + j xi)(cos θ − j sin θ), four multipliers and two adders: yr = (xr cos + xi sin) ≫ 7, yi = (xi cos − xr sin) ≫ 7. The product of two 10-bit words is 20 bits, the sum of two
 * of them stays inside 18, and the 11 bits that are kept begin at bit 7: a rotated sample can be √2 as large as it was.
 */
export const complexMixer = (k: number = NCO_K): ComponentDef => memo(`sdr_mixer${k}`, () => {
  const b = new Builder(10, 12, 4);
  b.pins('xr', 'xi', 'ftw', 'clk');
  const nco = b.op(sdrNco(k), ['ftw', 'clk'], 'local oscillator', 'nco');
  b.next();
  const cx = b.op1(placed(8, 0, W_IN), [`${nco}.c`], 'cos, sign-extended', 'cx'), sx = b.op1(placed(8, 0, W_IN), [`${nco}.s`], 'sin, sign-extended', 'sx');
  b.next();
  const M = treeMul(W_IN, true);
  const rc = b.op1(M, ['xr', cx], 'xr · cos', 'rc'), is = b.op1(M, ['xi', sx], 'xi · sin', 'is');
  const ic = b.op1(M, ['xi', cx], 'xi · cos', 'ic'), rs = b.op1(M, ['xr', sx], 'xr · sin', 'rs');
  b.next();
  const gnd = b.op(TIE0, [], undefined, 'gnd'), one = b.op(TIE1, [], undefined, 'one');
  const sr = b.op(rca(2 * W_IN), [rc, is, `${gnd}.y`], 'xr·cos + xi·sin', 'sr');
  const si = b.op(addSub(2 * W_IN), [ic, rs, `${one}.y`], 'xi·cos − xr·sin', 'si');
  b.next();
  const yr = b.op1(cut(2 * W_IN, NCO_SHIFT, W_MIX), [`${sr}.s`], '≫ 7', 'yr'), yi = b.op1(cut(2 * W_IN, NCO_SHIFT, W_MIX), [`${si}.s`], '≫ 7', 'yi');
  b.next();
  b.wire(yr, 'yr'); b.wire(yi, 'yi');
  const ports = [bus('xr', W_IN, 'in'), bus('xi', W_IN, 'in'), bus('ftw', NCO_BITS, 'in'), clkPort, bus('yr', W_MIX, 'out'), bus('yi', W_MIX, 'out')];
  return define({
    id: `sdr_mixer${k}`, name: 'Complex mixer', category: 'arithmetic',
    summary: 'Multiplies a complex sample by e^(−jθ), the local oscillator turning at the tuning word: the station at that frequency lands on zero. Four multipliers and two adders; the oscillator is a register and two tables.',
    ports, symbol: { kind: 'box', label: 'MIX', w: 8 }, netlist: () => built(b, ports),
  });
});

/** The front end: the mixer, then a CIC for I and one for Q, which count the same clocks from reset and so strobe together. */
export const sdrFront = (k: number = NCO_K): ComponentDef => memo(`sdr_front${k}`, () => {
  const b = new Builder(10, 12, 6);
  b.pins('xr', 'xi', 'ftw', 'clk');
  const mix = b.op(complexMixer(k), ['xr', 'xi', 'ftw', 'clk'], 'mix to zero', 'mix');
  b.next();
  const ci = b.op(cicDecimator(CIC_N, CIC_R, W_MIX), [`${mix}.yr`, 'clk'], 'CIC on I', 'cici'), cq = b.op(cicDecimator(CIC_N, CIC_R, W_MIX), [`${mix}.yi`, 'clk'], 'CIC on Q', 'cicq');
  b.next();
  b.wire(`${ci}.y`, 'yr'); b.wire(`${cq}.y`, 'yi'); b.wire(`${ci}.valid`, 'valid');
  const ports = [bus('xr', W_IN, 'in'), bus('xi', W_IN, 'in'), bus('ftw', NCO_BITS, 'in'), clkPort, bus('yr', W_CIC, 'out'), bus('yi', W_CIC, 'out'), bit('valid', 'out')];
  return define({
    id: `sdr_front${k}`, name: 'Receiver front end (mixer + CIC ÷ 4)', category: 'arithmetic',
    summary: `The ${W_IN}-bit I and Q of a band in, the tuned station out at a quarter of the rate in ${W_CIC}-bit words: a complex mixer and two order-${CIC_N} CICs. No filter coefficient is stored anywhere but the oscillator's tables.`,
    ports, symbol: { kind: 'box', label: 'FRONT', w: 8 }, netlist: () => built(b, ports),
  });
});
