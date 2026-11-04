// Chapter 44's I²C widgets: what the pull-up costs (rise time against the I²C-bus specification's limits, static current),
// and the panels that drive the switch-level bus scenes: a frame with its decode, and two controllers starting together.

import '../styles/clocks.css';
import '../styles/spi.css';
import { cycleEnergy, decodeBus, describeBus, fastestMode, I2C_MODES, lowCurrent, riseTime, RISE_30_70, rpMax, rpMin, START, STOP, VOL_MAX, WRITE, READ, feasible, type BusSample } from '../comm/i2c';
import { i2cBus, i2cWired2 } from '../lib/i2c';
import { findNode } from '../sim/flatten';
import { pack } from '../sim/values';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { fitText, slider } from './mosparts';
import { waveSvg, type WaveRow } from './spi';

const nf = (x: number, d = 2) => x.toFixed(d);
const eng = (x: number, unit: string): string => {
  const a = Math.abs(x);
  if (a >= 1) return `${nf(x, 2)} ${unit}`;
  if (a >= 1e-3) return `${nf(x * 1e3, a >= 1e-2 ? 1 : 2)} m${unit}`;
  if (a >= 1e-6) return `${nf(x * 1e6, 1)} µ${unit}`;
  if (a >= 1e-9) return `${nf(x * 1e9, 0)} n${unit}`;
  return `${nf(x * 1e12, 0)} p${unit}`;
};
const ohms = (r: number): string => (r >= 1e3 ? `${nf(r / 1e3, r >= 1e4 ? 1 : 2)} kΩ` : `${nf(r, 0)} Ω`);

// ---- the wired-AND scene ----------------------------------------------------------------------------------------------------

export function wiredScene(): Scene {
  return { root: i2cWired2(), inputs: { a: 1, b: 1 } };
}

// ---- 6. what the pull-up costs --------------------------------------------------------------------------------------------

export function pullupWidget(): Widget {
  let vdd = 3.3, cpf = 100, lr = 3.3, mode = 1;
  const W = 520, H = 210, m = { l: 52, r: 30, t: 12, b: 34 };
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot', role: 'img', 'aria-label': 'Rise of the wire through the pull-up resistor against the mode\'s limit' }) as SVGSVGElement;
  fitText(svg, W);
  const curve = svg.appendChild(s('path', { class: 'pu-rise' }));
  const lim = svg.appendChild(s('line', { class: 'pu-lim', y1: m.t, y2: H - m.b }));
  const l30 = svg.appendChild(s('line', { class: 'pu-30', x1: m.l, x2: W - m.r })), l70 = svg.appendChild(s('line', { class: 'pu-30', x1: m.l, x2: W - m.r }));
  const axis = svg.appendChild(s('g'));
  const note = h('p', { class: 'sub mos-note' }), verdict = h('p', { class: 'clk-verdict', role: 'status' });
  const chips = [h('div'), h('div'), h('div'), h('div')];
  const limits = h('div', { class: 'pu-limits' });
  const paint = () => {
    const R = 10 ** lr, C = cpf * 1e-12, md = I2C_MODES[mode];
    const tMax = Math.max(md.trMax * 3, 3 * R * C);
    const X = (t: number) => m.l + (t / tMax) * (W - m.l - m.r), Y = (v: number) => H - m.b - (v / vdd) * (H - m.t - m.b);
    curve.setAttribute('d', Array.from({ length: 121 }, (_, i) => { const t = (i / 120) * tMax; return `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(vdd * (1 - Math.exp(-t / (R * C)))).toFixed(1)}`; }).join(''));
    // the spec measures 30 % to 70 % of VDD: the limit is the time the curve spends between the two lines
    const t30 = -R * C * Math.log(0.7);
    l30.setAttribute('y1', String(Y(0.3 * vdd))); l30.setAttribute('y2', String(Y(0.3 * vdd)));
    l70.setAttribute('y1', String(Y(0.7 * vdd))); l70.setAttribute('y2', String(Y(0.7 * vdd)));
    const xl = X(t30 + md.trMax);
    lim.setAttribute('x1', String(xl)); lim.setAttribute('x2', String(xl)); lim.style.display = t30 + md.trMax <= tMax ? '' : 'none';
    axis.replaceChildren(
      s('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'ax' }), s('line', { x1: m.l, x2: m.l, y1: m.t, y2: H - m.b, class: 'ax' }),
      ...[0, 0.3, 0.7, 1].map((f) => s('text', { x: m.l - 6, y: Y(f * vdd) + 3.5, 'text-anchor': 'end', class: 'tick' }, `${nf(f * vdd, 1)}`)),
      ...[0, 1 / 3, 2 / 3, 1].map((f) => s('text', { x: X(f * tMax), y: H - m.b + 14, 'text-anchor': 'middle', class: 'tick' }, eng(f * tMax, 's'))),
      s('text', { x: W - m.r, y: H - 4, 'text-anchor': 'end', class: 'axl' }, 'time after the last pad lets go'), s('text', { x: 6, y: m.t, 'text-anchor': 'end', 'dominant-baseline': 'hanging', transform: `rotate(-90 6 ${m.t})`, class: 'axl' }, 'wire (V)'));
    const tr = riseTime(R, C), ok = tr <= md.trMax, iLow = lowCurrent(R, vdd);
    const vals: [string, string][] = [[eng(tr, 's'), `rise 30 → 70 % (limit ${eng(md.trMax, 's')})`], [eng(iLow, 'A'), `static current while low (VOL ${VOL_MAX} V)`],
      [eng(vdd * iLow, 'W'), 'power while a line is held low'], [eng(cycleEnergy(R, C, vdd, 0.5 / md.fscl), 'J'), `energy a line draws per SCL cycle at ${md.fscl / 1e3} kHz`]];
    chips.forEach((c, i) => c.replaceChildren(h('b', null, vals[i][0]), h('span', null, vals[i][1])));
    const rmax = rpMax(md, C), rmin = rpMin(md, vdd), feas = rmax >= rmin;
    verdict.className = `clk-verdict ${ok && C <= md.cbMax && iLow <= md.iol ? 'ok' : 'bad'}`;
    verdict.textContent = C > md.cbMax ? `${cpf} pF is over the ${md.name} limit of ${md.cbMax * 1e12} pF: no pull-up fixes that.`
      : !ok ? `Too slow for ${md.name}: ${eng(tr, 's')} against ${eng(md.trMax, 's')}. The resistor must be at most ${ohms(rmax)}.`
        : iLow > md.iol ? `Too strong: a pad must sink ${eng(iLow, 'A')}, the spec gives ${eng(md.iol, 'A')} at ${VOL_MAX} V. The resistor must be at least ${ohms(rmin)}.`
          : `${md.name} is met: ${eng(tr, 's')} rise, ${eng(iLow, 'A')} sunk. The window for R is ${ohms(rmin)} to ${ohms(rmax)}.`;
    void feas;
    const best = fastestMode(C, vdd);
    limits.replaceChildren(...I2C_MODES.map((x, i) => {
      const lo = rpMin(x, vdd), hi = rpMax(x, C), f = feasible(x, C, vdd);
      const lx = (r: number) => Math.max(0, Math.min(100, ((Math.log10(r) - 2) / 3) * 100));
      return h('div', { class: 'pu-row' }, h('span', null, x.name, i === mode ? ' ◂' : ''),
        h('div', { class: 'pu-bar', role: 'img', 'aria-label': `${x.name}: legal pull-up from ${ohms(lo)} to ${ohms(hi)}${f ? '' : ' (empty)'}` },
          f ? h('div', { class: 'pu-ok', style: `left:${lx(lo)}%;width:${lx(hi) - lx(lo)}%` }) : null, h('div', { class: 'pu-at', style: `left:calc(${lx(R)}% - 1px)` })),
        h('span', null, f ? h('b', null, `${ohms(lo)} – ${ohms(hi)}`) : h('b', null, C > x.cbMax ? 'too much C' : `none (${ohms(hi)} < ${ohms(lo)})`)));
    }));
    note.textContent = `${best ? `At ${cpf} pF and ${vdd} V the fastest mode with a legal pull-up is ${best.name} (${best.fscl / 1e3} kHz).` : `At ${cpf} pF and ${vdd} V no mode has a legal pull-up.`} Bars: R from 100 Ω to 100 kΩ on a log axis; the marker is your R.`;
  };
  const vSl = slider('Supply', 2, 5, 0.1, vdd, (v) => `${nf(v, 1)} V`, (v) => { vdd = v; paint(); });
  const cSl = slider('Bus capacitance', 10, 600, 5, cpf, (v) => `${v} pF`, (v) => { cpf = v; paint(); });
  const rSl = slider('Pull-up R', 2, 5, 0.01, lr, (v) => ohms(10 ** v), (v) => { lr = v; paint(); });
  const sel = h('select', { class: 'mc-sel', 'aria-label': 'I²C mode' }) as HTMLSelectElement;
  I2C_MODES.forEach((x, i) => sel.append(h('option', { value: String(i) }, `${x.name}, ${x.fscl / 1e3} kHz`)));
  sel.value = String(mode);
  sel.addEventListener('change', () => { mode = Number(sel.value); paint(); });
  const el = h('div', { class: 'widget mos clk-w' },
    h('div', { class: 'panel' }, h('h3', null, 'A 1 is a capacitor charging through a resistor'), svg, h('div', { class: 'mos-row' }, sel),
      h('div', { class: 'mos-row' }, rSl.el, cSl.el, vSl.el), h('div', { class: 'mos-chips' }, ...chips), verdict, limits, note,
      h('p', { class: 'sub mos-note' }, `Rise time is measured 30 % to 70 % of VDD: t = R C ln(0.7 / 0.3) = ${nf(RISE_30_70, 4)} R C. Limits (rise time, bus capacitance, sink current at ${VOL_MAX} V) are those of NXP UM10204, the I²C-bus specification: Standard-mode 1000 ns, Fast-mode 300 ns, Fast-mode Plus 120 ns; 400, 400 and 550 pF; 3, 3 and 20 mA. VDD is kept above 2 V (below it the spec's low level is 0.2 VDD). The pad's own strength is not modelled; the curve is the ideal RC.`)));
  paint();
  return { el };
}

// ---- the bus panels -------------------------------------------------------------------------------------------------------

type Cmd = [number, number];
const addrW = (a: number): Cmd => [WRITE, a << 1], addrR = (a: number): Cmd => [WRITE, (a << 1) | 1];
const TARGET = 0x50;

interface Opts { arb: boolean }
interface Clock { sda: number; scl: number; send0: number; send1: number }
export interface BusApi { run(i: number): void; samples(): BusSample[]; lost(): (number | null)[] }
export const busApi = new WeakMap<Stage, BusApi>();

const FRAME_OPS: { label: string; title: string; cmds: Cmd[] }[] = [
  { label: 'Write 0xA7 to register 1', title: 'START, address 0x50 + W, register pointer 1, data 0xA7, STOP', cmds: [[START, 0], addrW(TARGET), [WRITE, 1], [WRITE, 0xa7], [STOP, 0]] },
  { label: 'Read register 1 back', title: 'START, address + W, pointer 1, repeated START, address + R, one byte with NACK, STOP', cmds: [[START, 0], addrW(TARGET), [WRITE, 1], [START, 0], addrR(TARGET), [READ, 1], [STOP, 0]] },
  { label: 'Address nobody has', title: 'START, address 0x2A + W, which no target answers, STOP', cmds: [[START, 0], addrW(0x2a), [WRITE, 0], [STOP, 0]] },
];
const ADDR_LABEL = ['A6', 'A5', 'A4', 'A3', 'A2', 'A1', 'A0', 'R/W'];

function nodePort(stage: Stage, path: string[], port: string): number {
  const sim = stage.sim;
  const node = sim && findNode(sim.design.root, path);
  return node ? pack(sim.getBits(node.ports[port])) : -1;
}

/** A panel for the switch-level bus: queues commands per controller, records the wires every clock, decodes them. */
function busPanel({ arb }: Opts): ScenePanel {
  return (stage: Stage): Widget => {
    const nCtl = arb ? 2 : 1;
    let resetLeft = 0, queues: Cmd[][] = [], clocks: Clock[] = [], timer: ReturnType<typeof setTimeout> | null = null, lostAt: (number | null)[] = [null, null], stopWhenLost = false, flip = 1, scriptName = '';
    const v = (p: string) => stage.value(p);
    const hook = {
      before: () => {
        const sim = stage.sim;
        if (!sim) return;
        // switch-level flip-flops power up unknown: hold rst for four edges before anything else (and again after a power cycle)
        if (v('ready0') !== 0 && v('ready0') !== 1 && !resetLeft) resetLeft = 4;
        if (resetLeft > 0) {
          resetLeft--;
          sim.setInput('rst', 1);
          for (let k = 0; k < nCtl; k++) sim.setInput(`go${k}`, 0);
          sim.settle();
          return;
        }
        sim.setInput('rst', 0);
        for (let k = 0; k < nCtl; k++) {
          if (v(`ready${k}`) === 1 && queues[k]?.length && !v(`lost${k}`)) {
            const [cmd, din] = queues[k].shift()!;
            sim.setInput(`go${k}`, 1); sim.setInput(`cmd${k}`, cmd); sim.setInput(`din${k}`, din);
          } else sim.setInput(`go${k}`, 0);
        }
        sim.settle();
      },
      after: () => {
        clocks.push({ sda: v('sda'), scl: v('scl'), send0: 1 - nodePort(stage, ['c0'], 'sda_o'), send1: arb ? 1 - nodePort(stage, ['c1'], 'sda_o') : 1 });
        if (clocks.length > 700) clocks.shift();
        for (let k = 0; k < nCtl; k++) {
          if (v(`lost${k}`) === 1 && lostAt[k] === null) { lostAt[k] = clocks.length - 1; queues[k] = []; }
        }
        paint();
      },
    };
    stage.edgeHooks.add(hook);
    stage.historyHooks.add({
      save: () => ({ queues: queues.map((q) => [...q]), clocks: clocks.slice(), lostAt: [...lostAt], scriptName }),
      restore: (x) => { const o = x as { queues: Cmd[][]; clocks: Clock[]; lostAt: (number | null)[]; scriptName: string }; queues = o.queues.map((q) => [...q]); clocks = o.clocks.slice(); lostAt = [...o.lostAt]; scriptName = o.scriptName; paint(); },
    });
    const clear = () => { stop(); queues = []; clocks = []; lostAt = [null, null]; scriptName = ''; paint(); };
    stage.resetHooks.add(clear);
    const stop = () => { if (timer) clearTimeout(timer); timer = null; };
    const busy = () => queues.some((q) => q.length) || [...Array(nCtl).keys()].some((k) => v(`ready${k}`) === 0);
    const go = () => {
      stop();
      const slice = () => {
        timer = null;
        stage.checkpoint();
        stage.runCycles(6, () => stopWhenLost && lostAt.some((x) => x !== null), 0, true);
        stage.refresh();
        if (busy() && !(stopWhenLost && lostAt.some((x) => x !== null))) timer = setTimeout(slice, 20);
        paint();
      };
      slice();
    };
    const start = (scripts: Cmd[][], name: string, untilLoss = false) => {
      if (busy()) return;
      queues = scripts.map((q) => [...q]); scriptName = name; stopWhenLost = untilLoss; clocks = []; lostAt = [null, null];
      go();
    };
    const arbScripts = (): Cmd[][] => {
      const a1 = TARGET ^ (1 << (6 - flip));
      const sc = (a: number): Cmd[] => [[START, 0], addrW(a), [WRITE, 0], [WRITE, 0x3c], [STOP, 0]];
      return [sc(TARGET), sc(a1)];
    };
    const run = (i: number) => (arb ? start(arbScripts(), 'arbitration', i === 0) : start([FRAME_OPS[i].cmds], FRAME_OPS[i].label));
    const WIN = arb ? 100 : 150;
    const wave = h('div', { class: 'spi-view' }), frame = h('div', { class: 'i2c-frame', role: 'status' }), status = h('div', { class: 'i2c-lost', role: 'status' });
    const paint = () => {
      const tail: (Clock | null)[] = clocks.slice(-WIN);
      while (tail.length < WIN) tail.push(null); // a fixed width, so a short run is drawn at the same scale
      const at = (f: (c: Clock) => number) => tail.map((c) => (c ? f(c) : null));
      const rows: WaveRow[] = arb
        ? [{ label: 'ctl 0', bits: at((c) => c.send0), cls: 'sda' }, { label: 'ctl 1', bits: at((c) => c.send1), cls: 'sda2' }, { label: 'SDA', bits: at((c) => c.sda), cls: 'cs' }, { label: 'SCL', bits: at((c) => c.scl), cls: 'clk' }]
        : [{ label: 'SDA', bits: at((c) => c.sda), cls: 'sda' }, { label: 'SCL', bits: at((c) => c.scl), cls: 'scl' }];
      wave.replaceChildren(clocks.length ? waveSvg(rows, WIN, { slotW: 3.1, rowH: 30, labelW: 40, label: `SDA and SCL over the last ${Math.min(clocks.length, WIN)} clocks` }) : h('p', { class: 'sub' }, 'Nothing on the wires yet.'));
      wave.scrollLeft = wave.scrollWidth;
      const ev = decodeBus(clocks);
      frame.replaceChildren(h('span', { class: 'k' }, scriptName ? `${scriptName}: ` : 'frame: '), ev.length ? describeBus(ev) : '–');
      if (arb) {
        const lines: string[] = [];
        for (let k = 0; k < 2; k++) {
          const t = lostAt[k];
          if (t === null) continue;
          const st = decodeBus(clocks.slice(0, t + 1)).find((e) => e.kind === 'start');
          let rises = 0;
          for (let i = (st?.t ?? 0) + 1; i <= t; i++) if (clocks[i].scl && !clocks[i - 1].scl) rises++;
          const bit = Math.max(0, Math.min(7, rises - 1));
          lines.push(`Controller ${k} read a 0 where it sent a 1 in address bit ${ADDR_LABEL[bit]} (bit ${bit + 1} of the frame) and let go of both wires at clock ${t}.`);
        }
        status.className = `i2c-lost ${lines.length ? 'bad' : ''}`;
        status.textContent = lines.length ? `${lines.join(' ')} The other frame went on.` : clocks.length ? 'Both controllers are still sending the same bits.' : 'Pick the address bit where the two addresses differ, then start both.';
      } else {
        const acks = ev.filter((e) => e.kind === 'byte');
        status.className = `i2c-lost ${acks.some((e) => e.kind === 'byte' && !e.ack) ? 'bad' : acks.length ? 'ok' : ''}`;
        status.textContent = acks.length ? `${acks.length} byte${acks.length === 1 ? '' : 's'} so far, ${acks.filter((e) => e.kind === 'byte' && e.ack).length} acknowledged. ${clocks.length} clocks at ${nCtl} controller and 1 target.` : 'Choose a frame to run. A frame takes a few hundred clocks, each a full solve of the switch-level circuit.';
      }
    };
    const btn = (label: string, title: string, f: () => void) => { const b = h('button', { class: 'btn sm', title }, label); b.addEventListener('click', f); return b; };
    let controls: Node[];
    if (arb) {
      const sel = h('select', { class: 'mc-sel', 'aria-label': 'Address bit where the two addresses differ' }) as HTMLSelectElement;
      for (let j = 0; j < 7; j++) sel.append(h('option', { value: String(j) }, `${ADDR_LABEL[j]} (${(TARGET >> (6 - j)) & 1 ? 'controller 0 sends 1' : 'controller 1 sends 1'})`));
      sel.value = String(flip);
      sel.addEventListener('change', () => { flip = Number(sel.value); });
      controls = [h('label', { class: 'i2c-sel' }, 'Addresses differ at ', sel), h('div', { class: 'dram-ops' }, btn('Start both, stop at the loss', 'Both controllers send START and the same frame to different addresses', () => run(0)), btn('Start both, whole frames', 'Run both frames to their STOP', () => run(1)), btn('Clear', 'Forget the wires', clear))];
    } else {
      controls = [h('div', { class: 'dram-ops' }, ...FRAME_OPS.map((o, i) => btn(o.label, o.title, () => run(i))), btn('Clear', 'Forget the wires', clear))];
    }
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel', 'data-dock': 'right' },
      h('h4', null, arb ? 'Two controllers, one bus' : 'A frame on the wires', h('span', { class: 'fold-hint' })), ...controls, wave, frame, status,
      h('p', { class: 'sub' }, arb ? 'The top two rows are what each controller sends (1: it lets go). The bus is their AND. Both start in the same clock, so they agree until the first bit where they do not.' : 'The wires are read at the pins of the pads. ACK is SDA pulled low by the receiver for the ninth clock; NACK is the pull-up winning.'));
    paint();
    busApi.set(stage, { run, samples: () => clocks, lost: () => lostAt });
    return { el, update: paint, destroy: () => { stop(); stage.edgeHooks.delete(hook); busApi.delete(stage); } };
  };
}

/** One controller, one target, two wires, two pull-ups: all transistors. */
export function i2cFrameScene(): Scene {
  return { root: i2cBus(1, [{ adr: TARGET }]), inputs: { go0: 0, cmd0: 0, din0: 0, stretch0: 0, rst: 0 }, clock: 'clk', autoClock: false, hiddenInputs: ['go0', 'cmd0', 'din0', 'rst'], panels: [busPanel({ arb: false })], memory: false };
}
/** Two controllers on the same wires. */
export function i2cArbScene(): Scene {
  return { root: i2cBus(2, [{ adr: TARGET }]), inputs: { go0: 0, cmd0: 0, din0: 0, go1: 0, cmd1: 0, din1: 0, stretch0: 0, rst: 0 }, clock: 'clk', autoClock: false, hiddenInputs: ['go0', 'cmd0', 'din0', 'go1', 'cmd1', 'din1', 'rst'], panels: [busPanel({ arb: true })], memory: false };
}
