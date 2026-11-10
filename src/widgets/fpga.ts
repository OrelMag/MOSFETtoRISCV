// The FPGA chapter's widgets (chapters/ch-fpga.ts): the two flows, a LUT you program by hand or by expression, the LUTs a
// netlist maps to (a scene panel lighting each LUT's gates), a routing switch box, the computer's measured place-and-route
// report and its critical path. Numbers from src/fpga/facts.ts (lutMap, stats, fpgacosts.json); colours from theme tokens.

import '../styles/fpga.css';
import { evalBool, parseBool } from '../lib/boolexpr';
import { groupDigits } from '../sim/numfmt';
import { lutMap, type LutMap } from '../sim/lutmap';
import { h, s } from '../ui/dom';
import type { ScenePanel, Stage, Widget } from '../view/stage';
import { COMPUTER, COSTS, nandsPerLut, pathShares } from '../fpga/facts';

const num = (n: number) => groupDigits(Math.round(n));
const panel = (title: string, sub: string, ...kids: (Node | string)[]) => h('div', { class: 'widget' }, h('div', { class: 'panel fpga-w' }, h('h3', null, title), h('p', { class: 'sub' }, sub), ...kids));
const NAMES = ['a', 'b', 'c', 'd'];

// ---- the two flows --------------------------------------------------------------------------------------------------

export function flowWidget(): Widget {
  const row = (name: string, cls: string, steps: [string, string][]) => h('div', { class: `fpga-flow ${cls}` }, h('div', { class: 'fpga-flow-name' }, name),
    ...steps.flatMap(([t, d], i) => [...(i ? [h('span', { class: 'fpga-arrow', 'aria-hidden': 'true' }, '→')] : []), h('div', { class: 'fpga-stage' }, h('b', null, t), h('span', null, d))]));
  const verilog: [string, string] = ['Verilog', 'the exported design'];
  return {
    el: panel('One netlist, two ends', 'The same exported Verilog goes two ways. Silicon fixes the circuit in masks; an FPGA keeps a fixed chip and loads the circuit as bits.',
      row('Silicon', 'asic', [verilog, ['Yosys', 'standard cells'], ['OpenROAD', 'place, route'], ['GDS', 'masks'], ['fab', 'months']]),
      row('FPGA', 'fpga', [verilog, ['Yosys', 'LUTs, flip-flops'], ['nextpnr', 'place, route'], ['bitstream', 'configuration bits'], ['load', 'at power-on']])),
  };
}

// ---- a LUT, programmed ----------------------------------------------------------------------------------------------

const PRESETS: [string, string][] = [['AND', 'a & b'], ['XOR', 'a ^ b'], ['sum', 'a ^ b ^ c'], ['carry', 'a & b | c & (a ^ b)'], ['majority of 4', 'a & b & c | a & b & d | a & c & d | b & c & d'], ['0', '0']];

/** A LUT4 drawn as its 16 configuration bits feeding a tree of 15 two-way multiplexers, the inputs selecting one bit. */
export function lutProgramWidget(): Widget {
  let cfg = Array.from({ length: 16 }, (_, i) => (i & 1) ^ ((i >> 1) & 1) ^ ((i >> 2) & 1));
  const ins = [1, 0, 1, 0];
  const svg = s('svg', { viewBox: '0 0 440 360', class: 'fpga-lut', role: 'img' });
  const bits = h('div', { class: 'fpga-bits', role: 'group', 'aria-label': 'Configuration bits' });
  const inBox = h('div', { class: 'cx-controls', role: 'group', 'aria-label': 'Inputs' });
  const expr = h('input', { class: 'fpga-expr', type: 'text', value: 'a ^ b ^ c', 'aria-label': 'Function of a, b, c, d', spellcheck: 'false' });
  const err = h('span', { class: 'sub fpga-err', 'aria-live': 'polite' });
  const table = h('table', { class: 'cmp fpga-tt' });
  const hexOut = h('span', { class: 'fpga-hex' });
  const fromExpr = () => {
    const r = parseBool(expr.value, ['d', 'c', 'b', 'a']);
    if ('error' in r) { err.textContent = r.error; return; }
    err.textContent = '';
    cfg = cfg.map((_, i) => evalBool(r.ex, i, 4));
    draw();
  };
  expr.addEventListener('input', fromExpr);
  const pre = h('div', { class: 'cx-controls' }, ...PRESETS.map(([n, e]) => {
    const b = h('button', { class: 'btn sm' }, n);
    b.addEventListener('click', () => { expr.value = e; fromExpr(); });
    return b;
  }));
  const inBtns = NAMES.map((_, k) => {
    const b = h('button', { class: 'btn sm fpga-in', 'aria-pressed': 'false' });
    b.addEventListener('click', () => { ins[k] ^= 1; draw(); });
    inBox.append(b);
    return b;
  });
  function draw() {
    const addr = ins[0] | (ins[1] << 1) | (ins[2] << 2) | (ins[3] << 3), y = cfg[addr];
    inBtns.forEach((b, k) => { b.textContent = `${NAMES[k]} = ${ins[k]}`; b.setAttribute('aria-pressed', String(!!ins[k])); });
    bits.replaceChildren(...cfg.map((v, i) => {
      const b = h('button', { class: `fpga-bit${v ? ' one' : ''}${i === addr ? ' sel' : ''}`, 'aria-label': `bit ${i}: ${v}`, title: `address ${i}` }, String(v));
      b.addEventListener('click', () => { cfg[i] ^= 1; draw(); });
      return b;
    }));
    hexOut.textContent = `cfg = 0x${cfg.reduce((a, v, i) => a | (v << i), 0).toString(16).padStart(4, '0')}`;
    table.replaceChildren(h('thead', null, h('tr', null, ...[0, 1].flatMap(() => [h('th', null, 'd c b a'), h('th', null, 'y')]))),
      h('tbody', null, ...Array.from({ length: 8 }, (_, r) => h('tr', null, ...[r, r + 8].flatMap((i) => {
        const cls = i === addr ? 'sel' : '';
        return [h('td', { class: cls }, [3, 2, 1, 0].map((k) => (i >> k) & 1).join(' ')), h('td', { class: `${cls}${cfg[i] ? ' y1' : ''}` }, String(cfg[i]))];
      })))));
    // the tree: level 0 the bits, each later level one mux per pair, selected by input `lvl`
    const Y = (i: number) => 26 + i * 20, X = [52, 132, 212, 292, 362];
    const kids: SVGElement[] = [s('text', { x: 10, y: 14, class: 'fpga-t' }, 'LUT4')];
    cfg.forEach((v, i) => {
      kids.push(s('rect', { x: 14, y: Y(i) - 8, width: 30, height: 16, rx: 3, class: `fpga-cell${v ? ' one' : ''}${i === addr ? ' sel' : ''}` }));
      kids.push(s('text', { x: 29, y: Y(i) + 4, class: 'fpga-cv' }, String(v)));
    });
    let prev = cfg.map((v, i) => ({ y: Y(i), v, on: i === addr, x: 44 }));
    for (let lvl = 0; lvl < 4; lvl++) {
      const next: typeof prev = [];
      for (let j = 0; j < prev.length / 2; j++) {
        const a = prev[2 * j], b = prev[2 * j + 1], x = X[lvl + 1] - 20;
        for (const p of [a, b]) kids.push(s('path', { d: `M${p.x} ${p.y}H${x}`, class: `fpga-wire${p.on ? ' on' : ''}${p.v ? ' w1' : ''}` }));
        kids.push(s('path', { d: `M${x} ${a.y - 5}L${x + 14} ${a.y + 2}V${b.y - 2}L${x} ${b.y + 5}Z`, class: 'fpga-mux' }));
        const v = (ins[lvl] ? b : a).v;
        next.push({ y: (a.y + b.y) / 2, v, on: a.on || b.on, x: x + 14 });
      }
      kids.push(s('text', { x: X[lvl + 1] - 24, y: 352, class: `fpga-sel${ins[lvl] ? ' w1' : ''}` }, `${NAMES[lvl]}=${ins[lvl]}`));
      prev = next;
    }
    kids.push(s('path', { d: `M${prev[0].x} ${prev[0].y}H430`, class: `fpga-wire on${y ? ' w1' : ''}` }));
    kids.push(s('text', { x: 428, y: prev[0].y - 8, class: `fpga-y${y ? ' w1' : ''}` }, `y = ${y}`));
    svg.replaceChildren(...kids);
    svg.setAttribute('aria-label', `Inputs select address ${addr}; the bit stored there, ${y}, is the output.`);
  }
  draw();
  return {
    el: panel('Program a LUT', 'Type any function of a, b, c, d (& | ^ ! and brackets), pick one, or click the bits. The inputs only choose which stored bit comes out.',
      h('div', { class: 'fpga-two' },
        h('div', null, svg),
        h('div', null,
          h('label', { class: 'cx-field' }, 'y =', expr), err, pre,
          h('div', { class: 'sub' }, 'Inputs'), inBox,
          h('div', { class: 'sub' }, 'Configuration, bit 0 first ', hexOut), bits, table))),
  };
}

// ---- the LUTs of the scene's circuit ----------------------------------------------------------------------------

const hex = (t: bigint, k: number) => `0x${t.toString(16).padStart(Math.max(1, (1 << k) / 4), '0')}`;

/** Lists what lutMap makes of the scene's circuit; a row lights the gates that LUT replaces (their top-level instances). */
export function lutCoverPanel(): ScenePanel {
  return (stage: Stage) => {
    let m: LutMap | null = null;
    const list = h('ol', { class: 'fpga-luts' });
    const head = h('p', { class: 'sub' });
    let lit = -1;
    const nameOf = (mm: LutMap) => {
      const names = new Map<number, string>();
      for (const [p, nets] of Object.entries(mm.design.root.ports)) nets.forEach((n, i) => names.set(n, nets.length > 1 ? `${p}[${i}]` : p));
      return (n: number) => names.get(n) ?? `n${n}`;
    };
    const build = () => {
      const root = stage.scene?.root;
      if (!root) return;
      m = lutMap(root);
      const name = nameOf(m);
      const level = new Map(m.luts.map((l) => [l.out, l.level]));
      head.textContent = `${m.luts.length} LUT4s, ${m.depth} level${m.depth === 1 ? '' : 's'}, for ${num(m.design.leaves.length)} NANDs. A gate may sit in two LUTs: each copy is free.`;
      list.replaceChildren(...m.luts.map((l, i) => {
        const b = h('button', { class: 'fpga-lutrow', 'aria-pressed': 'false' },
          h('b', null, name(l.out)), ` = f(${l.ins.map(name).join(', ')})`, h('span', { class: 'sub' }, ` level ${level.get(l.out)}, ${l.gates.length} gates, table ${hex(l.table, l.ins.length)}`));
        b.addEventListener('click', () => {
          lit = lit === i ? -1 : i;
          list.querySelectorAll('button').forEach((x, j) => x.setAttribute('aria-pressed', String(j === lit)));
          stage.highlight(lit < 0 ? [] : [...new Set(m!.luts[lit].gates.map((g) => m!.design.leaves[g].node.path[0]))], lit >= 0);
        });
        return h('li', null, b);
      }));
    };
    build();
    const el = h('div', { class: 'mem-panel cpu-panel fpga-panel', 'data-dock': 'right' }, h('h4', null, 'LUTs', h('span', { class: 'fold-hint' })), head, list);
    return { el };
  };
}

// ---- a switch box -------------------------------------------------------------------------------------------------

/** Four tracks meet; six pass switches (one configuration bit each) can join any two. A signal on the west track reaches the others the bits connect. */
export function switchBoxWidget(): Widget {
  const SIDES = ['W', 'N', 'E', 'S'] as const;
  const PAIRS: [number, number][] = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
  const on = [false, true, false, false, false, false];
  let src = 1;
  const svg = s('svg', { viewBox: '0 0 260 260', class: 'fpga-sbox', role: 'img' });
  const ctrls = h('div', { class: 'fpga-bits fpga-sw', role: 'group', 'aria-label': 'Switch configuration bits' });
  const srcBtn = h('button', { class: 'btn sm', 'aria-pressed': 'true' });
  srcBtn.addEventListener('click', () => { src ^= 1; draw(); });
  const out = h('p', { class: 'sub', 'aria-live': 'polite' });
  const END: Record<number, [number, number]> = { 0: [10, 130], 1: [130, 10], 2: [250, 130], 3: [130, 250] };
  const MID: Record<number, [number, number]> = { 0: [95, 130], 1: [130, 95], 2: [165, 130], 3: [130, 165] };
  function reach(): Set<number> {
    const seen = new Set([0]);
    for (let grew = true; grew;) { grew = false; PAIRS.forEach(([a, b], i) => { if (on[i] && seen.has(a) !== seen.has(b)) { seen.add(a); seen.add(b); grew = true; } }); }
    return seen;
  }
  function draw() {
    const r = reach();
    const kids: SVGElement[] = [s('rect', { x: 80, y: 80, width: 100, height: 100, rx: 10, class: 'fpga-boxbg' })];
    SIDES.forEach((n, k) => {
      const [x0, y0] = END[k], [x1, y1] = MID[k], live = r.has(k);
      kids.push(s('path', { d: `M${x0} ${y0}L${x1} ${y1}`, class: `fpga-track${live ? ' on' : ''}${live && src ? ' w1' : ''}` }));
      kids.push(s('text', { x: x0 + (k === 0 ? 4 : k === 2 ? -14 : 6), y: y0 + (k === 1 ? 14 : k === 3 ? -6 : -6), class: 'fpga-t' }, n));
    });
    PAIRS.forEach(([a, b], i) => {
      const [x0, y0] = MID[a], [x1, y1] = MID[b];
      kids.push(s('path', { d: `M${x0} ${y0}Q130 130 ${x1} ${y1}`, class: `fpga-pass${on[i] ? ' on' : ''}${on[i] && r.has(a) && src ? ' w1' : ''}` }));
    });
    svg.replaceChildren(...kids);
    const others = [...r].filter((k) => k).map((k) => SIDES[k]);
    svg.setAttribute('aria-label', `West drives ${src}; it reaches ${others.length ? others.join(', ') : 'no other track'}.`);
    srcBtn.textContent = `west drives ${src}`;
    srcBtn.setAttribute('aria-pressed', String(!!src));
    ctrls.replaceChildren(...PAIRS.map(([a, b], i) => {
      const bt = h('button', { class: `fpga-bit${on[i] ? ' one' : ''}`, 'aria-pressed': String(on[i]), title: `${SIDES[a]}–${SIDES[b]}` }, `${SIDES[a]}${SIDES[b]} ${on[i] ? 1 : 0}`);
      bt.addEventListener('click', () => { on[i] = !on[i]; draw(); });
      return bt;
    }));
    const n = on.filter(Boolean).length;
    out.textContent = `${n} of 6 switches closed. The signal reaches ${others.length ? others.join(', ') : 'nothing else'}${others.length > 1 ? ': one driver, several branches, each through a switch' : ''}.`;
  }
  draw();
  return {
    el: panel('A switch box', 'Each crossing of the routing grid has a box like this: six transmission gates, each held on or off by one configuration bit. A wire across the chip passes through dozens of them.',
      h('div', { class: 'fpga-two' }, svg, h('div', null, srcBtn, h('div', { class: 'sub' }, 'Configuration bits'), ctrls, out))),
  };
}

// ---- the computer, placed and routed ------------------------------------------------------------------------------

const bar = (label: string, used: number, avail: number) => h('div', { class: 'fpga-use' },
  h('span', { class: 'fpga-use-l' }, label),
  h('span', { class: 'fpga-use-bar', role: 'img', 'aria-label': `${num(used)} of ${num(avail)}` }, h('i', { style: `--f:${Math.min(1, used / avail)}` })),
  h('span', { class: 'fpga-use-n' }, `${num(used)} / ${num(avail)}`));

export function reportWidget(): Widget {
  const c = COMPUTER, st = c.lut4Stages;
  const top = c.blocks.filter((b) => !b.name.includes('.') || /^(cpu\.rf|cpu\.pc|mem\.ram)$/.test(b.name)).slice(0, 9);
  return {
    el: panel(`The computer on a ${COSTS.board}`, `Measured: the sandbox's FPGA export through ${COSTS.tools.yosys} and ${COSTS.tools.nextpnr} for the ${COSTS.device}.`,
      h('div', { class: 'fpga-two' },
        h('div', null,
          h('div', { class: 'sub' }, 'Device use after place and route'),
          bar('LUT4', c.device.lut4.used, c.device.lut4.available), bar('flip-flops', c.device.dff.used, c.device.dff.available),
          bar('block RAM', c.device.bsram.used, c.device.bsram.available), bar('ALU', c.device.alu.used, c.device.alu.available),
          h('div', { class: 'sub' }, 'LUTs along the way'),
          h('table', { class: 'cmp' }, h('tbody', null,
            h('tr', null, h('td', null, 'our netlist, NANDs'), h('td', { class: 'num' }, num(c.ours.nands))),
            h('tr', null, h('td', null, 'our mapping (lutMap)'), h('td', { class: 'num' }, num(c.ours.lutMapLuts))),
            h('tr', null, h('td', null, 'Yosys'), h('td', { class: 'num' }, num(st.synth))),
            h('tr', null, h('td', null, 'packed: LUTs + carry cells (ALUs)'), h('td', { class: 'num' }, num(st.packed))),
            h('tr', null, h('td', null, 'routed LUTs: Yosys\'s + pass-through'), h('td', { class: 'num' }, `${num(st.routed)} (+${num(st.passthrough)})`))))),
        h('div', null,
          h('div', { class: 'sub' }, 'By the names Yosys kept'),
          h('table', { class: 'cmp' },
            h('thead', null, h('tr', null, h('th', null, 'block'), h('th', null, 'LUTs'), h('th', null, 'FFs'), h('th', null, 'BSRAM'))),
            h('tbody', null, ...top.map((b) => h('tr', null, h('td', null, b.name), h('td', { class: 'num' }, num(b.luts)), h('td', { class: 'num' }, num(b.ffs)), h('td', { class: 'num' }, num(b.bsram)))))),
          h('p', { class: 'sub' }, `${nandsPerLut().toFixed(1)} of our NANDs per synthesized LUT, on average.`)))),
  };
}

export function pathWidget(): Widget {
  const p = pathShares(), c = COMPUTER;
  const seg = (cls: string, v: number, label: string) => h('i', { class: cls, style: `flex:${v}`, title: `${label}: ${v.toFixed(2)} ns` });
  const key = (cls: string, label: string, v: number) => h('span', { class: `fpga-key ${cls}` }, `${label} ${v.toFixed(1)} ns`);
  return {
    el: panel('The slowest path of the design clock', `${p.clock}: ${p.ns.toFixed(1)} ns, so at most ${c.fmax.clk.toFixed(1)} MHz. ${p.lut4} LUT4s and ${p.wideMux} wide multiplexers on it.`,
      h('div', { class: 'fpga-path', role: 'img', 'aria-label': `routing ${p.routingPct} %, logic ${p.logicPct} %, clock skew ${p.skewPct} %` },
        seg('skew', p.skew, 'clock skew'), seg('cq', p.clkToQ, 'clock to q'), seg('logic', p.logic, 'logic'), seg('route', p.routing, 'routing'), seg('setup', p.setup, 'setup')),
      h('div', { class: 'fpga-keys' }, key('route', 'routing', p.routing), key('logic', 'logic', p.logic), key('skew', 'clock skew', p.skew), key('cq', 'clock to q', p.clkToQ), key('setup', 'setup', p.setup)),
      h('table', { class: 'cmp' }, h('tbody', null,
        h('tr', null, h('td', null, 'routing share of the path'), h('td', { class: 'num' }, `${p.routingPct} %`)),
        h('tr', null, h('td', null, 'LUT4 levels on it (tool)'), h('td', { class: 'num' }, String(p.lut4))),
        h('tr', null, h('td', null, 'LUT4 levels, deepest (our mapping)'), h('td', { class: 'num' }, String(c.ours.lutLevels))),
        h('tr', null, h('td', null, 'clock period (our static timing)'), h('td', { class: 'num' }, `${c.ours.period} NAND delays`)),
        ...Object.entries(c.fmax).map(([k, v]) => h('tr', null, h('td', null, `Fmax, ${k}`), h('td', { class: 'num' }, `${v.toFixed(2)} MHz`)))))),
  };
}
