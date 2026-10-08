// The right-hand panel: what is this thing, what does it cost, how does it behave, and
// what does it look like in Verilog.

import { evalOnce, forEachInput, inputBits, simulate } from '../sim/harness';
import { hasFeedback, logicDepth, stats } from '../sim/stats';
import { type Bit, BZ, type Category, type ComponentDef, inPorts, netlistOf, outPorts } from '../sim/types';
import { formatBits, formatNumber, pack, type Radix } from '../sim/values';
import { exportHdl, testableComb, type HdlFlavor } from '../sim/svexport';
import { structuralVerilog } from '../sim/verilog';
import { h, icon } from '../ui/dom';
import { copiesIn, referenceCpus, usedIn, type Parent } from '../lib/usage';

export interface InspectTarget {
  def: ComponentDef;
  /** Live port values, if the component is part of the running scene. */
  portBits?: (port: string) => Bit[];
  /** Instance name when a child is selected. */
  instance?: string;
  canOpen?: boolean;
  onOpen?: () => void;
}

type Tab = 'info' | 'truth' | 'hdl';

const CATEGORY: Record<Category, string> = {
  transistor: 'Transistor level', cell: 'CMOS cell', gate: 'Logic gate', plumbing: 'Wiring',
  arithmetic: 'Arithmetic', routing: 'Selection & routing', sequential: 'Sequential logic',
  memory: 'Memory', cpu: 'Processor', custom: 'User chip',
};

export class Inspector {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabBtns = new Map<Tab, HTMLButtonElement>();
  private tab: Tab = 'info';
  private target: InspectTarget | null = null;
  radix: Radix = 'hex';
  /** "Where it is used" is open (kept across parts and re-renders); a list shown in full, per part. */
  private usedOpen = false;
  private usedAll = new WeakSet<ComponentDef>();
  private usage = new WeakMap<ComponentDef, { parents: Parent[]; cpus: { label: string; n: number }[] }>();

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

  /** Cheap refresh of live values (called on every simulation change). */
  update(): void {
    if (this.tab === 'info' || this.tab === 'truth') this.render();
  }

  private render(): void {
    const t = this.target;
    this.body.replaceChildren();
    if (!t) return;
    if (this.tab === 'info') this.renderInfo(t);
    else if (this.tab === 'truth') this.renderTruth(t);
    else this.renderHdl(t);
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
    else if (d.prim === 'res') cells.push(['1', 'resistor']);
    else if (d.prim === 'cap') cells.push(['1', 'capacitor']);
    else if (d.prim !== 'alias' && d.prim !== 'vdd' && d.prim !== 'gnd') {
      cells.push([st.transistors.toLocaleString(), 'transistors']);
      if (st.resistors) cells.push([st.resistors.toLocaleString(), `resistor${st.resistors > 1 ? 's' : ''}`]);
      if (st.capacitors) cells.push([st.capacitors.toLocaleString(), `capacitor${st.capacitors > 1 ? 's' : ''}`]);
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
    // Library parts only: a user chip has the sandbox's own "used by" (editor/chips.ts).
    if (d.prim !== 'alias' && d.prim !== 'vdd' && d.prim !== 'gnd' && d.category !== 'custom') b.append(this.usedSection(d));
  }

  /** The components that place this part, and its copies in each of the chapters' CPUs (lib/usage.ts, on first open). */
  private usedSection(d: ComponentDef): HTMLElement {
    const det = h('details', { class: 'insp-used' }, h('summary', null, 'Where it is used'));
    const fill = () => {
      let u = this.usage.get(d);
      if (!u) this.usage.set(d, (u = { parents: usedIn(d), cpus: referenceCpus().map((c) => ({ label: c.label, n: copiesIn(c.def, d) })) }));
      // Sizes of one generator share a name (twelve "3:2 compressor row"s): one row each, with the range.
      const groups = new Map<string, Parent[]>();
      for (const p of u.parents) groups.get(p.def.name)?.push(p) ?? groups.set(p.def.name, [p]);
      const list = [...groups.values()];
      const SHOW = 8;
      const all = this.usedAll.has(d) || list.length <= SHOW + 2;
      const rows = (all ? list : list.slice(0, SHOW)).map((g) => {
        const p = g[0], lo = g[g.length - 1].count;
        return h('tr', null,
          h('td', { title: g.map((x) => x.def.id).join(', ') }, g.length === 1 && p.openable ? h('a', { href: `#/workbench/${p.def.id}` }, p.def.name) : p.def.name,
            g.length > 1 ? h('small', null, ` ${g.length} sizes`) : null),
          h('td', { class: 'val' }, `× ${lo === p.count ? p.count : `${lo}–${p.count}`}`));
      });
      det.append(h('div', { class: 'insp-used-h' }, u.parents.length ? `Placed directly in ${u.parents.length} component${u.parents.length > 1 ? 's' : ''}` : 'Not placed in any library component'));
      if (rows.length) det.append(h('table', { class: 'ports used' }, h('tbody', null, rows)));
      if (!all) det.append(h('button', { class: 'btn ghost sm', onclick: () => { this.usedAll.add(d); this.render(); } }, `Show all ${list.length}`));
      det.append(h('div', { class: 'insp-used-h' }, 'Copies in the chapters’ CPUs, flattened'),
        h('table', { class: 'ports used' }, h('tbody', null, u.cpus.map((c) => h('tr', null, h('td', null, c.label), h('td', { class: 'val' }, c.n ? c.n.toLocaleString() : '—'))))));
    };
    if (this.usedOpen) {
      det.open = true;
      fill();
    }
    det.addEventListener('toggle', () => {
      this.usedOpen = det.open;
      if (det.open && det.childElementCount === 1) fill();
    });
    return det;
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
    if (d.prim === 'res' || d.prim === 'cap') {
      this.body.append(h('p', { class: 'empty' }, d.prim === 'res'
        ? 'Always conducts, more weakly than any transistor: a node it alone reaches follows it; any transistor path overrides it.'
        : 'Keeps the last value of its node while nothing drives it (stored charge).'));
      return;
    }
    if (netlistOf(d) && hasFeedbackSafe(d)) {
      this.body.append(h('p', { class: 'empty' }, 'This component has feedback, so its outputs depend on its history, not only on its inputs. A truth table cannot describe it. Open the Timing panel to see it over time.'));
      return;
    }
    if (!outPorts(d).length && d.ports.some((p) => p.dir === 'inout')) {
      this.body.append(h('p', { class: 'empty' }, 'Its signal ports are bidirectional (a switch between two nodes): there is no input → output function to tabulate. Drive one side and watch the other.'));
      return;
    }
    if (n > 8) {
      this.body.append(h('p', { class: 'empty' }, `${n} input bits → ${(2 ** n).toLocaleString()} rows. Too many to list. That is why we describe big circuits with arithmetic, not tables.`));
      return;
    }
    const table = truthTable(d);
    const ins = inPorts(d), outs = outPorts(d);
    const cur = t.portBits ? ins.map((p) => pack(t.portBits!(p.name))) : null;
    const fmt = (v: number, w: number) => (v === -2 ? 'Z' : v < 0 ? 'X' : w === 1 ? String(v) : formatNumber(v, w, w <= 4 ? 'bin' : this.radix));
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

  /** Download the whole hierarchy as one file, optionally with a self-checking testbench. */
  private downloadRow(d: ComponentDef): HTMLElement {
    const tbOk = testableComb(d);
    const tb = h('input', { type: 'checkbox', checked: tbOk, disabled: !tbOk }) as HTMLInputElement;
    const note = h('div', { class: 'dl-note' });
    const go = (flavor: HdlFlavor) => {
      try {
        const f = exportHdl(d, flavor, tb.checked);
        download(f.filename, f.text);
        note.textContent = `${f.filename}: ${f.modules} module${f.modules > 1 ? 's' : ''}${f.vectors ? `, testbench with ${f.vectors} vectors` : ''}.`;
      } catch (e) {
        note.textContent = `Cannot export: ${(e as Error).message}`;
      }
    };
    return h('div', { class: 'dl-hdl' },
      h('div', { class: 'code-head' }, 'Download the whole hierarchy'),
      h('div', { class: 'dl-btns' },
        h('button', { class: 'btn sm', title: 'Every module exactly as drawn: NAND gates, flip-flops as NAND loops (.sv)', onclick: () => go('structure') }, icon('code', 14), 'Exact structure'),
        h('button', { class: 'btn sm', title: 'Synthesizable Verilog-2005 for Yosys / Verilator / FPGA tools: flip-flops as clocked processes (.v)', onclick: () => go('synth') }, icon('chip', 14), 'Synthesizable'),
        h('label', { class: 'dl-tb', title: tbOk ? 'Append a self-checking testbench with vectors from this site’s simulation' : 'Testbenches are generated for loop-free (combinational) logic only' }, tb, 'testbench')),
      note);
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
    if (gen) this.body.append(this.downloadRow(d));
    for (const [title, code] of blocks) {
      const copy = h('button', { class: 'btn ghost sm', onclick: () => navigator.clipboard?.writeText(code) }, 'Copy');
      this.body.append(h('div', { class: 'code-head' }, title, copy), h('pre', { class: 'code', html: highlight(code) }));
    }
  }
}

function download(name: string, text: string): void {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function logicDepthSafe(d: ComponentDef): number | null {
  try {
    return logicDepth(d);
  } catch {
    return null;
  }
}

function hasFeedbackSafe(d: ComponentDef): boolean {
  try {
    return hasFeedback(d);
  } catch {
    return true;
  }
}

const ttCache = new WeakMap<ComponentDef, { ins: number[]; outs: number[] }[]>();
export function truthTable(d: ComponentDef): { ins: number[]; outs: number[] }[] {
  const hit = ttCache.get(d);
  if (hit) return hit;
  const sim = simulate(d);
  const rows: { ins: number[]; outs: number[] }[] = [];
  // -1: unknown (X somewhere); -2: floating (every bit Z, a tri-state output let go)
  const floating = (p: string) => sim.getBits(sim.design.root.ports[p]).every((b) => b === BZ);
  forEachInput(d, (ins) => {
    const outs = evalOnce(sim, ins);
    rows.push({ ins, outs: outs.map((v, i) => (v < 0 && floating(outPorts(d)[i].name) ? -2 : v)) });
  });
  ttCache.set(d, rows);
  return rows;
}

const KW = /\b(module|endmodule|input|output|inout|logic|wire|assign|always_ff|always_comb|always|posedge|negedge|if|else|case|endcase|begin|end|for|genvar|parameter|int|supply0|supply1|nmos|pmos|rtran|tran|trireg|pullup|pulldown|default)\b/g;
function highlight(code: string): string {
  const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split('\n').map((line) => {
    const i = line.indexOf('//');
    const body = i >= 0 ? line.slice(0, i) : line;
    const cm = i >= 0 ? `<span class="cm">${line.slice(i)}</span>` : '';
    return body.replace(KW, '<span class="kw">$1</span>').replace(/\b(\d+'[bdh][0-9a-fA-F_]+|\d+)\b/g, '<span class="num">$1</span>') + cm;
  }).join('\n');
}
