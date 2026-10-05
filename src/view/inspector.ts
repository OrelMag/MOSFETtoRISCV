// The right-hand panel: what is this thing, what does it cost, how does it behave, and
// what does it look like in Verilog.

import { evalOnce, forEachInput, inputBits, simulate } from '../sim/harness';
import { logicDepth, stats } from '../sim/stats';
import { type Bit, type ComponentDef, inPorts, netlistOf, outPorts } from '../sim/types';
import { formatBits, formatNumber, pack, type Radix } from '../sim/values';
import { structuralVerilog } from '../sim/verilog';
import { h, icon, s } from '../ui/dom';

export interface InspectTarget {
  def: ComponentDef;
  /** Live port values, if the component is part of the running scene. */
  portBits?: (port: string) => Bit[];
  /** Instance name when a child is selected. */
  instance?: string;
  canOpen?: boolean;
  onOpen?: () => void;
}

export interface WaveSample {
  t: number;
  values: number[];
}
export interface WaveData {
  names: string[];
  widths: number[];
  samples: WaveSample[];
}

type Tab = 'info' | 'truth' | 'hdl' | 'waves';

const CATEGORY: Record<string, string> = {
  transistor: 'Transistor level', cell: 'CMOS cell', gate: 'Logic gate', plumbing: 'Wiring',
  arithmetic: 'Arithmetic', routing: 'Selection & routing', sequential: 'Sequential logic',
  memory: 'Memory', cpu: 'Processor',
};

export class Inspector {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabBtns = new Map<Tab, HTMLButtonElement>();
  private tab: Tab = 'info';
  private target: InspectTarget | null = null;
  private waves: WaveData | null = null;
  radix: Radix = 'hex';

  constructor() {
    this.body = h('div', { class: 'tab-body' });
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const add = (t: Tab, label: string, ic: string) => {
      const b = h('button', { role: 'tab', onclick: () => this.setTab(t) }, icon(ic, 14), label);
      this.tabBtns.set(t, b);
      tabs.append(b);
    };
    add('info', 'Info', 'info');
    add('truth', 'Table', 'table');
    add('hdl', 'Verilog', 'code');
    add('waves', 'Waves', 'wave');
    this.el = h('aside', { class: 'inspector' }, tabs, this.body);
    this.setTab('info');
  }

  setTab(t: Tab): void {
    this.tab = t;
    for (const [k, b] of this.tabBtns) b.classList.toggle('on', k === t);
    this.render();
  }

  show(target: InspectTarget): void {
    this.target = target;
    this.render();
  }

  setWaves(w: WaveData | null): void {
    this.waves = w;
    if (this.tab === 'waves') this.render();
  }

  /** Cheap refresh of live values (called on every simulation change). */
  update(): void {
    if (this.tab === 'info' || this.tab === 'truth' || this.tab === 'waves') this.render();
  }

  private render(): void {
    const t = this.target;
    this.body.replaceChildren();
    if (!t) return;
    if (this.tab === 'info') this.renderInfo(t);
    else if (this.tab === 'truth') this.renderTruth(t);
    else if (this.tab === 'hdl') this.renderHdl(t);
    else this.renderWaves();
  }

  private renderInfo(t: InspectTarget): void {
    const d = t.def;
    const st = stats(d);
    const depth = d.prim === 'alias' ? null : logicDepthSafe(d);
    const b = this.body;
    b.append(
      h('div', { class: 'insp-kicker' }, `${CATEGORY[d.category] ?? d.category}${t.instance ? ` · ${t.instance}` : ''}`),
      h('div', { class: 'insp-title' }, d.name),
    );
    if (d.summary) b.append(h('p', { class: 'insp-summary' }, d.summary));
    const actions = h('div', { class: 'insp-actions' });
    if (t.canOpen && t.onOpen) actions.append(h('button', { class: 'btn primary sm', onclick: t.onOpen }, icon('zoomin', 14), 'Look inside'));
    if (d.prim !== 'alias') actions.append(h('a', { class: 'btn sm', href: `#/workbench/${d.id}` }, icon('bench', 14), 'Workbench'));
    if (actions.childElementCount) b.append(actions);

    const cells: [string, string][] = [];
    if (d.prim === 'nmos' || d.prim === 'pmos') cells.push(['1', 'transistor']);
    else if (d.prim !== 'alias' && d.prim !== 'vdd' && d.prim !== 'gnd') {
      cells.push([st.transistors.toLocaleString(), 'transistors']);
      cells.push([st.nands.toLocaleString(), 'NAND gates']);
      if (depth !== null && depth > 0) cells.push([String(depth), 'gate delays (worst path)']);
      else if (st.nands > 0 && depth === null) cells.push(['∞', 'has feedback: it remembers']);
      if (st.levels > 0) cells.push([String(st.levels), `level${st.levels > 1 ? 's' : ''} of boxes inside`]);
    }
    if (cells.length) b.append(h('div', { class: 'stats' }, cells.map(([v, l]) => h('div', { class: 'stat' }, h('b', null, v), h('span', null, l)))));

    const rows = d.ports.map((p) => {
      const bits = t.portBits?.(p.name);
      return h('tr', null,
        h('td', null, p.name + (p.width > 1 ? `[${p.width - 1}:0]` : '')),
        h('td', { class: 'dir' }, p.dir === 'in' ? 'in' : p.dir === 'out' ? 'out' : 'inout'),
        h('td', { class: 'val' }, bits ? formatBits(bits, p.width > 1 ? this.radix : 'bin') : ''));
    });
    if (rows.length) b.append(h('table', { class: 'ports' }, h('tbody', null, rows)));
    if (d.notes) b.append(h('div', { class: 'insp-notes', html: d.notes }));
  }

  private renderTruth(t: InspectTarget): void {
    const d = t.def;
    const n = inputBits(d);
    if (d.prim === 'alias' || d.prim === 'vdd' || d.prim === 'gnd') {
      this.body.append(h('p', { class: 'empty' }, 'Pure wiring: nothing to tabulate.'));
      return;
    }
    if (d.prim === 'nmos' || d.prim === 'pmos') {
      this.body.append(h('p', { class: 'empty' }, `A switch: ${d.prim === 'nmos' ? 'gate = 1 → conducts, gate = 0 → open' : 'gate = 0 → conducts, gate = 1 → open'}.`));
      return;
    }
    if (logicDepthSafe(d) === null && netlistOf(d)) {
      this.body.append(h('p', { class: 'empty' }, 'This component has feedback, so its outputs depend on its history, not only on its inputs. A truth table cannot describe it. See the Waves tab.'));
      return;
    }
    if (n > 8) {
      this.body.append(h('p', { class: 'empty' }, `${n} input bits → ${(2 ** n).toLocaleString()} rows. Too many to list. That is why we describe big circuits with arithmetic, not tables.`));
      return;
    }
    const table = truthTable(d);
    const ins = inPorts(d), outs = outPorts(d);
    const cur = t.portBits ? ins.map((p) => pack(t.portBits!(p.name))) : null;
    const fmt = (v: number, w: number) => (w === 1 ? String(v) : v < 0 ? 'x' : formatNumber(v, w, w <= 4 ? 'bin' : this.radix));
    const head = h('tr', null, ins.map((p) => h('th', null, p.name)), outs.map((p) => h('th', { class: 'out' }, p.name)));
    const body = table.map(({ ins: iv, outs: ov }) => {
      const isCur = cur !== null && cur.every((v, i) => v === iv[i]);
      return h('tr', { class: isCur ? 'cur' : '' },
        iv.map((v, i) => h('td', { class: v === 1 && ins[i].width === 1 ? 'one' : '' }, fmt(v, ins[i].width))),
        ov.map((v, i) => h('td', { class: `out${v === 1 && outs[i].width === 1 ? ' one' : ''}` }, fmt(v, outs[i].width))));
    });
    this.body.append(
      h('p', { class: 'insp-summary' }, `Every combination of inputs, computed by simulating the circuit's own structure.${cur ? ' The highlighted row is the current state.' : ''}`),
      h('table', { class: 'truth' }, h('thead', null, head), h('tbody', null, body)),
    );
  }

  private renderHdl(t: InspectTarget): void {
    const d = t.def;
    const gen = structuralVerilog(d);
    const blocks: [string, string][] = [];
    if (d.hdl?.verilog) blocks.push(['SystemVerilog', d.hdl.verilog]);
    if (gen) blocks.push(['Structural (generated from this schematic)', gen]);
    if (!blocks.length) {
      this.body.append(h('p', { class: 'empty' }, 'No HDL for this element.'));
      return;
    }
    for (const [title, code] of blocks) {
      const copy = h('button', { class: 'btn ghost sm', onclick: () => navigator.clipboard?.writeText(code) }, 'Copy');
      this.body.append(h('div', { class: 'code-head' }, title, copy), h('pre', { class: 'code', html: highlight(code) }));
    }
  }

  private renderWaves(): void {
    const w = this.waves;
    if (!w || w.samples.length < 1) {
      this.body.append(h('p', { class: 'empty' }, 'Change an input to start recording.'));
      return;
    }
    const W = 300, laneH = 26, left = 52;
    const t0 = w.samples[0].t, t1 = Math.max(t0 + 1, w.samples[w.samples.length - 1].t + 2);
    const x = (t: number) => left + ((t - t0) / (t1 - t0)) * (W - left - 4);
    const svg = s('svg', { viewBox: `0 0 ${W} ${w.names.length * laneH + 18}` });
    w.names.forEach((name, li) => {
      const y0 = li * laneH + 6, y1 = y0 + 16;
      svg.append(s('text', { x: 0, y: y0 + 12, class: 'lane-name' }, name));
      svg.append(s('line', { x1: left, x2: W, y1: y1 + 4, y2: y1 + 4, class: 'grid-line' }));
      const width = w.widths[li];
      if (width === 1) {
        let d = '';
        w.samples.forEach((smp, i) => {
          const v = smp.values[li];
          const yy = v === 1 ? y0 : v === 0 ? y1 : (y0 + y1) / 2;
          d += i === 0 ? `M${x(smp.t)},${yy}` : ` H${x(smp.t)} V${yy}`;
        });
        d += ` H${x(t1)}`;
        svg.append(s('path', { d, class: 'trace' }));
      } else {
        w.samples.forEach((smp, i) => {
          const xa = x(smp.t), xb = i + 1 < w.samples.length ? x(w.samples[i + 1].t) : x(t1);
          if (i > 0 && w.samples[i - 1].values[li] === smp.values[li]) return;
          let j = i + 1;
          while (j < w.samples.length && w.samples[j].values[li] === smp.values[li]) j++;
          const xe = j < w.samples.length ? x(w.samples[j].t) : x(t1);
          svg.append(s('path', { d: `M${xa + 2},${y0} H${xe - 2} L${xe},${(y0 + y1) / 2} L${xe - 2},${y1} H${xa + 2} L${xa},${(y0 + y1) / 2} Z`, class: 'trace bus' }));
          if (xe - xa > 22) svg.append(s('text', { x: (xa + xe) / 2, y: y0 + 11.5, 'text-anchor': 'middle', class: 'bus-val' }, smp.values[li] < 0 ? 'x' : formatNumber(smp.values[li], width, this.radix)));
          void xb;
        });
      }
    });
    const tl = w.names.length * laneH + 14;
    svg.append(s('text', { x: left, y: tl, class: 'bus-val' }, `t = ${t0}`));
    svg.append(s('text', { x: W - 2, y: tl, class: 'bus-val', 'text-anchor': 'end' }, `${t1} gate delays`));
    this.body.append(h('p', { class: 'insp-summary' }, 'The scene\'s pins over time, in gate delays. Rising edges of the clock are when flip-flops capture.'), h('div', { class: 'waves' }, svg));
  }
}

function logicDepthSafe(d: ComponentDef): number | null {
  try {
    return logicDepth(d);
  } catch {
    return null;
  }
}

const ttCache = new WeakMap<ComponentDef, { ins: number[]; outs: number[] }[]>();
export function truthTable(d: ComponentDef): { ins: number[]; outs: number[] }[] {
  const hit = ttCache.get(d);
  if (hit) return hit;
  const sim = simulate(d);
  const rows: { ins: number[]; outs: number[] }[] = [];
  forEachInput(d, (ins) => rows.push({ ins, outs: evalOnce(sim, ins) }));
  ttCache.set(d, rows);
  return rows;
}

const KW = /\b(module|endmodule|input|output|inout|logic|wire|assign|always_ff|always_comb|always|posedge|negedge|if|else|case|endcase|begin|end|for|genvar|parameter|int|supply0|supply1|nmos|pmos|default)\b/g;
function highlight(code: string): string {
  const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split('\n').map((line) => {
    const i = line.indexOf('//');
    const body = i >= 0 ? line.slice(0, i) : line;
    const cm = i >= 0 ? `<span class="cm">${line.slice(i)}</span>` : '';
    return body.replace(KW, '<span class="kw">$1</span>').replace(/\b(\d+'[bdh][0-9a-fA-F_]+|\d+)\b/g, '<span class="num">$1</span>') + cm;
  }).join('\n');
}
