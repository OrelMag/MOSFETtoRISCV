// The I/O parts' panels (ioparts.ts): their property sections and the Screens drawer. The drawer
// (right-hand dock) lists, live, every console, screen and switch bank in the open chip's
// hierarchy, headed by its path, so a whole computer closed into one chip can still be watched
// and its switches flipped. It opens by itself when the open chip holds a nested console or
// screen (unless the user closed it for that chip), and follows tab switches (editor.sim is per
// chip). Clear and Save PNG act on the part's state in the simulation, never on the document.

import { formatBits } from '../sim/values';
import type { HierNode } from '../sim/flatten';
import { h, icon } from '../ui/dom';
import { saveFile } from '../view/image';
import { dockPane, paneShown, showPane, undockPane } from './dock';
import { type Editor, registerEditorPlugin, registerToolbarAction } from './editor';
import { fileBase } from './files';
import { ScreenCanvas, toggleSwitch } from './ioface';
import {
  clearedState, COLOR_BITS, type ColorFormat, COLOR_FORMATS, COLOR_NAMES, CONSOLE_COLS, CONSOLE_ROWS, type ConsoleState, consoleText, ioInfo, type IoInfo, ioLeaf,
  type IoNode, ioNodes, ioState, MAX_SWITCHES, MAX_VSYNC, SCREEN_MODES, SCREEN_SIZES, screenProblem, type ScreenRef, type ScreenState, type SwitchState,
} from './ioparts';
import type { PartDoc, PartRef } from './model';
import { setRef } from './ops';
import { registerPropsSection } from './props';

/** Run `f` once per frame while `el` is on the page (it starts detached: give it a moment). */
function live(el: HTMLElement, f: () => void): void {
  let seen = false, waited = 0;
  const tick = () => {
    if (el.isConnected) {
      seen = true;
      f();
    } else if (seen || ++waited > 120) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const row = (label: string, ctl: Node, hint?: string) => h('label', { class: 'sb-row', title: hint ?? null }, h('span', null, label), ctl);
const btn = (label: string, title: string, f: () => void, ic?: string) => h('button', { class: 'btn sm', title, onclick: f }, ic ? icon(ic, 14) : null, label);

function select<T extends string | number>(value: T, options: [T, string, boolean?][], commit: (v: T) => void, label: string): HTMLSelectElement {
  const s = h('select', { 'aria-label': label }, options.map(([v, l, off]) => h('option', { value: String(v), selected: v === value, disabled: !!off }, l))) as HTMLSelectElement;
  s.addEventListener('change', () => commit(options.find(([v]) => String(v) === s.value)![0]));
  return s;
}

/** Segmented buttons (app.css .seg). */
function seg<T extends string | number>(value: T, options: [T, string][], commit: (v: T) => void, label: string): HTMLElement {
  return h('div', { class: 'seg sb-io-seg', role: 'group', 'aria-label': label },
    options.map(([v, l]) => h('button', { class: v === value ? 'on' : null, 'aria-pressed': String(v === value), onclick: () => v !== value && commit(v) }, l)));
}

function num(value: number, min: number, max: number, commit: (v: number) => void, label: string): HTMLInputElement {
  const i = h('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: '1', 'aria-label': label }) as HTMLInputElement;
  i.addEventListener('change', () => {
    const v = Number(i.value);
    if (Number.isInteger(v) && v >= min && v <= max) commit(v);
    else i.value = String(value);
  });
  return i;
}

/** The one selected part, when exactly one object is selected. */
function selectedPart(ed: Editor): PartDoc | null {
  if (ed.selCount !== 1 || !ed.sel.parts?.length) return null;
  return ed.doc.parts.find((p) => p.id === ed.sel.parts![0]) ?? null;
}

function setPartRef(ed: Editor, id: string, ref: PartRef): void {
  const r = setRef(ed.doc, id, ref, ed.defOf);
  if (r.reason) return void ed.toast(r.reason, 'err');
  ed.edit(() => r.doc);
}

/** The node of a part placed in the open chip, in the editor's simulation. */
const nodeOf = (ed: Editor, id: string): HierNode | null => ed.sim.sim?.design.root.children?.get(id) ?? null;

/** Empty a console or a screen (its state in the simulation). */
function clearIo(ed: Editor, node: HierNode | null, info: IoInfo): void {
  const sim = ed.sim.sim, li = node ? ioLeaf(node) : undefined;
  if (!sim || li === undefined) return;
  ed.sim.pokeLeaf(li, clearedState(info, sim.leafState(li)));
}

async function savePng(ed: Editor, sc: ScreenCanvas, name: string): Promise<void> {
  const blob = await sc.png();
  if (!blob) return void ed.toast('The picture could not be encoded', 'err');
  saveFile(`${fileBase(ed.doc.name)}-${fileBase(name, 'screen')}.png`, blob, 'image/png');
}

const n0 = (v: number) => v.toLocaleString('en-US').replace(/,/g, ' ');

// ---- properties ------------------------------------------------------------------------------

registerPropsSection({
  id: 'io', order: 20,
  render(ed) {
    const p = selectedPart(ed);
    if (!p) return null;
    if ('console' in p.ref) return consoleProps(ed, p, p.ref.console);
    if ('switches' in p.ref) return switchProps(ed, p, p.ref.switches);
    if ('screen' in p.ref) return screenProps(ed, p, p.ref.screen);
    return null;
  },
});

function consoleProps(ed: Editor, p: PartDoc, c: { cols: number; rows: number }): HTMLElement {
  const info = ioInfo(ed.defOf(p))!;
  const text = h('pre', { class: 'io-con-pre sb-io-scroll', 'aria-label': 'Console text (scrollback)' });
  const count = h('span');
  const out = h('section', { class: 'sb-sec-props sb-io-props' }, h('h3', null, 'Console'),
    row('Columns', num(c.cols, CONSOLE_COLS.min, CONSOLE_COLS.max, (v) => setPartRef(ed, p.id, { console: { ...c, cols: v } }), 'Columns'), 'Characters per line on the canvas (longer lines wrap)'),
    row('Rows', num(c.rows, CONSOLE_ROWS.min, CONSOLE_ROWS.max, (v) => setPartRef(ed, p.id, { console: { ...c, rows: v } }), 'Rows'), 'Lines shown on the canvas (the scrollback keeps 500)'),
    h('p', { class: 'sb-sum' }, 'Prints the character on data at each rising clk edge with we = 1: ASCII, \\n (10) new line, \\b (8) backspace, \\f (12) clears, \\t to the next multiple of 8; other codes as their symbols. Resizing keeps the text; Reset clears it.'),
    h('div', { class: 'sb-scr-item' }, text, h('div', { class: 'sb-scr-meta' }, count)),
    h('div', { class: 'sb-btns' },
      btn('Clear', 'Clear the text (the simulation\'s, not an undo step)', () => clearIo(ed, nodeOf(ed, p.id), info), 'close'),
      btn('Copy', 'Copy the whole text', () => {
        const st = ed.sim.sim && nodeOf(ed, p.id) ? ioState(ed.sim.sim, nodeOf(ed, p.id)!) as ConsoleState | undefined : undefined;
        void navigator.clipboard?.writeText(st ? consoleText(st) : '').then(() => ed.toast('Copied'), () => ed.toast('Copy failed', 'err'));
      })));
  let last: unknown = null, lastN = -1;
  live(out, () => {
    const node = nodeOf(ed, p.id), sim = ed.sim.sim;
    const st = sim && node ? ioState(sim, node) as ConsoleState | undefined : undefined;
    if (st === last && (st?.n ?? -1) === lastN) return;
    last = st;
    lastN = st?.n ?? -1;
    text.textContent = st ? consoleText(st) || ' ' : '(not simulated)';
    text.scrollTop = text.scrollHeight;
    count.textContent = st ? `${n0(st.n)} character${st.n === 1 ? '' : 's'} taken · ${st.lines.length} line${st.lines.length === 1 ? '' : 's'}` : '';
  });
  return out;
}

function switchProps(ed: Editor, p: PartDoc, w: number): HTMLElement {
  const value = h('code');
  const set = (v: number) => {
    const node = nodeOf(ed, p.id), li = node?.leafIndex;
    if (li !== undefined) ed.sim.pokeLeaf(li, { v } satisfies SwitchState);
  };
  const out = h('section', { class: 'sb-sec-props sb-io-props' }, h('h3', null, 'Switches'),
    row('Switches', num(w, 1, MAX_SWITCHES, (v) => setPartRef(ed, p.id, { switches: v }), 'Number of switches'), `1–${MAX_SWITCHES}: the width of q`),
    row('q', value),
    h('p', { class: 'sb-sum' }, 'Click a switch on the canvas to flip it, also while the circuit runs (inside a placed chip: from look inside or the Screens panel). They are the world outside the circuit: Reset leaves them where they are, and a challenge check reads them all off.'),
    h('div', { class: 'sb-btns' }, btn('All off', 'Every switch to 0', () => set(0)), btn('All on', 'Every switch to 1', () => set(2 ** w - 1))));
  live(out, () => {
    const node = nodeOf(ed, p.id), sim = ed.sim.sim;
    const t = sim && node ? formatBits(sim.getBits(node.ports.q), ed.view.radix) : '–';
    if (value.textContent !== t) value.textContent = t;
  });
  return out;
}

/** The pins and what the screen does, as the mockup's summary block. */
function screenSummary(r: ScreenRef): string {
  const n = r.size, c = COLOR_BITS[r.color], lg = Math.log2(n), vs = r.vsync ? ` → vsync (every ${r.vsync} edges)` : '';
  if (r.mode === 'write') return `x[${lg}] y[${lg}] color[${c}] we clk${vs}\nwrite: at a rising clk edge with we = 1\nframe buffer: ${n0(n * n)} × ${c} bit${c > 1 ? 's' : ''}, inside the screen`;
  if (r.mode === 'rows') return `row[${lg}] data[${n * c}] load clk${vs}\nload: row := data at a rising clk edge with load = 1\nleftmost pixel in data's top ${c} bit${c > 1 ? 's' : ''}`;
  return `px[${n * n * c}]\nno clock, no memory: what is on the wire is on the screen\ntop-left pixel in px's top ${c} bit${c > 1 ? 's' : ''}, row by row`;
}

function screenProps(ed: Editor, p: PartDoc, r: ScreenRef): HTMLElement {
  const set = (patch: Partial<ScreenRef>) => {
    const next: ScreenRef = { ...r, ...patch };
    for (const k of Object.keys(next) as (keyof ScreenRef)[]) if (next[k] === undefined) delete next[k];
    if (next.mode === 'pixels') delete next.vsync;
    // a size or format the mode cannot take: the largest that fits
    if (screenProblem(next)) {
      const fit = [...SCREEN_SIZES].reverse().find((n) => !screenProblem({ ...next, size: n }));
      if (fit) next.size = fit;
    }
    const why = screenProblem(next);
    if (why) return void ed.toast(why, 'err');
    setPartRef(ed, p.id, { screen: next });
  };
  const sizes = SCREEN_SIZES.map((n): [number, string, boolean] => [n, `${n} × ${n}`, !!screenProblem({ ...r, size: n })]);
  const colors = COLOR_FORMATS.map((f): [ColorFormat, string, boolean] => [f, COLOR_NAMES[f], !!screenProblem({ ...r, color: f })]);
  const info = ioInfo(ed.defOf(p));
  const stats = h('div', { class: 'sb-scr-stats' });
  const sc = new ScreenCanvas(r);
  const vsync = h('input', { type: 'number', min: '1', max: String(MAX_VSYNC), step: '1', value: String(r.vsync ?? 1024), disabled: !r.vsync, 'aria-label': 'vsync period' }) as HTMLInputElement;
  vsync.addEventListener('change', () => {
    const v = Number(vsync.value);
    if (Number.isInteger(v) && v >= 1 && v <= MAX_VSYNC) set({ vsync: v });
    else vsync.value = String(r.vsync ?? 1024);
  });
  const out = h('section', { class: 'sb-sec-props sb-io-props' }, h('h3', null, 'Screen'),
    row('Mode', seg(r.mode, SCREEN_MODES.map((m): [typeof m, string] => [m, m[0].toUpperCase() + m.slice(1)]), (mode) => set({ mode }), 'Mode'),
      'Write: x, y, colour into its own frame buffer · Rows: a row at a time from a bus · Pixels: one wire per pixel'),
    row('Size', select(r.size, sizes, (size) => set({ size }), 'Size'), r.mode === 'pixels' ? `The px bus is at most ${1024} bits` : undefined),
    row('Colour', select(r.color, colors, (color) => set({ color }), 'Colour format'),
      'Mono 1 bit · RGB111 · the 16-colour CGA palette (0 black … 15 white) · RGB332 · RGB565'),
    row('Pixel look', seg(r.look ?? 'square', [['square', 'Square'], ['dots', 'Dots']], (v) => set({ look: v === 'dots' ? 'dots' : undefined }), 'Pixel look')),
    row('Scale on canvas', seg(r.scale ?? 2, [[1, '1×'], [2, '2×'], [4, '4×']], (v) => set({ scale: v === 2 ? undefined : v }), 'Scale')),
    row('Grid lines', seg(r.grid ? 'on' : 'off', [['on', 'On'], ['off', 'Off']], (v) => set({ grid: v === 'on' ? true : undefined }), 'Grid lines')),
    r.mode !== 'pixels' ? row('vsync output', h('span', { class: 'sb-io-vs' },
      h('input', { type: 'checkbox', checked: !!r.vsync, 'aria-label': 'vsync output', onchange: (e: Event) => set({ vsync: (e.target as HTMLInputElement).checked ? Number(vsync.value) || 1024 : undefined }) }),
      vsync, h('span', null, 'edges')), 'A vsync output pin: 1 for one cycle every N rising clk edges (a frame interrupt)') : null,
    h('pre', { class: 'sb-io-pins' }, screenSummary(r)),
    stats,
    h('div', { class: 'sb-btns' },
      r.mode !== 'pixels' ? btn('Clear', 'Clear the picture (the simulation\'s, not an undo step)', () => info && clearIo(ed, nodeOf(ed, p.id), info), 'close') : null,
      btn('Save PNG', 'Download the picture', () => { sc.update(ed.sim.sim, nodeOf(ed, p.id)); void savePng(ed, sc, p.label ?? p.id); }, 'image')));
  let key = '';
  live(out, () => {
    const node = nodeOf(ed, p.id), sim = ed.sim.sim;
    const st = sim && node && r.mode !== 'pixels' ? ioState(sim, node) as ScreenState | undefined : undefined;
    const k = st ? `${st.writes}|${st.frames}|${st.warns}|${st.edges}` : sim ? 'live' : '';
    if (k === key) return;
    key = k;
    const rowsOf: [string, string][] = st
      ? [[r.mode === 'rows' ? 'Rows loaded' : 'Pixels written', n0(st.writes)], ...(r.vsync ? [['Frames (vsync)', n0(st.frames)] as [string, string]] : []),
        ['Clock edges', n0(st.edges)], ...(st.warns ? [['Ignored (X)', n0(st.warns)] as [string, string]] : [])]
      : sim ? [['Shows', 'the px bus, live']] : [['', 'not simulated']];
    stats.replaceChildren(...rowsOf.flatMap(([a, b]) => [h('span', null, a), h('b', null, b)]));
  });
  return out;
}

// ---- the Screens drawer ------------------------------------------------------------------------

const KIND: Record<IoInfo['kind'], string> = { console: 'Console', switches: 'Switches', screen: 'Screen' };

interface Item { io: IoNode; el: HTMLElement; paint(): void }

class ScreensPanel {
  readonly el: HTMLElement;
  open = false;
  /** Opened by itself (closed again by itself when nothing is left to show). */
  private auto = false;
  /** Chips whose drawer the user closed (not reopened automatically this session). */
  private closed = new Set<string>();
  private list = h('div', { class: 'sb-scr-list' });
  private items: Item[] = [];
  private key = '';
  private off: (() => void)[] = [];

  constructor(private ed: Editor) {
    this.el = h('aside', { class: 'sb-drawer sb-screens', 'aria-label': 'Screens' },
      h('div', { class: 'sb-drawer-head' }, icon('screen', 15), h('h3', null, 'Screens & consoles'),
        h('button', { class: 'btn ghost icon-only', title: 'Close', 'aria-label': 'Close the Screens panel', onclick: () => this.setOpen(false, true) }, icon('close', 15))),
      this.list);
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.setOpen(false, true);
    });
    this.off.push(ed.onSimChange(() => this.sync()), ed.onChange(() => this.sync()));
    this.sync();
  }

  /** The I/O parts of the open chip's simulation. */
  private nodes(): IoNode[] {
    const sim = this.ed.sim.sim;
    return sim ? ioNodes(sim.design.root) : [];
  }

  get hasAny(): boolean {
    return this.nodes().length > 0;
  }

  private sync(): void {
    const nodes = this.nodes();
    const nested = nodes.some((n) => n.path.length > 1 && n.info.kind !== 'switches');
    if (!this.open && nested && !this.closed.has(this.ed.chipId)) {
      this.setOpen(true);
      this.auto = true;
    } else if (this.open && this.auto && !nested) this.setOpen(false);
    if (this.open) this.build(nodes);
  }

  toggle(): void {
    if (!this.open) this.setOpen(true, true);
    else if (!paneShown(this.ed, 'screens')) showPane(this.ed, 'screens');
    else this.setOpen(false, true);
  }

  setOpen(on: boolean, byUser = false): void {
    if (on === this.open) return;
    this.open = on;
    this.auto = false;
    if (byUser && !on) this.closed.add(this.ed.chipId);
    if (byUser && on) this.closed.delete(this.ed.chipId);
    if (on) {
      this.key = '';
      dockPane(this.ed, { id: 'screens', label: 'Screens', icon: 'screen', el: this.el, width: 360 });
      this.build(this.nodes());
    } else undockPane(this.ed, 'screens');
    this.ed.renderActions();
  }

  /** Entries again when the parts (or the simulation) changed. */
  private build(nodes: IoNode[]): void {
    const sim = this.ed.sim.sim;
    const key = `${this.ed.chipId}|${nodes.map((n) => `${n.path.join('.')}:${n.def.id}:${ioLeaf(n.node) ?? ''}`).join(',')}`;
    if (key !== this.key || this.items.some((i) => i.io.node !== nodes.find((n) => n.path.join('.') === i.io.path.join('.'))?.node)) {
      this.key = key;
      this.items = nodes.map((io) => this.item(io));
      this.list.replaceChildren(...(this.items.length ? this.items.map((i) => i.el)
        : [h('p', { class: 'sb-scr-none' }, sim ? 'No console, screen or switch bank in this chip or the chips it places.' : 'Not simulated yet.')]));
    }
    this.paint();
  }

  paint(): void {
    if (this.open && paneShown(this.ed, 'screens')) for (const i of this.items) i.paint();
  }

  private item(io: IoNode): Item {
    const ed = this.ed, sim = () => ed.sim.sim;
    const head = h('h4', null, io.path.join(' › '), h('span', { class: 'kind' }, io.info.kind === 'screen' ? io.def.name : KIND[io.info.kind]));
    if (io.info.kind === 'console') {
      const pre = h('pre', { class: 'io-con-pre' });
      let last: unknown = null, lastN = -1;
      const info = io.info;
      return {
        io, el: h('div', { class: 'sb-scr-item' }, head, pre, h('div', { class: 'sb-scr-meta' }, btn('Clear', 'Clear the text', () => clearIo(ed, io.node, info), 'close'))),
        paint() {
          const s = sim(), st = s ? ioState(s, io.node) as ConsoleState | undefined : undefined;
          if (st === last && (st?.n ?? -1) === lastN) return;
          last = st;
          lastN = st?.n ?? -1;
          pre.textContent = st ? consoleText(st) || ' ' : '';
          pre.scrollTop = pre.scrollHeight;
        },
      };
    }
    if (io.info.kind === 'switches') {
      const w = io.info.width;
      const bar = h('div', { class: 'sb-scr-sw' });
      const btns = Array.from({ length: w }, (_, i) => {
        const b = w - 1 - i;
        return h('button', { title: `switch ${b}`, onclick: () => toggleSwitch(ed.sim, io.node, b) }, String(b));
      });
      bar.append(...btns);
      let shown = -1;
      return {
        io, el: h('div', { class: 'sb-scr-item' }, head, bar),
        paint() {
          const s = sim(), v = s && io.node.leafIndex !== undefined ? (s.leafState(io.node.leafIndex) as SwitchState | undefined)?.v ?? 0 : 0;
          if (v === shown) return;
          shown = v;
          btns.forEach((e, i) => e.classList.toggle('on', Math.floor(v / 2 ** (w - 1 - i)) % 2 === 1));
        },
      };
    }
    const r = io.info.ref, info = io.info;
    const sc = new ScreenCanvas(r);
    const meta = h('span');
    let mk = '';
    return {
      io,
      el: h('div', { class: 'sb-scr-item' }, head, sc.canvas, h('div', { class: 'sb-scr-meta' }, meta,
        r.mode !== 'pixels' ? btn('Clear', 'Clear the picture', () => clearIo(ed, io.node, info), 'close') : null,
        btn('PNG', 'Download the picture', () => void savePng(ed, sc, io.path.join('-')), 'image'))),
      paint() {
        const s = sim();
        sc.update(s, io.node);
        const st = s && r.mode !== 'pixels' ? ioState(s, io.node) as ScreenState | undefined : undefined;
        const k = st ? `${st.writes}|${st.frames}` : '';
        if (k === mk) return;
        mk = k;
        meta.textContent = `${COLOR_NAMES[r.color]}${st ? ` · ${n0(st.writes)} ${r.mode === 'rows' ? 'rows' : 'pixels'} written${r.vsync ? ` · ${n0(st.frames)} frames` : ''}` : ''}`;
      },
    };
  }

  destroy(): void {
    this.off.forEach((f) => f());
    if (this.open) undockPane(this.ed, 'screens');
  }
}

const panels = new WeakMap<Editor, ScreensPanel>();

registerEditorPlugin((ed) => {
  const p = new ScreensPanel(ed);
  panels.set(ed, p);
  const paint = () => p.paint();
  ed.paintHooks.add(paint);
  return () => {
    ed.paintHooks.delete(paint);
    p.destroy();
    panels.delete(ed);
  };
});

registerToolbarAction({
  id: 'screens', title: 'Screens panel: every console, screen and switch bank in this chip and the chips it places, live', icon: 'screen', label: 'Screens', order: 63,
  run: (ed) => panels.get(ed)?.toggle(),
  enabled: (ed) => !!panels.get(ed)?.open || !!panels.get(ed)?.hasAny,
  active: (ed) => !!panels.get(ed)?.open,
});
