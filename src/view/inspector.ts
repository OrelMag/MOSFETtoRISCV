// The right-hand panel: what is this thing, what does it cost, how does it behave, and
// what does it look like in Verilog.

import { groupDigits } from '../sim/numfmt';
import { evalOnce, forEachInput, inputBits, simulate } from '../sim/harness';
import { DELAY_NOTE, type DelayModel, fmtDelay } from '../sim/delay';
import { settings } from '../ui/settings';
import { hasFeedback, logicDepth, romSize, stats } from '../sim/stats';
import { type Bit, BZ, type Category, type ComponentDef, inPorts, netlistOf, outPorts } from '../sim/types';
import { formatBits, formatNumber, pack, type Radix } from '../sim/values';
import { exportHdl, testableComb, type HdlFlavor } from '../sim/svexport';
import { structuralVerilog, verilogLines, type HdlLines } from '../sim/verilog';
import { structuralVhdl, vhdlHierarchy, vhdlLines } from '../sim/vhdl';
import { firstLineOf, instanceAt } from './hdllines';
import { h, icon } from '../ui/dom';
import type { Parent } from '../lib/usage';
import { powerBody, type LivePower } from './powerpanel';
import { hasUsage, TRUTH_MAX_BITS } from './truthrule';
import { techTable } from './techtable';

export interface InspectTarget {
  def: ComponentDef;
  /** Live port values, if the component is part of the running scene. */
  portBits?: (port: string) => Bit[];
  /** Instance name when a child is selected. */
  instance?: string;
  canOpen?: boolean;
  onOpen?: () => void;
  /** The running scene's switching activity for this part (null: not on the scene's own gate-level simulation). */
  power?: () => LivePower | null;
  /** Leave "Where it is used" out (a campaign level's parts). */
  noUsage?: boolean;
  /** The level drawn on the stage (the target itself, or the level a selected part sits on): the HDL tab shows its source
   *  linked to the drawing, a line lighting its instance through `light` (empty: back to the scene's own highlight). */
  level?: { def: ComponentDef; light: (names: string[]) => void };
}

type Tab = 'info' | 'truth' | 'hdl';

export const CATEGORY_LABEL: Record<Category, string> = {
  transistor: 'Transistor level', cell: 'CMOS cell', gate: 'Logic gate', plumbing: 'Wiring',
  arithmetic: 'Arithmetic', routing: 'Selection & routing', sequential: 'Sequential logic',
  memory: 'Memory', cpu: 'Processor', ttl: '74xx chip', custom: 'User chip',
};

/** The learner's own fold or unfold of the inspector, kept across visits (null: never chosen; the stage then folds it
 *  by itself beside a circuit too large to read, Stage.autoInspector). */
const FOLD_KEY = 'mosfet.inspector';
export function inspectorChoice(): boolean | null {
  try { const v = localStorage.getItem(FOLD_KEY); return v === 'folded' ? true : v === 'open' ? false : null; } catch { return null; }
}

/** A section just opened sits at the dock's bottom: scroll it into view (the click would look like nothing happened). */
function peek(det: HTMLElement): void {
  requestAnimationFrame(() => det.scrollIntoView({ block: 'nearest', behavior: 'auto' }));
}

export class Inspector {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabBtns = new Map<Tab, HTMLButtonElement>();
  private tab: Tab = 'info';
  private target: InspectTarget | null = null;
  radix: Radix = 'hex';
  /** "Where it is used" is open (kept across parts and re-renders); a list shown in full, per part. */
  private usedOpen = false;
  /** "Power" is open (kept across parts and re-renders, like "Where it is used"). */
  private powerOpen = false;
  /** "In relays and tubes" is open (kept like the others). */
  private techOpen = false;
  private usedAll = new WeakSet<ComponentDef>();
  /** Folded to a rail (a large circuit gets its width); `auto`: by the stage, not the learner. */
  folded = false;
  auto = false;
  private rail: HTMLButtonElement;
  private usage = new WeakMap<ComponentDef, { parents: Parent[]; cpus: { label: string; n: number }[] }>();
  /** The HDL tab's language for the linked source, and the instance a line click lit (with the function that clears it). */
  private hdlLang: 'verilog' | 'vhdl' = 'verilog';
  private hdlLit: { inst: string; clear: () => void } | null = null;

  constructor() {
    this.body = h('div', { class: 'tab-body' });
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const add = (t: Tab, label: string, ic: string) => {
      const b = h('button', { role: 'tab', onclick: () => this.setTab(t) }, icon(ic, 14), label);
      this.tabBtns.set(t, b);
      tabs.append(b);
    };
    add('info', 'Info', 'info');
    add('truth', 'Truth table', 'table');
    add('hdl', 'HDL', 'code');
    const fold = h('button', { class: 'insp-fold', title: 'Fold the inspector: the circuit gets its width', 'aria-label': 'Fold the inspector', onclick: () => this.userFold(true) }, icon('sidebar', 14)) as HTMLButtonElement;
    this.rail = h('button', { class: 'insp-rail', title: 'Show the inspector', 'aria-label': 'Show the inspector', onclick: () => this.userFold(false) }, icon('sidebar', 14), h('span', null, 'Inspector')) as HTMLButtonElement;
    this.el = h('aside', { class: 'inspector' }, h('div', { class: 'insp-head' }, tabs, fold), this.body, this.rail);
    this.setTab('info');
  }

  /** Fold to a rail or open, as the stage decided or as the learner chose earlier (`auto`: by the stage): no focus, nothing saved. */
  setFolded(f: boolean, auto: boolean): void {
    this.folded = f;
    this.auto = f && auto;
    this.el.classList.toggle('folded', f);
    this.rail.tabIndex = f ? 0 : -1;
  }

  /** The learner's click: remembered, never overridden by the stage, focus to the control that now shows. */
  private userFold(f: boolean): void {
    this.setFolded(f, false);
    try { localStorage.setItem(FOLD_KEY, f ? 'folded' : 'open'); } catch { /* private window */ }
    (f ? this.rail : this.el.querySelector<HTMLElement>('.insp-fold'))?.focus();
  }

  /** Open at this section, for the right-click menu: unfolded (the learner's own fold stands next time), scrolled to. "Where it is used" stays open across parts, as when opened by hand. */
  openAt(section: 'info' | 'truth' | 'used' | 'power'): void {
    if (this.folded) this.setFolded(false, false);
    if (section === 'used') this.usedOpen = true;
    if (section === 'power') this.powerOpen = true;
    this.setTab(section === 'truth' ? 'truth' : 'info');
    if (section === 'used' || section === 'power') {
      const title = section === 'used' ? 'Where it is used' : 'Power (estimate)';
      const det = [...this.body.querySelectorAll<HTMLElement>('details.insp-used')].find((d) => d.querySelector('summary')?.textContent === title);
      if (det) peek(det);
    }
  }

  setTab(t: Tab): void {
    this.unlight();
    this.tab = t;
    for (const [k, b] of this.tabBtns) b.classList.toggle('on', k === t);
    this.render();
  }

  show(target: InspectTarget): void {
    this.unlight();
    this.target = target;
    this.render();
  }

  /** Forget the target (its closures hold a simulation), without redrawing. */
  clear(): void {
    this.unlight();
    this.target = null;
  }

  /** Forget the target and empty the panel (nothing on the stage to describe: an unknown workbench id). */
  reset(): void {
    this.target = null;
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
      h('div', { class: 'insp-kicker' }, `${CATEGORY_LABEL[d.category] ?? d.category}${t.instance ? ` · ${t.instance}` : ''}`),
      h('div', { class: 'insp-title' }, d.name),
    );
    if (d.summary) b.append(h('p', { class: 'insp-summary' }, d.summary));
    const actions = h('div', { class: 'insp-actions' });
    if (t.canOpen && t.onOpen) actions.append(h('button', { class: 'btn primary sm', onclick: t.onOpen }, icon('zoomin', 14), 'Look inside'));
    // not to the page it is on: the workbench showing this very component
    const here = location.hash.split('/').slice(0, 3).join('/') === `#/workbench/${d.id}`;
    if (d.prim !== 'alias' && !here) actions.append(h('a', { class: 'btn sm', href: `#/workbench/${d.id}`, title: `${d.name} on the workbench: its own page, with truth table, timing and statistics` }, icon('bench', 14), 'Open on workbench'));
    if (actions.childElementCount) b.append(actions);

    const cells: [string, string, string?][] = [];
    if (d.prim === 'nmos' || d.prim === 'pmos') cells.push(['1', 'transistor']);
    else if (d.prim === 'res') cells.push(['1', 'resistor']);
    else if (d.prim === 'dep') cells.push(['1', 'depletion transistor']);
    else if (d.prim === 'cap') cells.push(['1', 'capacitor']);
    else if (d.prim === 'relay') cells.push(['1', 'relay'], [String((d.ports.length - 2) / 3), 'changeover contacts']);
    else if (d.prim === 'triode') cells.push(['1', 'triode section (half a 6SN7)']);
    else if (d.prim === 'diode') cells.push(['1', 'diode section (half a 6AL5)']);
    else if (d.prim === 'core') cells.push(['1', 'ferrite core', 'A bit as a ring of ferrite: no transistor, no gate']);
    else if (d.prim !== 'alias' && d.prim !== 'vdd' && d.prim !== 'gnd') {
      // a relay or tube circuit counts relays or tube sections, not the transistors it has none of
      const old = st.relays + st.triodes + st.diodes;
      if (st.relays) cells.push([groupDigits(st.relays), `relay${st.relays > 1 ? 's' : ''}`]);
      if (st.triodes) cells.push([groupDigits(st.triodes), `triode section${st.triodes > 1 ? 's' : ''}`]);
      if (st.diodes) cells.push([groupDigits(st.diodes), `diode section${st.diodes > 1 ? 's' : ''}`]);
      // core memory: a bit a ring, priced apart from the gates around it
      if (st.cores) cells.push([groupDigits(st.cores), `ferrite core${st.cores > 1 ? 's' : ''}`, 'A bit each as a ring of ferrite: no transistor, no gate']);
      // ROM chips (a 28C16) are counted as the mux trees they simulate as: shown apart, so the logic's count stands alone
      const rom = st.rom;
      const romTip = rom ? `${romSize(rom)} of ROM, simulated as mux trees of ${groupDigits(rom.nands)} NANDs (${groupDigits(rom.transistors)} transistors) that are not counted here: on silicon a ROM is a transistor per bit and two decoders` : undefined;
      if (!old || st.transistors) cells.push([groupDigits(st.transistors - (rom?.transistors ?? 0)), rom ? 'transistors of logic' : 'transistors', romTip]);
      if (st.resistors) cells.push([groupDigits(st.resistors), `resistor${st.resistors > 1 ? 's' : ''}`]);
      if (st.capacitors) cells.push([groupDigits(st.capacitors), `capacitor${st.capacitors > 1 ? 's' : ''}`]);
      if (!old || st.nands) cells.push([groupDigits(st.nands - (rom?.nands ?? 0)), rom ? 'NAND gates of logic' : 'NAND gates', romTip]);
      if (rom) cells.push([`+ ${romSize(rom)}`, `of ROM (${rom.chips} chip${rom.chips > 1 ? 's' : ''}: mux trees of ${groupDigits(rom.nands)} NANDs in the simulation)`, romTip]);
      if (depth !== null && depth > 0) {
        const unit: [string, string] = [String(depth), 'NAND delays (worst path)'];
        // units under load are taught in Faster adders ("When fan-out costs"): shown once that chapter is opened, or with Load chosen as the default
        const loadKnown = settings.loadDelay || settings.visited('fastadd').length > 0;
        const loaded = loadKnown ? logicDepthSafe(d, 'load') : null;
        const load: [string, string, string] | null = loaded === null ? null : [fmtDelay(loaded, 'load'), 'units under load', DELAY_NOTE];
        cells.push(...(settings.loadDelay && load ? [load, unit] : load ? [unit, load] : [unit]));
      }
      else if (st.nands > 0 && depth === null) cells.push(['∞', 'has feedback: it remembers']);
      if (st.levels > 0) cells.push([String(st.levels), `level${st.levels > 1 ? 's' : ''} of boxes inside`]);
    }
    if (cells.length) b.append(h('div', { class: 'stats' }, cells.map(([v, l, tip]) => h('div', { class: 'stat', title: tip }, h('b', null, v), h('span', null, l)))));

    const rows = d.ports.map((p) => {
      const bits = t.portBits?.(p.name);
      return h('tr', null,
        h('td', null, p.name + (p.width > 1 ? `[${p.width - 1}:0]` : '')),
        h('td', { class: 'dir' }, p.dir === 'in' ? 'in' : p.dir === 'out' ? 'out' : 'inout'),
        h('td', { class: 'val' }, bits ? formatBits(bits, p.width > 1 ? this.radix : 'bin') : ''));
    });
    if (rows.length) b.append(h('table', { class: 'ports' }, h('tbody', null, rows)));
    if (d.notes) b.append(h('div', { class: 'insp-notes', html: d.notes }));
    if (!d.prim || (d.prim === 'nand' && t.power)) b.append(this.powerSection(t));
    if ((!d.prim || d.prim === 'nand') && d.category !== 'plumbing') b.append(this.techSection(d));
    // Library parts only: a user chip has the sandbox's own "used by" (editor/chips.ts). On a level it would say what the target is made of.
    if (hasUsage(d) && !t.noUsage) b.append(this.usedSection(d));
  }

  /** What the part spends switching: live on the running scene, else on random inputs (measured on first open). */
  private powerSection(t: InspectTarget): HTMLElement {
    const det = h('details', { class: 'insp-used' }, h('summary', null, 'Power (estimate)'));
    const fill = () => det.append(powerBody(t.def, t.power?.() ?? null, () => this.render()));
    if (this.powerOpen) {
      det.open = true;
      fill();
    }
    det.addEventListener('toggle', () => {
      this.powerOpen = det.open;
      if (det.open && det.childElementCount === 1) fill();
      if (det.open) peek(det);
    });
    return det;
  }

  /** The part priced in CMOS, relays and tubes (lib/tech.ts; measured on first open: its period needs a flattening). */
  private techSection(d: ComponentDef): HTMLElement {
    const det = h('details', { class: 'insp-used' }, h('summary', null, 'In relays and tubes'));
    const fill = () => det.append(techTable(d, { narrow: true }));
    if (this.techOpen) {
      det.open = true;
      fill();
    }
    det.addEventListener('toggle', () => {
      this.techOpen = det.open;
      if (det.open && det.childElementCount === 1) fill();
      if (det.open) peek(det);
    });
    return det;
  }

  /** The components that place this part, and its copies in each of the chapters' CPUs (lib/usage.ts, on first open). */
  private usedSection(d: ComponentDef): HTMLElement {
    const det = h('details', { class: 'insp-used' }, h('summary', null, 'Where it is used'));
    const show = (u: { parents: Parent[]; cpus: { label: string; n: number }[] }) => {
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
        h('table', { class: 'ports used' }, h('tbody', null, u.cpus.map((c) => h('tr', null, h('td', null, c.label), h('td', { class: 'val' }, c.n ? groupDigits(c.n) : '—'))))));
    };
    // The whole library is read for this (every part that places it): its chunk loads here, on first open, not with the page.
    const fill = () => {
      const known = this.usage.get(d);
      if (known) return show(known);
      const wait = h('div', { class: 'insp-used-h' }, 'Reading every library part…');
      det.append(wait);
      Promise.all([import('../lib/usage'), import('../lib')]).then(([m]) => {
        const u = { parents: m.usedIn(d), cpus: m.referenceCpus().map((c) => ({ label: c.label, n: m.copiesIn(c.def, d) })) };
        this.usage.set(d, u);
        wait.remove();
        show(u);
        if (det.open) peek(det);
      }, (e) => { wait.textContent = `Could not load the library: ${String(e)}`; });
    };
    if (this.usedOpen) {
      det.open = true;
      fill();
    }
    det.addEventListener('toggle', () => {
      this.usedOpen = det.open;
      if (det.open && det.childElementCount === 1) fill();
      if (det.open) peek(det);
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
    if (d.prim === 'dep') {
      this.body.append(h('p', { class: 'empty' }, 'A depletion-mode NMOS with its gate tied to its source: always on, weaker than any switching transistor. The pull-up of an NMOS gate.'));
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
    if (n > TRUTH_MAX_BITS) {
      this.body.append(h('p', { class: 'empty' }, `${n} input bits → ${groupDigits(2 ** n)} rows. Too many to list. That is why we describe big circuits with arithmetic, not tables.`));
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
        h('button', { class: 'btn sm', title: 'Every entity exactly as drawn, in structural VHDL-93: NAND gates as entity nand2 (.vhd; not checked by a VHDL tool here)', onclick: () => { const f = vhdlHierarchy(d); download(f.filename, f.text); note.textContent = `${f.filename}: ${f.entities} entit${f.entities > 1 ? 'ies' : 'y'}.`; } }, icon('code', 14), 'VHDL'),
        h('label', { class: 'dl-tb', title: tbOk ? 'Append a self-checking testbench with vectors from this site’s simulation (the Verilog downloads only)' : 'Testbenches are generated for loop-free (combinational) logic only' }, tb, 'testbench')),
      note);
  }

  /** Clear what a click on a source line lit on the stage. */
  private unlight(): void {
    const l = this.hdlLit;
    this.hdlLit = null;
    l?.clear();
  }

  private renderHdl(t: InspectTarget): void {
    const d = t.def;
    // the level on the stage, linked to its own source: the target itself, or the level a selected part sits on
    const L = t.level && netlistOf(t.level.def) ? t.level : null;
    const sel = L && L.def !== d ? t.instance ?? null : null;
    if (L && sel) this.body.append(this.linkedSource(L, sel, `Where ${sel} sits: ${L.def.name}`));
    const gen = structuralVerilog(d);
    const vhd = structuralVhdl(d);
    const blocks: [string, string, boolean][] = [];
    if (d.hdl?.verilog) blocks.push(['SystemVerilog', d.hdl.verilog, false]);
    // the level itself: its generated source is the linked block, not two plain ones
    const linkedHere = !!L && L.def === d;
    if (!linkedHere && gen) blocks.push(['Structural Verilog (generated from this schematic)', gen, false]);
    if (!linkedHere && vhd) blocks.push(['Structural VHDL (generated from this schematic)', vhd, true]);
    if (!blocks.length && !linkedHere) {
      if (!sel) this.body.append(h('p', { class: 'empty' }, 'No HDL for this element.'));
      return;
    }
    if (sel && blocks.length) this.body.append(h('div', { class: 'code-head hdl-own' }, `Inside ${sel}: ${d.name}`));
    if (gen) this.body.append(this.downloadRow(d));
    if (linkedHere) this.body.append(this.linkedSource(L!, null, 'Structural source (generated from this schematic)'));
    for (const [title, code, isVhdl] of blocks) {
      const copy = h('button', { class: 'btn ghost sm', onclick: () => navigator.clipboard?.writeText(code) }, 'Copy');
      this.body.append(h('div', { class: 'code-head' }, title, copy), h('pre', { class: 'code', html: isVhdl ? highlightVhdl(code) : highlight(code) }));
    }
  }

  /**
   * The level's generated source, Verilog or VHDL, linked to the drawing: a line an instance wrote is a button that lights
   * that instance on the stage (again: off), and the selected part's lines are marked and scrolled into view.
   */
  private linkedSource(L: NonNullable<InspectTarget['level']>, sel: string | null, title: string): HTMLElement {
    const wrap = h('div', { class: 'hdl-linked' });
    const draw = (): void => {
      const src: HdlLines | null = this.hdlLang === 'vhdl' ? vhdlLines(L.def) : verilogLines(L.def);
      const lang = (k: 'verilog' | 'vhdl', label: string) => h('button', {
        class: `btn sm${this.hdlLang === k ? ' on' : ''}`, 'aria-pressed': String(this.hdlLang === k),
        onclick: () => { if (this.hdlLang !== k) { this.unlight(); this.hdlLang = k; draw(); } },
      }, label);
      const copy = h('button', { class: 'btn ghost sm', onclick: () => navigator.clipboard?.writeText(src?.text ?? '') }, 'Copy');
      const head = h('div', { class: 'code-head' }, h('span', { class: 'hdl-title' }, title),
        h('span', { class: 'hdl-lang', role: 'group', 'aria-label': 'Language' }, lang('verilog', 'Verilog'), lang('vhdl', 'VHDL')), copy);
      if (!src) { wrap.replaceChildren(head, h('p', { class: 'empty' }, 'No HDL for this level.')); return; }
      const pre = h('pre', { class: 'code linked' });
      const mark = () => {
        for (const el of pre.querySelectorAll<HTMLElement>('.ln[data-inst]')) el.classList.toggle('lit', el.dataset.inst === this.hdlLit?.inst);
      };
      const light = (inst: string) => {
        if (this.hdlLit?.inst === inst) this.unlight();
        else {
          this.unlight();
          L.light([inst]);
          this.hdlLit = { inst, clear: () => { L.light([]); mark(); } };
        }
        mark();
      };
      src.text.split('\n').forEach((line, i) => {
        const inst = instanceAt(src, i);
        const html = this.hdlLang === 'vhdl' ? highlightVhdl(line) : highlight(line);
        const el = inst === null
          ? h('span', { class: 'ln', html })
          : h('span', {
            class: `ln own${inst === sel ? ' sel' : ''}`, html, 'data-inst': inst, role: 'button', tabindex: '0',
            title: `${inst}: light it on the circuit (click again to put it out)`, 'aria-label': `Light ${inst} on the circuit`,
            onclick: () => light(inst),
            onkeydown: (e: Event) => { const k = (e as KeyboardEvent).key; if (k === 'Enter' || k === ' ') { e.preventDefault(); light(inst); } },
          });
        pre.append(el, '\n');
      });
      wrap.replaceChildren(head, pre, h('p', { class: 'hdl-hint' }, sel
        ? `The lines that place ${sel} are marked. Click any part's line to light it on the circuit.`
        : 'Click a line to light its part on the circuit; select a part to find its lines.'));
      mark();
      if (sel) {
        const at = firstLineOf(src, sel);
        if (at !== null) requestAnimationFrame(() => {
          const el = pre.querySelectorAll<HTMLElement>('.ln')[at];
          if (el) pre.scrollTop = Math.max(0, el.offsetTop - pre.offsetTop - pre.clientHeight / 3);
        });
      }
    };
    draw();
    return wrap;
  }
}

function download(name: string, text: string): void {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function logicDepthSafe(d: ComponentDef, model: DelayModel = 'unit'): number | null {
  try {
    return logicDepth(d, model);
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
const VHDL_KW = /\b(library|use|entity|is|port|in|out|inout|end|architecture|of|signal|begin|map|open|downto|std_logic|std_logic_vector|nand|work)\b/gi;

/** VHDL: -- comments, the keywords this generator writes. */
function highlightVhdl(code: string): string {
  const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split('\n').map((line) => {
    const i = line.indexOf('--');
    const body = i >= 0 ? line.slice(0, i) : line;
    const cm = i >= 0 ? `<span class="cm">${line.slice(i)}</span>` : '';
    return body.replace(VHDL_KW, '<span class="kw">$1</span>').replace(/\b(\d+)\b/g, '<span class="num">$1</span>') + cm;
  }).join('\n');
}

function highlight(code: string): string {
  const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split('\n').map((line) => {
    const i = line.indexOf('//');
    const body = i >= 0 ? line.slice(0, i) : line;
    const cm = i >= 0 ? `<span class="cm">${line.slice(i)}</span>` : '';
    return body.replace(KW, '<span class="kw">$1</span>').replace(/\b(\d+'[bdh][0-9a-fA-F_]+|\d+)\b/g, '<span class="num">$1</span>') + cm;
  }).join('\n');
}
