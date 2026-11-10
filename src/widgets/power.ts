// The Power chapter's widgets. Every number is computed: live from a gate simulation (vectorPower on an adder), from the
// pinned measurements of the single-cycle CPU (bench/powercosts.json, recomputed by tests/power-costs.test.ts), from the
// benchmark runs (bench/results.json) and from the device law (phys/cmosv.ts).

import { benchOf, leakPerNandOf, vPoint, type PowerCosts } from '../bench/powercosts';
import costs from '../bench/powercosts.json';
import results from '../bench/results.json';
import { rca } from '../lib/combinational';
import { koggeStone } from '../lib/fastadd';
import { NAND2_UM2, UTILIZATION } from '../lib/tech';
import { delayScale, nandLeakNote, offCurrent, PROCESSES, seriesOff, type Process, V_NOM } from '../phys/cmosv';
import { FF_DRIVER, FF_INPUT, FF_WIRE } from '../sim/netcap';
import { groupDigits } from '../sim/numfmt';
import { energyFj, fmtEnergy, fmtPower, vectorPower, VDD } from '../sim/power';
import { PS_PER_NAND } from '../sim/timing';
import { inPorts } from '../sim/types';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

export const POWER = costs as PowerCosts;

const panel = (title: string, sub: string, ...kids: (Node | string)[]) => h('div', { class: 'widget' }, h('div', { class: 'panel pw-widget' }, h('h3', null, title), h('p', { class: 'sub' }, sub), ...kids));
const svgNS = 'http://www.w3.org/2000/svg';
const svg = (w: number, hgt: number, label: string) => {
  const s = document.createElementNS(svgNS, 'svg');
  s.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  s.setAttribute('class', 'pw-svg');
  s.setAttribute('role', 'img');
  s.setAttribute('aria-label', label);
  return s;
};
const fmtV = (v: number) => `${v.toFixed(2)} V`;
const fmtHz = (mhz: number) => (mhz >= 100 ? `${mhz.toFixed(0)} MHz` : mhz >= 1 ? `${mhz.toFixed(1)} MHz` : mhz >= 1e-3 ? `${(mhz * 1e3).toFixed(1)} kHz` : `${(mhz * 1e6).toFixed(0)} Hz`);
const fmtTime = (s: number) => (s >= 1 ? `${s.toPrecision(3)} s` : s >= 1e-3 ? `${(s * 1e3).toPrecision(3)} ms` : s >= 1e-6 ? `${(s * 1e6).toPrecision(3)} µs` : `${(s * 1e9).toPrecision(3)} ns`);
const fmtAmps = (a: number) => (a >= 1e-6 ? `${(a * 1e6).toPrecision(3)} µA` : a >= 1e-9 ? `${(a * 1e9).toPrecision(3)} nA` : a >= 1e-12 ? `${(a * 1e12).toPrecision(3)} pA` : `${(a * 1e15).toPrecision(3)} fA`);
const pct = (x: number) => `${Math.round(100 * x)} %`;

function slider(label: string, min: number, max: number, step: number, val: number, show: (v: number) => string, on: (v: number) => void): HTMLElement {
  const i = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(val), 'aria-label': label }) as HTMLInputElement;
  const v = h('span', { class: 'num' }, show(val));
  i.addEventListener('input', () => { on(Number(i.value)); v.textContent = show(Number(i.value)); });
  return h('label', { class: 'cx-field' }, h('span', null, label), i, v);
}

function processSwitch(get: () => Process['id'], set: (id: Process['id']) => void): HTMLElement {
  const btns = (['hp', 'lp'] as const).map((id) => {
    const b = h('button', { class: 'btn sm' + (get() === id ? ' on' : ''), 'aria-pressed': String(get() === id) }, PROCESSES[id].name) as HTMLButtonElement;
    b.addEventListener('click', () => { set(id); btns.forEach((x, k) => { const on = (['hp', 'lp'] as const)[k] === id; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); }); });
    return b;
  });
  return h('div', { class: 'pw-seg', role: 'group', 'aria-label': 'Process' }, ...btns);
}

const kpi = (...items: [string, string][]) => h('div', { class: 'pw-kpi' }, ...items.map(([b, s]) => h('div', null, h('b', null, b), h('span', null, s))));

/** Rows of bars: [label, value, text], scaled to the largest. */
function bars(rows: [string, number, string, string?][]): HTMLElement {
  const max = Math.max(...rows.map((r) => r[1]), 1e-30);
  return h('div', { class: 'pw-bars' }, ...rows.flatMap(([name, v, txt, cls]) => [
    h('span', { class: 'pw-name' }, name),
    h('span', { class: 'pw-bar' + (cls ? ` ${cls}` : ''), style: `width:${((100 * v) / max).toFixed(1)}%` }),
    h('span', { class: 'pw-num' }, txt),
  ]));
}

// ---- step 2: one toggle ------------------------------------------------------------------------------------------

export function toggleWidget(): Widget {
  let v = VDD, fan = 1;
  const out = h('div');
  const render = () => {
    const c = FF_DRIVER + fan * (FF_INPUT + FF_WIRE); // fF
    const q = c * v; // fC
    out.replaceChildren(
      kpi([`${c.toFixed(1)} fF`, `the wire: its driver ${FF_DRIVER} fF + ${fan} × (an input ${FF_INPUT} fF + wire ${FF_WIRE} fF)`], [`${q.toFixed(2)} fC`, 'charge Q = C · V the supply delivers on 0 → 1']),
      bars([
        ['supply gives, 0 → 1', c * v * v, `${(c * v * v).toFixed(3)} fJ  (Q · V = C V²)`],
        ['lost in the pull-up', 0.5 * c * v * v, `${(0.5 * c * v * v).toFixed(3)} fJ  (½ C V²)`, 'clk'],
        ['stored on the wire', 0.5 * c * v * v, `${(0.5 * c * v * v).toFixed(3)} fJ  (½ C V²)`],
        ['lost in the pull-down, 1 → 0', 0.5 * c * v * v, `${(0.5 * c * v * v).toFixed(3)} fJ  (the stored half)`, 'clk'],
      ]),
      h('p', { class: 'sub' }, `A full 0 → 1 → 0 swing costs C V² = ${(c * v * v).toFixed(3)} fJ from the supply, ½ C V² = ${(0.5 * c * v * v).toFixed(3)} fJ per toggle. Halve V and it is a quarter; double the fan-out and C (and the energy) nearly doubles.`));
  };
  render();
  return {
    el: panel('One toggle', 'A wire charged through the pull-up transistors and emptied through the pull-down ones. The transistors\' resistance does not matter: it decides how fast, not how much.',
      h('div', { class: 'cx-controls' },
        slider('supply V', 0.3, 1.2, 0.05, v, fmtV, (x) => { v = x; render(); }),
        slider('inputs driven (fan-out)', 1, 8, 1, fan, String, (x) => { fan = x; render(); })),
      out),
  };
}

// ---- step 3: activity --------------------------------------------------------------------------------------------

/** Seeded random words. */
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) & 0xffff;

function stream(kind: 'count' | 'random' | 'held', n: number, w: number): number[][] {
  const r = rng(11), mask = 2 ** w - 1, held = r() & mask;
  return Array.from({ length: n }, (_, i) =>
    kind === 'count' ? [i & mask, 1, 0] : kind === 'random' ? [r() & mask, r() & mask, 0] : [held, (i & 1) ? held : held ^ 1, 0]);
}

export const ACTIVITY_STREAMS = [['count', 'counting (a = 0, 1, 2 …; b = 1)'], ['random', 'random a and b'], ['held', 'a held, b flips its lowest bit']] as const;

export function activityMeasure(): { kind: string; label: string; fj: number }[] {
  const A = rca(8);
  return ACTIVITY_STREAMS.map(([kind, label]) => ({ kind, label, fj: energyFj(vectorPower(A, stream(kind, 257, 8)).switched) }));
}

export function activityWidget(): Widget {
  const out = h('div', null, h('p', { class: 'sub' }, 'Simulating…'));
  const el = panel('Activity: the same adder, three streams of data', 'An 8-bit ripple-carry adder on the gate-level simulator, 256 additions each. Energy per addition at 0.9 V, every toggle counted.', out);
  setTimeout(() => {
    const m = activityMeasure();
    out.replaceChildren(bars(m.map((r) => [r.label, r.fj, fmtEnergy(r.fj)])),
      h('p', { class: 'sub' }, `The circuit is the same; the data decide how many wires change. Random operands cost ${(m[1].fj / m[0].fj).toFixed(1)} times what counting does, and a held operand ${(m[2].fj / m[1].fj * 100).toFixed(0)} % of random. That ratio, the activity α, is the data's, not the circuit's.`));
  }, 30);
  return { el };
}

// ---- step 4: glitches --------------------------------------------------------------------------------------------

function randomVectors(def: Parameters<typeof inPorts>[0], n: number): number[][] {
  const r = rng(5);
  const ins = inPorts(def);
  return Array.from({ length: n }, () => ins.map((p) => (p.width >= 16 ? ((r() << 16) | r()) >>> 0 : r()) % 2 ** Math.min(p.width, 31)));
}

export function glitchMeasure(): { name: string; fj: number; glitch: number }[] {
  return [['Ripple-carry, 16 bits', rca(16)], ['Kogge–Stone, 16 bits', koggeStone(16)]].map(([name, d]) => {
    const r = vectorPower(d as ReturnType<typeof rca>, randomVectors(d as ReturnType<typeof rca>, 200));
    return { name: name as string, fj: energyFj(r.switched), glitch: 1 - r.functional / r.switched };
  });
}

export const GLITCH_CPUS: [string, string][] = [['sc', 'Single-cycle'], ['pipe', 'Pipelined'], ['pipe-bal', 'Pipelined, balanced'], ['pipe-2w', 'Dual-issue'], ['ooo', 'Out of order']];

export function glitchWidget(): Widget {
  const out = h('div', null, h('p', { class: 'sub' }, 'Simulating…'));
  const cpus = GLITCH_CPUS.map(([id, name]) => ({ name, g: benchOf(id).glitch }));
  const el = panel('Glitches: toggles that end where they started', 'Two adders on 200 random additions, then every CPU over the four benchmarks (bench/results.json). The glitch share is the energy of toggles that do not change a net\'s settled value.', out);
  setTimeout(() => {
    const m = glitchMeasure();
    out.replaceChildren(
      h('h4', null, 'Adders, per addition'),
      bars(m.map((r) => [r.name, r.fj, `${fmtEnergy(r.fj)} · ${pct(r.glitch)} glitches`])),
      h('h4', null, 'CPUs, share of their energy that is glitches'),
      bars(cpus.map((c) => [c.name, c.g, pct(c.g)])),
      h('p', { class: 'sub' }, 'A ripple carry settles bit by bit, and every sum bit flips as each carry arrives. Pipeline registers stop a wave of changes at each stage, so the pipelines glitch far less than the single-cycle CPU, whose whole datapath ripples in one cycle.'));
  }, 30);
  return { el };
}

// ---- step 7: the gated CPU ---------------------------------------------------------------------------------------

export function gatedWidget(): Widget {
  const { plain, gated } = POWER;
  const names = [...new Set([...plain.blocks.slice(0, 5), ...gated.blocks.slice(0, 5)].map(([n]) => n))];
  const get = (c: typeof plain, n: string) => c.blocks.find(([x]) => x === n)?.[1] ?? 0;
  const rows: [string, number, string, string?][] = names.flatMap((n) => [
    [`${n}, plain`, get(plain, n), `${get(plain, n).toFixed(2)} pJ`, n.startsWith('clock') ? 'clk' : undefined] as [string, number, string, string?],
    [`${n}, gated`, get(gated, n), `${get(gated, n).toFixed(2)} pJ`, 'gated'] as [string, number, string, string?],
  ]);
  return {
    el: panel('Plain against clock-gated, measured', `The single-cycle CPU on “sum”, ${POWER.cycles} cycles from reset on the gate-level simulator: energy per cycle by block at ${POWER.vdd} V.`,
      kpi([`${plain.pj.toFixed(2)} → ${gated.pj.toFixed(2)} pJ`, `per cycle (${pct(1 - gated.pj / plain.pj)} less)`],
        [`${groupDigits(plain.nands)} → ${groupDigits(gated.nands)}`, 'NANDs: the enable muxes go, a clock gate per register comes'],
        [`${groupDigits(Math.round(plain.clockFf))} → ${groupDigits(Math.round(gated.clockFf))} fF`, 'on the clock net'],
        [`${pct(plain.glitch)} → ${pct(gated.glitch)}`, 'of the energy is glitches']),
      bars(rows)),
  };
}

// ---- step 8: leakage ---------------------------------------------------------------------------------------------

export function leakWidget(): Widget {
  let id: Process['id'] = 'hp';
  const out = h('div');
  const render = () => {
    const p = PROCESSES[id], one = offCurrent(p, V_NOM);
    const states: [string, number][] = [['a = 1, b = 1: two PMOS off, side by side', 2 * one], ['one input 0: one NMOS off', one], ['a = 0, b = 0: two NMOS off, one above the other', seriesOff(p, V_NOM, 2)]];
    const cpu = POWER.plain.leakUw[id] * 1e-6, at = POWER.atVdd[id];
    out.replaceChildren(
      h('h4', null, 'One NAND, by the state of its inputs'),
      bars(states.map(([n, a]) => [n, a, fmtAmps(a)])),
      kpi([fmtPower(cpu), `the whole CPU, averaged over ${POWER.cycles} cycles of “sum”`],
        [`${(100 * at.leakPj / (at.leakPj + at.dynPj)).toPrecision(2)} %`, `of an instruction's energy at ${V_NOM} V`]),
      h('p', { class: 'sub' }, `${p.source}. ${nandLeakNote}`));
  };
  render();
  return { el: panel('Leakage: transistors that are off, but not quite', 'Each NAND leaks through whichever of its transistors are off with the supply across them, so the total depends on the state the circuit is in, which the simulator knows.', processSwitch(() => id, (x) => { id = x; render(); }), out) };
}

// ---- step 9: power gating ----------------------------------------------------------------------------------------

export function sleepWidget(): Widget {
  let id: Process['id'] = 'hp', logT = -5;
  const out = h('div');
  const period = POWER.plain.period * PS_PER_NAND * 1e-12;
  const render = () => {
    const leakW = POWER.plain.leakUw[id] * 1e-6, wake = POWER.plain.wakePj * 1e-12, t = 10 ** logT;
    const stay = leakW * t, even = wake / leakW;
    out.replaceChildren(
      bars([['clock stopped, power on (it leaks)', stay, fmtEnergy(stay * 1e15)], ['power off, then charge every 1 again', wake, fmtEnergy(wake * 1e15), 'clk']]),
      kpi([fmtTime(even), `break-even idle time (${groupDigits(Math.round(even / period))} clock cycles)`], [stay > wake ? 'Power off' : 'Stop the clock', `wins for ${fmtTime(t)} of idling`]),
      h('p', { class: 'sub' }, `Waking costs the charge of every node that must be 1 again: ${POWER.plain.wakePj} pJ, measured on the CPU's own state (${groupDigits(POWER.plain.totalFf)} fF of nets in all). The state itself is lost unless it is kept in retention flip-flops on a supply of their own.`));
  };
  render();
  return {
    el: panel('Sleep: stop the clock, or cut the power?', 'An idle CPU with its clock stopped switches nothing but still leaks. Cutting its supply stops the leak, at the price of charging the circuit again on wake-up.',
      processSwitch(() => id, (x) => { id = x; render(); }),
      h('div', { class: 'cx-controls' }, slider('idle for', -8, -1, 0.1, logT, (v) => fmtTime(10 ** v), (v) => { logT = v; render(); })), out),
  };
}

// ---- step 10: voltage and frequency ------------------------------------------------------------------------------

const SC = benchOf('sc');
const pointAt = (id: Process['id'], v: number) => vPoint(PROCESSES[id], v, SC, POWER.plain.nands, leakPerNandOf(POWER.plain, id));

export function dvfsWidget(): Widget {
  let id: Process['id'] = 'hp', v = V_NOM;
  const out = h('div'), plot = h('div');
  const W = 560, H = 240, X = (x: number) => 50 + ((x - 0.15) / 0.95) * 490;
  const render = () => {
    const at = pointAt(id, v), m = POWER.minimum[id];
    out.replaceChildren(kpi([fmtV(v), 'supply'], [fmtHz(at.mhz), `clock (${SC.period} NAND delays, each ${delayScale(PROCESSES[id], v).toPrecision(3)} × slower than at 0.9 V)`],
      [fmtEnergy((at.dynPj + at.leakPj) * 1e3), 'per instruction'], [pct(at.leakPj / (at.dynPj + at.leakPj)), 'of it leakage']));
    const pts: ReturnType<typeof pointAt>[] = [];
    for (let mv = 150; mv <= 1100; mv += 5) pts.push(pointAt(id, mv / 1000));
    const top = Math.max(...pts.map((p) => p.dynPj + Math.min(p.leakPj, 80)));
    const Y = (e: number) => 210 - (Math.min(e, top) / top) * 195;
    const path = (f: (p: ReturnType<typeof pointAt>) => number) => pts.map((p, k) => `${k ? 'L' : 'M'}${X(p.v).toFixed(1)} ${Y(f(p)).toFixed(1)}`).join('');
    const s = svg(W, H, 'Energy per instruction against supply voltage');
    let ticks = '';
    for (const x of [0.2, 0.4, 0.6, 0.8, 1.0]) ticks += `<text x="${X(x)}" y="228" text-anchor="middle" class="mut">${x.toFixed(1)} V</text>`;
    for (const e of [0, top / 2, top]) ticks += `<text x="44" y="${Y(e) + 4}" text-anchor="end" class="mut">${e.toFixed(0)} pJ</text>`;
    s.innerHTML = `<line x1="50" x2="540" y1="210" y2="210" class="axis"/><line x1="50" x2="50" y1="12" y2="210" class="axis"/>${ticks}
      <path d="${path((p) => p.dynPj)}" class="pw-dyn"/><path d="${path((p) => p.leakPj)}" class="pw-leak"/><path d="${path((p) => p.dynPj + p.leakPj)}" class="pw-tot"/>
      <circle cx="${X(m.v)}" cy="${Y(m.dynPj + m.leakPj)}" r="5" class="pw-min"/>
      <text x="${X(m.v) + 4}" y="${Y(m.dynPj + m.leakPj) - 64}" class="pw-min-t">minimum ${(m.dynPj + m.leakPj).toFixed(1)} pJ at ${m.v.toFixed(3)} V, ${fmtHz(m.mhz)}</text>
      <line x1="${X(v)}" x2="${X(v)}" y1="12" y2="210" class="pw-cursor"/>
      <text x="64" y="24" class="mut">— total   - - dynamic   ··· leakage</text>`;
    plot.replaceChildren(s);
  };
  render();
  return {
    el: panel('Energy per instruction against the supply', `The single-cycle CPU: its switched capacitance per instruction (${groupDigits(Math.round(SC.ffPerInstr / 1000))} pF over the benchmarks) and its critical path from the gates; the current at each voltage from the device law, leakage from its NANDs' measured states.`,
      h('div', { class: 'cx-controls' }, slider('supply', 0.15, 1.1, 0.005, v, fmtV, (x) => { v = x; render(); }), processSwitch(() => id, (x) => { id = x; render(); })), out, plot),
  };
}

// ---- step 11: race to halt ---------------------------------------------------------------------------------------

/** Instructions of the task and the cases' energies (J) for a deadline t (s), per process. */
export function raceCases(id: Process['id'], deadline: number, instr = 10_000): { name: string; j: number; ok: boolean; v?: number }[] {
  const p = PROCESSES[id], leakW = POWER.plain.leakUw[id] * 1e-6, wake = POWER.plain.wakePj * 1e-12;
  const fast = pointAt(id, V_NOM), tFast = instr / (fast.mhz * 1e6);
  const run = instr * (fast.dynPj + fast.leakPj) * 1e-12;
  // the lowest voltage that meets the deadline
  let lo = 0.15, hi = V_NOM;
  for (let k = 0; k < 50; k++) { const m = (lo + hi) / 2; if (instr / (pointAt(id, m).mhz * 1e6) > deadline) lo = m; else hi = m; }
  // never below the minimum-energy point: under it every instruction costs more, so run there and stop the clock early
  const vs = Math.max(hi, POWER.minimum[id].v), slow = pointAt(id, vs), tSlow = instr / (slow.mhz * 1e6);
  const leakAt = (v: number) => POWER.plain.nands * leakPerNandOf(POWER.plain, id) * (offCurrent(p, v) / offCurrent(p, V_NOM)) * v;
  const idle = Math.max(0, deadline - tFast);
  return [
    { name: `race at ${V_NOM} V, then stop the clock`, j: run + leakW * idle, ok: tFast <= deadline },
    { name: `race at ${V_NOM} V, then cut the power`, j: run + wake, ok: tFast <= deadline },
    { name: `run slower, at ${vs.toFixed(3)} V${vs > hi ? ' (the minimum-energy point), then stop the clock' : ', just in time'}`, j: instr * (slow.dynPj + slow.leakPj) * 1e-12 + leakAt(vs) * Math.max(0, deadline - tSlow), ok: tFast <= deadline, v: vs },
  ];
}

export function raceWidget(): Widget {
  let id: Process['id'] = 'hp', logT = -4;
  const out = h('div');
  const render = () => {
    const c = raceCases(id, 10 ** logT);
    if (!c[0].ok) { out.replaceChildren(h('p', { class: 'sub' }, 'Not even at 0.9 V: the deadline is shorter than the task.')); return; }
    const best = Math.min(...c.map((x) => x.j));
    out.replaceChildren(bars(c.map((x) => [x.name + (x.j === best ? '  ✓' : ''), x.j, fmtEnergy(x.j * 1e15)])));
  };
  render();
  return {
    el: panel('Race to halt, or pace yourself?', 'A task of 10 000 instructions on the single-cycle CPU, due before a deadline: run flat out and idle, or lower the supply just enough to finish on time.',
      processSwitch(() => id, (x) => { id = x; render(); }),
      h('div', { class: 'cx-controls' }, slider('deadline', -4.4, -1, 0.05, logT, (v) => fmtTime(10 ** v), (v) => { logT = v; render(); })), out),
  };
}

// ---- step 12: which CPU ------------------------------------------------------------------------------------------

interface CpuRow { id: string; name: string; nands: number; ffPerInstr: number; cpi: number; period: number }
const ALL = (results as { cpus: { id: string; name: string; nands: number; period: number; runs: { switched?: number }[] }[] }).cpus;
export const FRONT_CPUS: CpuRow[] = ['sc', 'sc-ks', 'mc-micro', 'pipe', 'pipe-bal', 'pipe-bal-bp', 'pipe-m', 'pipe-2w', 'ooo'].flatMap((id) => {
  const c = ALL.find((x) => x.id === id);
  if (!c || !c.runs.some((r) => r.switched)) return [];
  const b = benchOf(id);
  return [{ id, name: c.name, nands: c.nands, ffPerInstr: b.ffPerInstr, cpi: b.cpi, period: b.period }];
});

/** A CPU's energy per instruction (pJ) at the voltage that gives `ns` per instruction (null: too fast for it at 1.1 V). */
export function atSpeed(c: CpuRow, ns: number, id: Process['id'] = 'hp'): { v: number; pj: number } | null {
  const p = PROCESSES[id], per = leakPerNandOf(POWER.plain, id);
  const time = (v: number) => c.cpi * c.period * PS_PER_NAND * 1e-3 * delayScale(p, v);
  if (time(1.1) > ns) return null;
  let lo = 0.15, hi = 1.1;
  for (let k = 0; k < 50; k++) { const m = (lo + hi) / 2; if (time(m) > ns) lo = m; else hi = m; }
  const pt = vPoint(p, hi, c, c.nands, per);
  return { v: hi, pj: pt.dynPj + pt.leakPj };
}

export function frontWidget(): Widget {
  let ns = 4;
  const out = h('div');
  const render = () => {
    const rows = FRONT_CPUS.map((c) => ({ c, at: atSpeed(c, ns), base: vPoint(PROCESSES.hp, V_NOM, c, c.nands, leakPerNandOf(POWER.plain, 'hp')) }));
    const ok = rows.filter((r) => r.at).sort((a, b) => a.at!.pj - b.at!.pj);
    out.replaceChildren(
      h('h4', null, `At ${ns.toFixed(1)} ns per instruction, each at the supply that gives it`),
      bars(ok.map((r) => [r.c.name, r.at!.pj, `${r.at!.pj.toFixed(1)} pJ at ${r.at!.v.toFixed(2)} V`])),
      ...(ok.length < rows.length ? [h('p', { class: 'sub' }, `Too slow for it even at 1.1 V: ${rows.filter((r) => !r.at).map((r) => r.c.name).join(', ')}.`)] : []),
      h('h4', null, `All at ${V_NOM} V`),
      bars(rows.map((r) => [r.c.name, r.base.dynPj + r.base.leakPj, `${((r.c.cpi * r.c.period * PS_PER_NAND) / 1000).toFixed(2)} ns · ${(r.base.dynPj + r.base.leakPj).toFixed(1)} pJ`])));
  };
  render();
  return {
    el: panel('Which CPU for the job', 'Every CPU over the four benchmarks (bench/results.json): time and energy per instruction at 0.9 V, then each slid along its own voltage curve to a common speed. A fast design can spend its spare speed on a lower supply.',
      h('div', { class: 'cx-controls' }, slider('time per instruction', 1.5, 12, 0.1, ns, (v) => `${v.toFixed(1)} ns`, (v) => { ns = v; render(); })), out),
  };
}

// ---- step 13: power density --------------------------------------------------------------------------------------

export function densityWidget(): Widget {
  let budget = 15, die = 100;
  const out = h('div');
  const at = POWER.atVdd.hp, area = (POWER.plain.nands * NAND2_UM2) / UTILIZATION / 1e6; // mm²
  const watts = (at.dynPj + at.leakPj) * 1e-12 * at.mhz * 1e6;
  const render = () => {
    const full = (watts / area) * die;
    out.replaceChildren(kpi([`${(watts / area).toFixed(1)} W/mm²`, `the single-cycle CPU at ${V_NOM} V: ${fmtPower(watts)} on ${(area).toFixed(3)} mm²`],
      [`${full.toFixed(0)} W`, `a ${die} mm² die of such logic, all of it running`],
      [pct(Math.min(1, budget / full)), `of it can run at once within ${budget} W`]));
  };
  render();
  return {
    el: panel('Power density: dark silicon', `NANDs at ${NAND2_UM2} µm² each, ${pct(UTILIZATION)} of the floor used (the silicon chapter's figures).`,
      h('div', { class: 'cx-controls' },
        slider('die area', 10, 400, 10, die, (v) => `${v} mm²`, (v) => { die = v; render(); }),
        slider('power budget', 1, 300, 1, budget, (v) => `${v} W`, (v) => { budget = v; render(); })), out),
  };
}
