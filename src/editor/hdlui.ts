// Verilog chips in the sandbox (plugin): the text beside the canvas, synthesized by Yosys in the page a second after
// typing stops (or Ctrl/⌘ Enter), the schematic redrawn from it; a banner on the canvas (Detach, Hide text); the
// chip's Verilog properties (top module, gates, modules); File ▸ Import of .v / .sv (Verilog chips) and of Yosys
// JSON netlists (drawn chips); New chip ▾ Verilog chip. The model is hdl.ts; Yosys runs in hdl/yosys.ts.

import '../styles/editor-hdl.css';
import { h, icon } from '../ui/dom';
import { GATE_SETS, type GateSet, synthesize, YOSYS_BYTES, YOSYS_VERSION, yosysReady } from '../hdl/yosys';
import { type HdlDiag, type ImportedModule, isYosysJson } from '../hdl/yosysjson';
import { type Editor, registerEditorPlugin, registerNewChipKind } from './editor';
import { dialog, registerFileImporter } from './fileui';
import { applyNetlist, detachGroup, hdlGroup, hdlHome, importNetlist, newVerilogChip, setSource, verilogModules } from './hdl';
import type { ChipDoc } from './model';
import { registerPropsSection } from './props';

const TYPING_MS = 1000;
const WIDTH_KEY = 'mosfet2riscv:hdl-width';
const HIDDEN_KEY = 'mosfet2riscv:hdl-hidden';

const load = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };

/** What the last synthesis of a group said. */
interface GroupState {
  diags: HdlDiag[];
  modules?: ImportedModule[];
  /** The text it ran on (an unchanged stale text is not retried). */
  tried?: string;
  at?: number;
}

class HdlUi {
  readonly pane: HTMLElement;
  private readonly ta: HTMLTextAreaElement;
  private readonly hl: HTMLElement;
  private readonly diagEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly stateEl: HTMLElement;
  private readonly fileEl: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly groups = new Map<string, GroupState>();
  private home: string | null = null;
  /** The text being typed differs from the workspace's (a synthesis is due). */
  private dirty = false;
  private timer = 0;
  private running = new Map<string, number>(); // home → token of the synthesis in flight
  private token = 0;
  private loading: string | null = null;
  private hidden = new Set<string>(JSON.parse(load(HIDDEN_KEY) ?? '[]') as string[]);
  private unsub: () => void;
  private alive = true;

  constructor(readonly ed: Editor) {
    this.hl = h('pre', { class: 'hdl-hl', 'aria-hidden': 'true' });
    this.ta = h('textarea', { class: 'hdl-ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off', 'aria-label': 'Verilog source' }) as HTMLTextAreaElement;
    this.fileEl = h('span', { class: 'hdl-file' });
    this.stateEl = h('span', { class: 'hdl-state' });
    this.diagEl = h('div', { class: 'hdl-diags', role: 'list', 'aria-label': 'Problems' });
    this.statusEl = h('div', { class: 'hdl-status' });
    const grip = h('div', { class: 'hdl-grip', role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' });
    this.pane = h('div', { class: 'hdl-pane', hidden: true },
      h('div', { class: 'hdl-head' }, this.fileEl, h('span', { class: 'grow' }), this.stateEl,
        h('button', { class: 'btn sm primary', title: 'Synthesize now (Ctrl/⌘ Enter)', onclick: () => this.synthNow() }, 'Synthesize')),
      h('div', { class: 'hdl-code' }, this.hl, this.ta),
      this.diagEl, this.statusEl, grip);
    const w = Number(load(WIDTH_KEY));
    if (w >= 240) this.pane.style.width = `${w}px`;
    this.banner = h('div', { class: 'hdl-banner', hidden: true });
    ed.slots.left.append(this.pane);
    ed.slots.overlay.append(this.banner);

    this.ta.addEventListener('input', () => this.typed());
    this.ta.addEventListener('scroll', () => { this.hl.scrollTop = this.ta.scrollTop; this.hl.scrollLeft = this.ta.scrollLeft; });
    this.ta.addEventListener('keydown', (e) => this.key(e));
    grip.addEventListener('pointerdown', (e) => this.resize(e));
    this.unsub = ed.onChange(() => this.sync());
    this.sync();
  }

  destroy(): void {
    this.alive = false;
    clearTimeout(this.timer);
    this.unsub();
    this.pane.remove();
    this.banner.remove();
  }

  state(home: string): GroupState {
    let g = this.groups.get(home);
    if (!g) this.groups.set(home, (g = { diags: [] }));
    return g;
  }

  // ---- following the workspace ------------------------------------------------------------------

  /** After every change: the pane for the open chip's source, stale chips synthesized. */
  sync(): void {
    const ws = this.ed.ws;
    const home = hdlHome(ws, this.ed.chipId) ?? null;
    if (home?.id !== this.home) {
      if (this.dirty && this.home) this.flush();
      this.home = home?.id ?? null;
      this.dirty = false;
    }
    const show = !!home && !this.hidden.has(home.id);
    this.pane.hidden = !show;
    if (home && !this.dirty) {
      const text = home.hdl!.src!.text;
      if (this.ta.value !== text) {
        const { selectionStart: a, selectionEnd: b } = this.ta;
        this.ta.value = text;
        if (document.activeElement === this.ta) this.ta.setSelectionRange(Math.min(a, text.length), Math.min(b, text.length));
      }
    }
    this.renderAll();
    // Stale bodies here or placed below: synthesize them (once per text: a text with errors stays stale).
    const ids = [this.ed.chipId, ...this.ed.lib.deps(this.ed.chipId)];
    for (const id of new Set(ids.map((i) => hdlHome(ws, i)?.id).filter((x): x is string => !!x))) {
      const c = ws.chips[id];
      if (!c.hdl!.stale || this.running.has(id) || (id === this.home && this.dirty)) continue;
      if (this.state(id).tried === c.hdl!.src!.text) continue;
      void this.run(id, c.hdl!.src!.text, 'auto');
    }
  }

  private renderAll(): void {
    const home = this.home ? this.ed.ws.chips[this.home] : undefined;
    const g = this.home ? this.state(this.home) : undefined;
    if (home && g) {
      this.fileEl.textContent = home.hdl!.src!.file;
      this.paintCode();
      this.renderDiags(g);
      this.renderStatus(home, g);
    }
    this.renderBanner();
  }

  private renderStatus(home: ChipDoc, g: GroupState): void {
    const busy = this.running.has(home.id);
    this.stateEl.className = 'hdl-state';
    if (this.loading && busy) this.stateEl.textContent = this.loading;
    else if (busy) this.stateEl.textContent = 'synthesizing…';
    else if (this.dirty) this.stateEl.textContent = 'typing…';
    else if (home.hdl!.stale && g.diags.some((d) => d.level === 'error')) { this.stateEl.textContent = '✕ errors'; this.stateEl.classList.add('bad'); }
    else if (!home.hdl!.stale) { this.stateEl.textContent = '✓ synthesized'; this.stateEl.classList.add('ok'); }
    else this.stateEl.textContent = '';
    const mods = g.modules;
    const cells = mods ? cellSummary(mods.find((m) => m.chip === home.id)?.cells ?? {}) : '';
    this.statusEl.replaceChildren(...[
      h('span', null, 'Yosys ', h('b', null, YOSYS_VERSION.replace(/\.\d+$/, ''))),
      mods ? h('span', null, `${mods.length} module${mods.length > 1 ? 's' : ''} → `, h('b', null, `${mods.length} chip${mods.length > 1 ? 's' : ''}`)) : null,
      cells ? h('span', null, 'cells ', h('b', null, cells)) : null,
      h('span', null, 'gates ', h('b', null, GATE_SETS[home.hdl!.src!.gates].label)),
    ].filter((x): x is HTMLSpanElement => !!x));
  }

  private renderDiags(g: GroupState): void {
    const diags = g.diags;
    if (!diags.length) {
      this.diagEl.replaceChildren(h('div', { class: 'hdl-diag none' }, this.dirty || !g.tried ? '' : 'No problems.'));
      return;
    }
    this.diagEl.replaceChildren(...diags.slice(0, 50).map((d) => h('button', {
      class: `hdl-diag ${d.level}`, role: 'listitem', title: d.line ? `Go to line ${d.line}` : '',
      onclick: () => d.line && this.goLine(d.line),
    }, h('span', { class: 'hdl-diag-at' }, `${d.level === 'error' ? '✕' : '⚠'} ${d.line ? `${d.file ?? ''}:${d.line}` : d.module ?? ''}`), ' ', d.msg)));
  }

  private renderBanner(): void {
    const home = hdlHome(this.ed.ws, this.ed.chipId);
    this.banner.hidden = !home;
    this.ed.canvas.classList.toggle('hdl-stale', !!home?.hdl?.stale && !this.running.has(home.id) && this.state(home.id).diags.some((d) => d.level === 'error'));
    if (!home) return;
    const busy = this.running.has(home.id);
    const g = this.state(home.id);
    const failed = !busy && home.hdl!.stale && g.diags.some((d) => d.level === 'error');
    const hidden = this.hidden.has(home.id);
    const empty = !this.ed.doc.parts.length;
    this.banner.replaceChildren(
      h('span', { class: 'hdl-badge' }, '.v'),
      h('span', { class: 'grow' }, busy ? (this.loading ?? 'Synthesizing…')
        : failed ? (empty ? 'The text has errors: nothing drawn yet' : `Showing the last good build${g.at ? `, ${ago(g.at)}` : ''}: the text has errors`)
          : h('span', null, 'Drawn from ', h('b', null, home.hdl!.src!.file), this.ed.chipId === home.id ? '' : ` (module ${this.ed.doc.hdl?.module})`, ' · edit the text to change it')),
      h('button', { class: 'btn sm', title: 'Turn this chip (and the others from the same text) into ordinary drawn chips', onclick: () => this.detach() }, 'Detach as drawn chip'),
      h('button', { class: 'btn sm', onclick: () => this.toggleHidden(home.id) }, hidden ? 'Show text' : 'Hide text'));
  }

  // ---- editing ----------------------------------------------------------------------------------

  private typed(): void {
    this.dirty = true;
    this.paintCode();
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), TYPING_MS);
    this.renderAll();
  }

  /** The typed text: synthesized now (it reaches the workspace with the drawing, one undo step). */
  private flush(): void {
    clearTimeout(this.timer);
    if (!this.home || !this.dirty) return;
    const text = this.ta.value;
    this.dirty = false;
    void this.run(this.home, text, 'edit');
  }

  synthNow(): void {
    if (this.dirty) return this.flush();
    if (this.home) void this.run(this.home, this.ed.ws.chips[this.home].hdl!.src!.text, 'edit');
  }

  private key(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.synthNow(); return; }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Indent (Shift+Tab leaves the field, so the keyboard can always get out).
      if (e.shiftKey) return;
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = this.ta;
      this.ta.value = value.slice(0, a) + '  ' + value.slice(b);
      this.ta.setSelectionRange(a + 2, a + 2);
      this.typed();
    }
  }

  private goLine(line: number): void {
    if (this.pane.hidden && this.home) this.toggleHidden(this.home);
    const lines = this.ta.value.split('\n');
    const at = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    this.ta.focus();
    this.ta.setSelectionRange(at, at + (lines[line - 1]?.length ?? 0));
    const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 18;
    this.ta.scrollTop = Math.max(0, (line - 4) * lh);
  }

  /**
   * Synthesize `text` for a group. 'edit': the text and the new drawing reach the workspace as one undo step;
   * 'auto' (a stale chip shown or placed): the drawing replaces the stale one without an undo step.
   */
  async run(home: string, text: string, why: 'edit' | 'auto'): Promise<void> {
    const ws0 = this.ed.ws.chips[home];
    if (!ws0?.hdl?.src) return;
    const t = ++this.token;
    this.running.set(home, t);
    const g = this.state(home);
    g.tried = text;
    if (!yosysReady()) this.loading = `Loading Yosys (${mb(YOSYS_BYTES)}, once)…`;
    this.renderAll();
    const src = ws0.hdl.src;
    const r = await synthesize({ [src.file]: text }, {
      top: src.top, gates: src.gates,
      progress: (done, total) => { this.loading = `Loading Yosys ${mb(done)} / ${mb(total)} (once)`; this.renderAll(); },
    }).catch((e: unknown) => ({ json: undefined, diags: [{ level: 'error' as const, msg: e instanceof Error ? e.message : String(e) }], log: '' }));
    this.loading = null;
    if (!this.alive || this.running.get(home) !== t) return; // superseded
    this.running.delete(home);
    const cur = this.ed.ws;
    if (!cur.chips[home]?.hdl?.src) return this.renderAll();
    let next = cur.chips[home].hdl!.src!.text === text ? cur : setSource(cur, home, { text });
    if (r.json) {
      const o = applyNetlist(next, home, r.json, r.diags);
      g.diags = o.diags;
      if (o.ok) {
        next = o.ws;
        g.modules = o.modules;
        g.at = Date.now();
        if (o.added.length && why === 'edit') this.ed.toast(`New chip${o.added.length > 1 ? 's' : ''} from the text: ${o.added.map((id) => next.chips[id].name).join(', ')}`);
      }
    } else g.diags = r.diags;
    if (next !== cur) {
      // A view still fitted (or fitted to the empty chip before its first drawing) is fitted to the new drawing.
      const shown = cur.chips[this.ed.chipId];
      const refit = this.ed.view.cam.fitted || !shown?.parts.length;
      if (why === 'auto' && cur.chips[home].hdl!.src!.text === text) this.ed.volatile(next);
      else this.ed.editWs(() => next);
      if (refit && this.ed.ws.chips[this.ed.chipId]?.parts.length) this.ed.fitView();
    } else this.renderAll();
  }

  // ---- actions ------------------------------------------------------------------------------------

  detach(): void {
    const r = detachGroup(this.ed.ws, this.ed.chipId);
    if (!r.ids.length) return;
    this.ed.editWs(() => r.ws);
    this.ed.toast(`${r.ids.map((id) => this.ed.ws.chips[id].name).join(', ')}: drawn chips now, edited on the canvas (Ctrl+Z brings the text back)`);
  }

  toggleHidden(home: string): void {
    if (this.hidden.has(home)) this.hidden.delete(home);
    else this.hidden.add(home);
    save(HIDDEN_KEY, JSON.stringify([...this.hidden]));
    this.sync();
  }

  /** Top module or gates changed in the properties: saved, then synthesized. */
  setOption(o: { top?: string; gates?: GateSet }): void {
    const home = hdlHome(this.ed.ws, this.ed.chipId);
    if (!home) return;
    if (this.dirty) this.flush();
    this.ed.editWs((ws) => setSource(ws, home.id, { ...o, ...('top' in o && !o.top ? { top: undefined } : {}) }));
    void this.run(home.id, this.ed.ws.chips[home.id].hdl!.src!.text, 'auto');
  }

  private resize(e: PointerEvent): void {
    e.preventDefault();
    const x0 = e.clientX, w0 = this.pane.offsetWidth;
    const move = (m: PointerEvent) => {
      const max = Math.max(260, this.ed.el.clientWidth * 0.6);
      this.pane.style.width = `${Math.round(Math.min(max, Math.max(240, w0 + m.clientX - x0)))}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      save(WIDTH_KEY, String(this.pane.offsetWidth));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---- the highlighted text ------------------------------------------------------------------

  private paintCode(): void {
    const g = this.home ? this.state(this.home) : undefined;
    const bad = new Set((g?.diags ?? []).filter((d) => d.level === 'error' && d.line).map((d) => d.line!));
    const warn = new Set((g?.diags ?? []).filter((d) => d.level === 'warn' && d.line).map((d) => d.line!));
    this.hl.innerHTML = highlight(this.ta.value).map((line, i) =>
      `<span class="ln${bad.has(i + 1) ? ' err' : warn.has(i + 1) ? ' warn' : ''}">${line || ' '}</span>`).join('') + '<span class="ln"> </span>';
  }
}

const uis = new WeakMap<Editor, HdlUi>();

registerEditorPlugin((ed) => {
  if (ed.level) return; // campaign levels are drawn by hand
  const ui = new HdlUi(ed);
  uis.set(ed, ui);
  return () => { ui.destroy(); uis.delete(ed); };
});

// ---- properties -------------------------------------------------------------------------------------

registerPropsSection({
  id: 'hdl', order: 9,
  render(ed) {
    if (ed.selCount) return null;
    const home = hdlHome(ed.ws, ed.chipId);
    const ui = uis.get(ed);
    if (!home || !ui) return null;
    const src = home.hdl!.src!;
    const g = ui.state(home.id);
    const mods = verilogModules(src.text);
    const top = h('select', { 'aria-label': 'Top module', title: 'The module this chip is; the modules it places become chips of their own' },
      h('option', { value: '' }, `automatic${mods.length ? ` (${mods[mods.length - 1]})` : ''}`),
      mods.map((m) => h('option', { value: m, selected: src.top === m }, m))) as HTMLSelectElement;
    top.addEventListener('change', () => ui.setOption({ top: top.value }));
    const gates = h('div', { class: 'hdl-seg', role: 'radiogroup', 'aria-label': 'Gates used' },
      (Object.keys(GATE_SETS) as GateSet[]).map((k) => h('button', {
        class: k === src.gates ? 'on' : '', role: 'radio', 'aria-checked': String(k === src.gates), title: GATE_SETS[k].title,
        onclick: () => k !== src.gates && ui.setOption({ gates: k }),
      }, GATE_SETS[k].label)));
    const group = hdlGroup(ed.ws, home.id);
    return h('section', { class: 'sb-sec-props hdl-props' }, h('h3', null, 'Verilog'),
      h('div', { class: 'sb-row' }, h('span', null, 'Source'), h('code', null, src.file)),
      h('div', { class: 'sb-row' }, h('span', null, 'Top'), top),
      h('div', { class: 'sb-row' }, h('span', null, 'Gates'), gates),
      h('p', { class: 'sb-sum' }, 'Which cells Yosys may map the logic onto. Flip-flops become the library\'s master–slave DFFs, with gates for any reset or enable.'),
      h('h4', null, 'Modules'),
      h('ul', { class: 'hdl-mods' }, group.map((c) => {
        const m = g.modules?.find((x) => x.chip === c.id);
        const n = m ? Object.entries(m.cells).filter(([t]) => t !== '$scopeinfo').reduce((s, [, v]) => s + v, 0) : undefined;
        return h('li', null, h('button', { class: 'sb-chip-btn', onclick: () => ed.openChip(c.id) }, c.hdl!.module),
          h('span', { class: 'sb-sum' }, c.id === home.id ? ' this chip' : '', n !== undefined ? ` · ${n} cells` : c.hdl?.stale ? ' · not synthesized' : ''));
      })),
      h('div', { class: 'sb-btns' },
        h('button', { class: 'btn sm', onclick: () => ui.synthNow() }, icon('play', 14), 'Synthesize'),
        h('button', { class: 'btn sm', onclick: () => ui.detach() }, 'Detach'),
        ui.pane.hidden ? h('button', { class: 'btn sm', onclick: () => ui.toggleHidden(home.id) }, 'Show text') : null));
  },
});

// ---- import and new chips ------------------------------------------------------------------------------

registerFileImporter({
  accept: ['.v', '.sv', '.vh', '.svh'],
  takes: (name) => /\.(s?v|s?vh)$/i.test(name),
  run: (ed, name, text) => importVerilogDialog(ed, name, text),
});

registerFileImporter({
  accept: [],
  takes: (name, text) => {
    if (!/\.json$/i.test(name) || !/"modules"\s*:/.test(text.slice(0, 1 << 16))) return false;
    try { return isYosysJson(JSON.parse(text)); } catch { return false; }
  },
  run: (ed, name, text) => {
    const r = importNetlist(ed.ws, JSON.parse(text));
    if ('error' in r) return void ed.toast(`${name}: ${r.error}`, 'err');
    ed.editWs(() => r.ws);
    const names = r.added.map((id) => ed.ws.chips[id].name);
    dialog(ed, `Imported ${name}`, [
      h('p', { class: 'sb-dlg-lead' }, `A Yosys netlist: ${names.length} chip${names.length > 1 ? 's' : ''} drawn from its cells (${names.join(', ')}). Ctrl+Z undoes the import.`),
      h('p', { class: 'sb-sum' }, 'A netlist has no source text, so these are ordinary drawn chips. Import the Verilog itself (.v) to keep editing it as text.'),
      r.diags.length ? h('ul', { class: 'hdl-dlg-diags' }, r.diags.map((d) => h('li', { class: d.level }, d.module ? `${d.module}: ` : '', d.msg))) : null,
    ]);
  },
});

function importVerilogDialog(ed: Editor, name: string, text: string): void {
  const mods = verilogModules(text);
  if (!mods.length) return void ed.toast(`${name}: no module in it`, 'err');
  const top = h('select', { 'aria-label': 'Top module' },
    h('option', { value: '' }, `automatic (${mods[mods.length - 1]})`), mods.map((m) => h('option', { value: m }, m))) as HTMLSelectElement;
  const gates = h('select', { 'aria-label': 'Gates' }, (Object.keys(GATE_SETS) as GateSet[]).map((k) =>
    h('option', { value: k, selected: k === 'std' }, GATE_SETS[k].title))) as HTMLSelectElement;
  const go = () => {
    d.close();
    const file = name.replace(/^.*[\\/]/, '');
    const r = newVerilogChip(ed.ws, text, file, gates.value as GateSet, top.value || undefined);
    ed.editWs(() => r.ws); // the plugin synthesizes the new (stale) chip as it opens
  };
  const d = dialog(ed, `Import ${name}`, [
    h('p', { class: 'sb-dlg-lead' }, `Verilog: ${mods.length} module${mods.length > 1 ? 's' : ''} (${mods.join(', ')}), each a chip drawn by Yosys. The text stays editable beside the drawing.`),
    h('div', { class: 'sb-row' }, h('span', null, 'Top'), top),
    h('div', { class: 'sb-row' }, h('span', null, 'Gates'), gates),
    yosysReady() ? null : h('p', { class: 'sb-sum' }, `The first synthesis loads Yosys (${mb(YOSYS_BYTES)}, once; the browser keeps it). Nothing is uploaded.`),
  ], [h('button', { class: 'btn sm', onclick: () => d.close() }, 'Cancel'), h('button', { class: 'btn primary sm', onclick: go }, 'Import')]);
}

registerNewChipKind({
  label: 'Verilog chip', hint: 'write it as text: Yosys draws it', icon: 'code',
  run: (ed) => ed.editWs((ws) => newVerilogChip(ws).ws),
});

// ---- helpers ---------------------------------------------------------------------------------------------

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}

/** 12 NAND + 8 XOR + 2 chips */
function cellSummary(cells: Record<string, number>): string {
  const parts = Object.entries(cells).filter(([t]) => t !== '$scopeinfo' && t !== '$_BUF_')
    .map(([t, n]) => [t.startsWith('$_') ? t.replace(/^\$_|_$/g, '').replace(/_.*$/, '') : 'chip', n] as const);
  const sum = new Map<string, number>();
  for (const [t, n] of parts) sum.set(t, (sum.get(t) ?? 0) + n);
  return [...sum].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t === 'chip' ? (n > 1 ? 'chips' : 'chip') : t}`).join(' + ');
}

const KEYWORDS = new Set(('module endmodule input output inout wire reg logic integer parameter localparam assign always always_ff ' +
  'always_comb always_latch initial begin end if else case casez casex endcase default for while posedge negedge or and not ' +
  'generate endgenerate genvar function endfunction task endtask signed unsigned typedef enum struct packed').split(' '));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Verilog as highlighted HTML, a string per line (block comments carried across lines). */
export function highlight(text: string): string[] {
  let inBlock = false;
  return text.split('\n').map((line) => {
    let out = '', i = 0;
    while (i < line.length) {
      if (inBlock) {
        const e = line.indexOf('*/', i);
        const j = e < 0 ? line.length : e + 2;
        out += `<i class="cm">${esc(line.slice(i, j))}</i>`;
        if (e >= 0) inBlock = false;
        i = j;
        continue;
      }
      const rest = line.slice(i);
      let m: RegExpExecArray | null;
      if (rest.startsWith('//')) { out += `<i class="cm">${esc(rest)}</i>`; break; }
      if (rest.startsWith('/*')) { inBlock = true; out += '<i class="cm">/*</i>'; i += 2; continue; }
      if ((m = /^"(?:\\.|[^"\\])*"?/.exec(rest))) { out += `<i class="st">${esc(m[0])}</i>`; i += m[0].length; continue; }
      if ((m = /^(?:\d+)?'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ?]+|^\d[\d_]*(?:\.\d+)?/.exec(rest))) { out += `<i class="nm">${esc(m[0])}</i>`; i += m[0].length; continue; }
      if ((m = /^\$?[A-Za-z_][\w$]*/.exec(rest))) {
        const w = m[0];
        out += KEYWORDS.has(w) ? `<i class="kw">${w}</i>` : w.startsWith('$') ? `<i class="sys">${esc(w)}</i>` : esc(w);
        i += w.length;
        continue;
      }
      out += esc(line[i]);
      i++;
    }
    return out;
  });
}
