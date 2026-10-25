// State-machine chips in the sandbox (plugin): the machine beside the canvas (a diagram to draw on, the selection's
// properties, the encodings and what each costs, the read-back of the built circuit), a banner on the canvas
// (Detach, Hide), New chip ▾ State machine. Every edit is one undo step that redraws the chip and its two table chips
// (fsmchip.ts). While the chip runs, the diagram lights the state its flip-flops hold.
//
// The diagram: states dragged (snapped to the grid) and nudged with the arrows; an arc drawn by dragging from a
// state's rim to another state (or itself), or with the Arc tool; arcs bent, loops turned and labels moved by dragging
// (double-click resets); a state renamed in place (double-click, F2); a right-click menu on a state, an arc or the
// empty diagram. The pane resizes from its edge and expands to put the diagram beside its properties.

import '../styles/editor-table.css';
import '../styles/editor-fsm.css';
import { fsmDiagram } from '../view/fsmdiagram';
import { readbackOk, readFsm, fsmStateOf } from '../sim/fsmread';
import { simulate } from '../sim/harness';
import { h, s } from '../ui/dom';
import { type MenuEntry, showMenu } from './ctxmenu';
import { type Editor, registerEditorPlugin, registerNewChipKind } from './editor';
import type { FsmDoc } from './model';
import {
  arcLabel, arcOf, condText, detachFsm, type Encoding, encodingCosts, FSM_MAX_IN, FSM_MAX_OUT, FSM_MAX_STATES, fsmWarnings, newFsmChip, setFsm, specOf,
} from './fsmchip';

const HIDDEN_KEY = 'mosfet2riscv:fsm-hidden';
const WIDTH_KEY = 'mosfet2riscv:fsm-width';
const WIDE_KEY = 'mosfet2riscv:fsm-wide';
const load = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };

const ENC_LABEL: Record<Encoding, string> = { binary: 'Binary', gray: 'Gray', onehot: 'One-hot' };
type Tool = 'select' | 'state' | 'arc';
type Sel = { kind: 'state'; i: number } | { kind: 'arc'; i: number } | null;
type Arc = FsmDoc['arcs'][number];

const IN_NAMES = ['x', 'en', 'a', 'b', 'c', 'd', 'go', 'stop'];
const OUT_NAMES = ['y', 'z', 'done', 'busy', 'p', 'q', 'u', 'v'];
const nextName = (taken: string[], pool: string[], base: string) => pool.find((x) => !taken.includes(x)) ?? `${base}${taken.length}`;
/** State circles' radius in diagram units (view/fsmdiagram.ts), and the grid states snap to. */
const R = 30, GRID = 10;
const snap = (v: number) => Math.max(40, Math.round(v / GRID) * GRID);

class FsmUi {
  readonly pane: HTMLElement;
  private readonly body: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly unsub: () => void;
  private readonly paint = () => this.markLive();
  private hidden = new Set<string>(JSON.parse(load(HIDDEN_KEY) ?? '[]') as string[]);
  private wide = load(WIDE_KEY) === '1';
  private tool: Tool = 'select';
  private sel: Sel = null;
  private arcFrom: number | null = null;
  private key = '';
  private diagram: ReturnType<typeof fsmDiagram> | null = null;
  private live = -1;
  /** The last press (what, when): a second one soon after is a double-click, though the first redrew the diagram. */
  private lastTap = { key: '', t: 0 };
  /** Read-back verdicts by machine (JSON), so a redraw does not simulate again. */
  private checks = new Map<string, { ok: boolean; why?: string }>();

  constructor(readonly ed: Editor) {
    this.body = h('div', { class: 'fsm-body' });
    const grip = h('div', { class: 'fsm-grip', role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' });
    this.pane = h('div', { class: 'fsm-pane', hidden: true, role: 'region', 'aria-label': 'State machine' }, this.body, grip);
    const w = Number(load(WIDTH_KEY));
    if (w >= 320) this.pane.style.width = `${w}px`;
    this.pane.classList.toggle('wide', this.wide);
    this.banner = h('div', { class: 'hdl-banner fsm-banner', hidden: true });
    ed.slots.left.append(this.pane);
    ed.slots.overlay.append(this.banner);
    this.pane.addEventListener('keydown', (e) => this.onKey(e));
    grip.addEventListener('pointerdown', (e) => this.resize(e));
    this.unsub = ed.onChange(() => this.sync());
    ed.paintHooks.add(this.paint);
    this.sync();
  }

  destroy(): void {
    this.unsub();
    this.ed.paintHooks.delete(this.paint);
    this.pane.remove();
    this.banner.remove();
  }

  private get doc(): FsmDoc | undefined { return this.ed.ws.chips[this.ed.chipId]?.fsm; }

  sync(): void {
    const doc = this.doc, id = this.ed.chipId;
    this.banner.hidden = !doc;
    this.pane.hidden = !doc || this.hidden.has(id);
    if (!doc) { this.key = ''; this.diagram = null; return; }
    this.renderBanner(id);
    if (this.sel && (this.sel.kind === 'state' ? !doc.states[this.sel.i] : !doc.arcs[this.sel.i])) this.sel = null;
    const key = JSON.stringify([id, doc, this.tool, this.sel, this.arcFrom, this.wide]);
    if (key === this.key || this.pane.hidden) return;
    this.key = key;
    const focused = this.pane.contains(document.activeElement);
    this.render(id, doc);
    // keep the keyboard in the pane across the redraw an edit causes
    if (focused && !this.pane.contains(document.activeElement)) this.body.querySelector<HTMLElement>('.fsm-canvas')?.focus();
  }

  private renderBanner(id: string): void {
    const hidden = this.hidden.has(id);
    this.banner.replaceChildren(
      h('span', { class: 'hdl-badge fsm-badge-tag' }, 'FSM'),
      h('span', { class: 'grow' }, 'Drawn from its ', h('b', null, 'state machine'), ' · edit the diagram to change it; double-click a block for its table'),
      h('button', { class: 'btn sm', title: 'Keep the drawing as an ordinary chip; its two tables become ordinary truth-table chips', onclick: () => this.detach() }, 'Detach as drawn chip'),
      h('button', { class: 'btn sm', onclick: () => this.toggleHidden(id) }, hidden ? 'Show machine' : 'Hide machine'));
  }

  private toggleHidden(id: string): void {
    if (this.hidden.has(id)) this.hidden.delete(id); else this.hidden.add(id);
    save(HIDDEN_KEY, JSON.stringify([...this.hidden]));
    this.key = '';
    this.sync();
  }

  private toggleWide(): void {
    this.wide = !this.wide;
    save(WIDE_KEY, this.wide ? '1' : '0');
    this.pane.classList.toggle('wide', this.wide);
    this.sync();
  }

  private resize(e: PointerEvent): void {
    e.preventDefault();
    const x0 = e.clientX, w0 = this.pane.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => { this.pane.style.width = `${Math.max(320, Math.min(innerWidth * 0.85, w0 + ev.clientX - x0))}px`; };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      save(WIDTH_KEY, String(Math.round(this.pane.getBoundingClientRect().width)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private detach(): void {
    const name = this.ed.doc.name;
    this.ed.editWs((ws) => detachFsm(ws, this.ed.chipId));
    this.ed.toast(`${name} is an ordinary drawn chip now (Ctrl+Z puts the machine back)`);
  }

  /** One undo step: the machine and its three chips redrawn. */
  private apply(next: FsmDoc): void {
    const id = this.ed.chipId;
    if (next === this.doc) return;
    let err: string | null = null;
    this.ed.editWs((ws) => {
      const r = setFsm(ws, id, next);
      if ('error' in r) { err = r.error; return ws; }
      return r;
    });
    if (err) { this.ed.toast(`State machine: ${err}`, 'err'); this.key = ''; this.sync(); }
  }

  private tapped(key: string): boolean {
    const now = performance.now(), twice = this.lastTap.key === key && now - this.lastTap.t < 450;
    this.lastTap = { key, t: twice ? 0 : now };
    return twice;
  }

  // ---- edits ------------------------------------------------------------------------------------------

  private addState(doc: FsmDoc, at: [number, number]): void {
    if (doc.states.length >= FSM_MAX_STATES) return void this.ed.toast(`At most ${FSM_MAX_STATES} states`, 'err');
    let k = doc.states.length;
    while (doc.states.some((s) => s.name === `S${k}`)) k++;
    this.sel = { kind: 'state', i: doc.states.length };
    this.tool = 'select';
    this.apply({ ...doc, states: [...doc.states, { name: `S${k}`, at: [snap(at[0]), snap(at[1])] }] });
  }

  /** A spot for a new state: right of the others, on the grid. */
  private freeSpot(doc: FsmDoc): [number, number] {
    const xs = doc.states.map((s) => s.at[0]), ys = doc.states.map((s) => s.at[1]);
    return [Math.max(...xs, 0) + 120, ys.length ? Math.round(ys.reduce((a, b) => a + b, 0) / ys.length) : 100];
  }

  private addArc(doc: FsmDoc, from: number, to: number): void {
    this.arcFrom = null;
    this.tool = 'select';
    this.sel = { kind: 'arc', i: doc.arcs.length };
    // the first input combination no arc out of its state takes yet (else, like a new arc, x = 1)
    const n = doc.ins.length;
    const free = Array.from({ length: 1 << n }, (_, c) => doc.ins.map((_, k) => (c >> (n - 1 - k)) & 1)).find((inp) => arcOf(doc, from, inp) < 0);
    const when: Record<string, 0 | 1> = free ? Object.fromEntries(doc.ins.map((x, k) => [x, free[k] as 0 | 1])) : n ? { [doc.ins[0]]: 1 } : {};
    this.apply({ ...doc, arcs: [...doc.arcs, { from, to, when }] });
  }

  private setArc(doc: FsmDoc, i: number, a: Arc): void { this.apply({ ...doc, arcs: doc.arcs.map((x, k) => (k === i ? a : x)) }); }

  private deleteState(doc: FsmDoc, i: number): void {
    if (doc.states.length <= 1) return void this.ed.toast('A machine keeps at least one state', 'err');
    const re = (s: number) => (s > i ? s - 1 : s);
    this.sel = null;
    this.apply({
      ...doc, states: doc.states.filter((_, k) => k !== i),
      arcs: doc.arcs.filter((a) => a.from !== i && a.to !== i).map((a) => ({ ...a, from: re(a.from), to: re(a.to) })),
      reset: doc.reset === i ? 0 : re(doc.reset),
    });
  }

  private deleteSel(): void {
    const doc = this.doc, sel = this.sel;
    if (!doc || !sel) return;
    if (sel.kind === 'arc') { this.sel = null; this.apply({ ...doc, arcs: doc.arcs.filter((_, k) => k !== sel.i) }); return; }
    this.deleteState(doc, sel.i);
  }

  /** Swap arc i with the one before (−1) or after (+1) it among the arcs out of the same state: the first match wins. */
  private reorder(doc: FsmDoc, i: number, dir: -1 | 1): void {
    const same = doc.arcs.map((x, j) => [x, j] as const).filter(([x]) => x.from === doc.arcs[i].from).map(([, j]) => j);
    const p = same.indexOf(i), j = same[p + dir];
    if (j === undefined) return;
    const arcs = [...doc.arcs];
    [arcs[j], arcs[i]] = [arcs[i], arcs[j]];
    this.sel = { kind: 'arc', i: j };
    this.apply({ ...doc, arcs });
  }

  /** Clear an arc's hand placement: its curve (bend, loop), its label (dx, dy), or both. */
  private unhand(doc: FsmDoc, i: number, what: 'curve' | 'label' | 'all'): void {
    const { bend, loop, dx, dy, ...rest } = doc.arcs[i];
    const keep = what === 'label' ? { bend, loop } : what === 'curve' ? { dx, dy } : {};
    this.setArc(doc, i, { ...rest, ...Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined)) });
  }

  // ---- the read-back ----------------------------------------------------------------------------------

  private verdict(doc: FsmDoc): { ok: boolean; why?: string } {
    const k = JSON.stringify(doc);
    let v = this.checks.get(k);
    if (v) return v;
    try {
      const def = this.ed.lib.defOf(this.ed.chipId);
      if (!def) v = { ok: false, why: 'the chip does not compile' };
      else {
        const r = readFsm(simulate(def), specOf(doc, true));
        const bad = r.arcs.find((a) => !a.ok);
        v = readbackOk(r) ? { ok: true } : { ok: false, why: bad ? `from ${r.states[bad.from].name} on ${JSON.stringify(bad.inp)}` : 'a state appears twice' };
      }
    } catch (e) {
      v = { ok: false, why: String(e) };
    }
    if (this.checks.size > 50) this.checks.clear();
    this.checks.set(k, v);
    return v;
  }

  /** While the chip runs: the state its flip-flops hold. */
  private markLive(): void {
    const doc = this.doc, sim = this.ed.sim.sim;
    if (!doc || !this.diagram || !sim) return;
    let cur = -1;
    try { cur = fsmStateOf(sim, specOf(doc)); } catch { cur = -1; }
    if (cur === this.live) return;
    this.live = cur;
    this.mark();
  }

  private mark(): void {
    this.diagram?.mark({
      cur: this.live >= 0 ? this.live : undefined,
      hoverState: this.sel?.kind === 'state' ? this.sel.i : this.arcFrom ?? undefined,
      hoverArc: this.sel?.kind === 'arc' ? this.sel.i : undefined,
    });
  }

  // ---- drawing ------------------------------------------------------------------------------------------

  private render(id: string, doc: FsmDoc): void {
    const head = h('div', { class: 'tt-head' }, h('span', { class: 'tt-title' }, 'State machine'), h('span', { class: 'grow' }),
      h('button', { class: `btn sm${this.wide ? ' on' : ''}`, 'aria-pressed': String(this.wide), title: this.wide ? 'Back to a narrow pane' : 'A wide pane: the diagram large, its properties beside it', onclick: () => this.toggleWide() }, this.wide ? 'Narrow' : 'Expand'),
      h('button', { class: 'btn sm', title: 'Hide the machine (the banner shows it again)', 'aria-label': 'Hide the machine', onclick: () => this.toggleHidden(id) }, '◂'));

    const pins = h('div', { class: 'tt-pins' },
      h('div', { class: 'tt-pinrow' }, h('span', { class: 'tt-lbl' }, 'Inputs'),
        doc.ins.map((name, i) => this.pinField(doc, 'in', i, name)),
        h('button', { class: 'btn sm', disabled: doc.ins.length >= FSM_MAX_IN, onclick: () => this.apply({ ...doc, ins: [...doc.ins, nextName([...doc.ins, ...doc.outs], IN_NAMES, 'i')] }) }, '+ Input')),
      h('div', { class: 'tt-pinrow' }, h('span', { class: 'tt-lbl' }, 'Outputs'),
        doc.outs.map((name, j) => this.pinField(doc, 'out', j, name)),
        h('button', { class: 'btn sm', disabled: doc.outs.length >= FSM_MAX_OUT, onclick: () => this.apply({ ...doc, outs: [...doc.outs, nextName([...doc.ins, ...doc.outs], OUT_NAMES, 'o')] }) }, '+ Output')),
      h('p', { class: 'tt-note' }, 'The chip also gets rst (synchronous: back to the reset state) and clk.'));

    const tools = h('div', { class: 'fsm-tools', role: 'toolbar', 'aria-label': 'Diagram tools' },
      ([['select', 'Select', 'Click a state or an arc; drag a state to move it, its rim to draw an arc'], ['state', '+ State', 'Click the diagram to add a state there (N, or double-click)'], ['arc', 'Arc', 'Click the state it leaves, then the state it enters (A; or drag from a state\'s rim)']] as const)
        .map(([t, label, title]) => h('button', { class: `btn sm${this.tool === t ? ' on' : ''}`, 'aria-pressed': String(this.tool === t), title, onclick: () => { this.tool = t; this.arcFrom = null; this.sync(); } }, label)),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', disabled: !this.sel, title: 'Delete the selection (Delete)', onclick: () => this.deleteSel() }, 'Delete'));

    const spec = specOf(doc);
    this.diagram = fsmDiagram(spec);
    const svg = this.diagram.el;
    svg.classList.add('fsm-edit', `tool-${this.tool}`);
    this.wireDiagram(svg, doc);
    this.mark();
    const hint = this.tool === 'arc' ? (this.arcFrom === null ? 'Arc: click the state it leaves' : `Arc from ${doc.states[this.arcFrom].name}: click the state it enters`)
      : this.tool === 'state' ? 'Click an empty spot to add a state' : '';
    const canvas = h('div', { class: 'fsm-canvas', tabindex: 0, 'aria-label': 'State diagram: arrows move the selected state, Delete removes it, N adds a state, A draws an arc, F2 renames' },
      svg, hint ? h('div', { class: 'fsm-hint' }, hint) : null);

    const costs = encodingCosts(doc);
    const best = Math.min(...costs.filter((c) => !c.problem).map((c) => c.nands));
    const encs = h('div', { class: 'fsm-encs', role: 'radiogroup', 'aria-label': 'State encoding' }, costs.map((c) => h('button', {
      class: `fsm-enc${doc.encoding === c.enc ? ' on' : ''}`, role: 'radio', 'aria-checked': String(doc.encoding === c.enc), disabled: !!c.problem,
      title: c.problem ?? `${c.dffs} flip-flops, ${c.logic} NANDs of logic (next state, outputs, reset), ${c.nands} NANDs in all`,
      onclick: () => doc.encoding !== c.enc && this.apply({ ...doc, encoding: c.enc }),
    }, h('b', null, ENC_LABEL[c.enc], doc.encoding === c.enc ? ' ✓' : ''),
      c.problem ? h('span', null, 'too wide') : [h('span', { class: 'mono' }, `${c.dffs} DFF · ${c.logic} NAND`), h('span', { class: c.nands === best ? 'best' : '' }, `${c.nands} in all${c.nands === best ? ' · least' : ''}`)])));

    const seg = (label: string, opts: [string, string, boolean, () => void][]) => h('div', { class: 'fsm-row' }, h('span', { class: 'tt-lbl' }, label),
      h('div', { class: 'hdl-seg' }, opts.map(([t, title, on, go]) => h('button', { class: on ? 'on' : '', 'aria-pressed': String(on), title, onclick: () => !on && go() }, t))));
    const opts = h('div', { class: 'fsm-opts' },
      seg('Logic', ([['nand', 'NAND', 'NAND–NAND: only NANDs and inverters'], ['andor', 'AND–OR', 'AND, OR and NOT gates'],
        ['pla', 'PLA', 'Both tables as programmable logic arrays'], ['rom', 'ROM', 'Both tables stored as ROMs: the next state looked up, a microprogrammed controller']] as const)
        .map(([f, t, title]): [string, string, boolean, () => void] => [t, title, doc.form === f, () => this.apply({ ...doc, form: f })])),
      seg('Unused codes', [['Don’t care', 'Cheapest: the minimizer may send them anywhere', !doc.safe, () => { const { safe: _s, ...d } = doc; this.apply(d); }], ['Go to reset', 'Safe: a code no state has leads back to the reset state', !!doc.safe, () => this.apply({ ...doc, safe: true })]]));

    const warns = fsmWarnings(doc);
    const v = this.verdict(doc);
    const status = h('div', { class: 'fsm-status' },
      warns.map((w) => h('div', { class: 'warn' }, '⚠ ', w)),
      h('div', { class: v.ok ? 'ok' : 'bad' }, v.ok ? `✓ Read back from the circuit: ${doc.states.length} states, every arc as drawn` : `✕ The circuit differs from the diagram${v.why ? `: ${v.why}` : ''}`));

    this.body.replaceChildren(head, pins,
      h('div', { class: 'fsm-main' },
        h('div', { class: 'fsm-left' }, tools, canvas,
          h('p', { class: 'tt-note fsm-keys' }, 'Drag a state’s rim to another state for an arc · double-click empty space for a state, a state to rename it · right-click for more')),
        h('div', { class: 'fsm-right' }, this.props(doc),
          h('div', { class: 'fsm-sec' }, h('span', { class: 'tt-lbl' }, 'Encoding · each one built and counted'), encs, opts), status)));
  }

  /** A drag in progress: the diagram drawn from the machine as it would be, nothing committed. */
  private preview(doc: FsmDoc): void {
    const old = this.body.querySelector<SVGSVGElement>('.fsm-canvas svg');
    if (!old) return;
    const d = fsmDiagram(specOf(doc));
    d.el.classList.add('fsm-edit', 'tool-select');
    old.replaceWith(d.el);
    this.diagram = d;
    this.mark();
  }

  /** Pointer handling on the diagram. */
  private wireDiagram(svg: SVGSVGElement, doc: FsmDoc): void {
    const pt = (e: { clientX: number; clientY: number }): [number, number] => {
      // the drawing on screen now (a drag's preview replaces it)
      const m = (this.body.querySelector<SVGSVGElement>('.fsm-canvas svg') ?? svg).getScreenCTM();
      if (!m) return [0, 0];
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
      return [Math.round(p.x), Math.round(p.y)];
    };
    const stateAt = (p: [number, number]) => doc.states.findIndex((st) => Math.hypot(st.at[0] - p[0], st.at[1] - p[1]) <= R + 4);

    // A ring around each state, under it: dragging from the rim draws an arc (a rubber band to the pointer).
    const states = [...svg.querySelectorAll<SVGGElement>('g.fsm-st')];
    const firstState = states[0];
    doc.states.forEach((st, i) => {
      const ring = s('circle', { class: 'fsm-rim', cx: st.at[0], cy: st.at[1], r: R + 5 });
      ring.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const band = s('path', { class: 'fsm-band', d: '' });
        svg.append(band);
        const move = (ev: PointerEvent) => {
          const [x, y] = pt(ev);
          band.setAttribute('d', `M${st.at[0]},${st.at[1]} L${x},${y}`);
          const t = stateAt([x, y]);
          states.forEach((g, k) => g.classList.toggle('hover', k === t));
        };
        const up = (ev: PointerEvent) => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          band.remove();
          const t = stateAt(pt(ev));
          if (t >= 0) this.addArc(doc, i, t); else this.sync();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      svg.insertBefore(ring, firstState);
    });

    states.forEach((g, i) => {
      g.setAttribute('role', 'button');
      g.setAttribute('tabindex', '0');
      g.setAttribute('aria-label', `State ${doc.states[i].name}${i === doc.reset ? ' (reset)' : ''}`);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.pickState(doc, i); } });
      g.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.sel = { kind: 'state', i }; this.sync(); this.stateMenu(doc, i, e); });
      g.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        if (this.tool !== 'select') { this.pickState(doc, i); return; }
        if (this.tapped(`s${i}`)) { e.preventDefault(); this.sel = { kind: 'state', i }; this.rename(doc, i); return; }
        this.sel = { kind: 'state', i };
        const start = pt(e), at0 = doc.states[i].at;
        let moved: [number, number] | null = null;
        const move = (ev: PointerEvent) => {
          const p = pt(ev);
          const nx = snap(at0[0] + p[0] - start[0]), ny = snap(at0[1] + p[1] - start[1]);
          if (!moved && Math.hypot(p[0] - start[0], p[1] - start[1]) < 4) return;
          moved = [nx, ny];
          // the arcs follow the state while it moves
          this.preview({ ...doc, states: doc.states.map((s2, k) => (k === i ? { ...s2, at: moved! } : s2)) });
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          if (moved && (moved[0] !== at0[0] || moved[1] !== at0[1])) this.apply({ ...doc, states: doc.states.map((s2, k) => (k === i ? { ...s2, at: moved! } : s2)) });
          else this.sync();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    });

    // Arcs: their wide invisible hit paths, in doc order. Dragged, an arc bends (a self-loop turns), a label moves.
    const hand = (i: number, e: PointerEvent, what: 'curve' | 'label') => {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (this.tool !== 'select') return;
      if (this.tapped(`${what}${i}`)) { this.unhand(doc, i, what); return; }
      this.sel = { kind: 'arc', i };
      const a = doc.arcs[i], start = pt(e);
      const A = doc.states[a.from].at, B = doc.states[a.to].at;
      const spec0 = specOf(doc).arcs[i];
      let moved: FsmDoc | null = null;
      const move = (ev: PointerEvent) => {
        const p = pt(ev);
        if (!moved && Math.hypot(p[0] - start[0], p[1] - start[1]) < 3) return;
        let next: Arc;
        if (what === 'label') next = { ...a, dx: (spec0.dx ?? 0) + p[0] - start[0], dy: (spec0.dy ?? 0) + p[1] - start[1] };
        else if (a.from === a.to) next = { ...a, loop: Math.round((Math.atan2(p[1] - A[1], p[0] - A[0]) * 180) / Math.PI) };
        else {
          // the curve's middle sits at half its bend along the chord's normal
          const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1, nx = -(B[1] - A[1]) / len, ny = (B[0] - A[0]) / len;
          next = { ...a, bend: Math.round(2 * ((p[0] - (A[0] + B[0]) / 2) * nx + (p[1] - (A[1] + B[1]) / 2) * ny)) };
        }
        moved = { ...doc, arcs: doc.arcs.map((x, k) => (k === i ? next : x)) };
        this.preview(moved);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (moved) this.apply(moved); else this.sync();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    const arcMenu = (i: number, e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); this.sel = { kind: 'arc', i }; this.sync(); this.arcMenu(doc, i, e); };
    [...svg.querySelectorAll<SVGPathElement>('path.fsm-hit')].forEach((p, i) => {
      p.addEventListener('pointerdown', (e) => hand(i, e, 'curve'));
      p.addEventListener('contextmenu', (e) => arcMenu(i, e));
    });
    // labels: one per arc that has one, in arc order, after every other label
    const labelled = doc.arcs.map((a, i) => [arcLabel(doc, a), i] as const).filter(([l]) => l).map(([, i]) => i);
    if (labelled.length) {
      [...svg.querySelectorAll<SVGTextElement>('text.fsm-al')].slice(-labelled.length).forEach((t, k) => {
        const i = labelled[k];
        t.classList.add('fsm-drag');
        t.addEventListener('pointerdown', (e) => hand(i, e, 'label'));
        t.addEventListener('contextmenu', (e) => arcMenu(i, e));
      });
    }

    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (this.tool === 'state' || (this.tool === 'select' && this.tapped('bg'))) this.addState(doc, pt(e));
      else if (this.tool === 'select' && this.sel) { this.sel = null; this.sync(); }
    });
    svg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = pt(e);
      showMenu(e.clientX, e.clientY, [
        { label: 'Add a state here', key: 'double-click', run: () => this.addState(doc, p) },
        { label: 'Draw an arc…', key: 'A', run: () => { this.tool = 'arc'; this.arcFrom = null; this.sync(); } },
        null,
        { label: 'Straighten every arc’s placement', run: () => this.apply({ ...doc, arcs: doc.arcs.map(({ bend: _b, loop: _l, dx: _x, dy: _y, ...a }) => a) }), disabled: !doc.arcs.some((a) => a.bend !== undefined || a.loop !== undefined || a.dx !== undefined || a.dy !== undefined) },
        { label: 'Arrange states in a circle', run: () => this.arrange(doc) },
        null,
        { label: this.wide ? 'Narrow pane' : 'Expand pane', run: () => this.toggleWide() },
      ]);
    });
  }

  /** States around a circle, the reset state on the left: a fresh start for a tangled drawing. */
  private arrange(doc: FsmDoc): void {
    const n = doc.states.length, r = Math.max(90, n * 30), cx = r + 70, cy = r + 60;
    const order = [doc.reset, ...doc.states.map((_, i) => i).filter((i) => i !== doc.reset)];
    const at = new Map(order.map((s2, k) => [s2, [snap(cx - r * Math.cos((2 * Math.PI * k) / n)), snap(cy - r * Math.sin((2 * Math.PI * k) / n))] as [number, number]]));
    this.apply({ ...doc, states: doc.states.map((s2, i) => ({ ...s2, at: at.get(i)! })), arcs: doc.arcs.map(({ bend: _b, loop: _l, dx: _x, dy: _y, ...a }) => a) });
  }

  private stateMenu(doc: FsmDoc, i: number, e: MouseEvent): void {
    const st = doc.states[i];
    const items: MenuEntry[] = [
      { label: 'Rename', key: 'F2', run: () => this.rename(doc, i) },
      { label: 'Reset state', checked: i === doc.reset, run: () => i !== doc.reset && this.apply({ ...doc, reset: i }) },
      null,
      { label: 'Arc from here…', key: 'drag rim', run: () => { this.tool = 'arc'; this.arcFrom = i; this.sync(); } },
      { label: 'Loop on itself', run: () => this.addArc(doc, i, i) },
      null,
      ...doc.outs.map((o): MenuEntry => ({
        label: `Moore: ${o} = 1`, checked: !!st.out?.includes(o),
        run: () => {
          const out = st.out?.includes(o) ? st.out.filter((x) => x !== o) : [...(st.out ?? []), o];
          this.apply({ ...doc, states: doc.states.map((t, k) => (k === i ? { ...t, out: out.length ? out : undefined } : t)) });
        },
      })),
      null,
      { label: 'Delete state', key: 'Del', run: () => this.deleteState(doc, i), disabled: doc.states.length <= 1 },
    ];
    showMenu(e.clientX, e.clientY, items);
  }

  private arcMenu(doc: FsmDoc, i: number, e: MouseEvent): void {
    const a = doc.arcs[i];
    const same = doc.arcs.map((x, j) => [x, j] as const).filter(([x]) => x.from === a.from).map(([, j]) => j);
    const p = same.indexOf(i);
    const items: MenuEntry[] = [
      // the condition, one input at a time: 0 → 1 → either
      ...doc.ins.map((x): MenuEntry => {
        const v = a.when[x];
        const nextV = v === 0 ? 1 : v === 1 ? undefined : 0;
        return {
          label: `${x}: ${v === undefined ? 'either' : v} → ${nextV === undefined ? 'either' : nextV}`,
          run: () => { const when = { ...a.when }; if (nextV === undefined) delete when[x]; else when[x] = nextV; this.setArc(doc, i, { ...a, when }); },
        };
      }),
      null,
      ...doc.outs.map((o): MenuEntry => ({
        label: `Mealy: ${o} = 1`, checked: !!a.out?.includes(o),
        run: () => { const out = a.out?.includes(o) ? a.out.filter((x) => x !== o) : [...(a.out ?? []), o]; this.setArc(doc, i, { ...a, out: out.length ? out : undefined }); },
      })),
      null,
      { label: 'Check earlier', run: () => this.reorder(doc, i, -1), disabled: p <= 0 },
      { label: 'Check later', run: () => this.reorder(doc, i, 1), disabled: p < 0 || p >= same.length - 1 },
      { label: 'Reverse direction', run: () => this.setArc(doc, i, { ...a, from: a.to, to: a.from }), disabled: a.from === a.to },
      { label: 'Straight', run: () => this.setArc(doc, i, { ...a, bend: 0 }), disabled: a.from === a.to || a.bend === 0 },
      { label: 'Automatic shape', key: 'double-click', run: () => this.unhand(doc, i, 'all'), disabled: a.bend === undefined && a.loop === undefined && a.dx === undefined && a.dy === undefined },
      null,
      { label: 'Delete arc', key: 'Del', run: () => { this.sel = null; this.apply({ ...doc, arcs: doc.arcs.filter((_, k) => k !== i) }); } },
    ];
    showMenu(e.clientX, e.clientY, items);
  }

  /** Rename state i in place: a field over the state on the diagram. */
  private rename(doc: FsmDoc, i: number): void {
    const canvas = this.body.querySelector<HTMLElement>('.fsm-canvas'), g = this.body.querySelectorAll<SVGGElement>('.fsm-canvas g.fsm-st')[i];
    if (!canvas || !g) return;
    const cr = canvas.getBoundingClientRect(), r = g.getBoundingClientRect();
    const old = doc.states[i].name;
    const inp = h('input', { class: 'fsm-rename', value: old, maxlength: 24, spellcheck: 'false', 'aria-label': `Rename ${old}`,
      style: `left:${r.left - cr.left + r.width / 2 - 45}px;top:${r.top - cr.top + r.height / 2 - 14}px` }) as HTMLInputElement;
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const v = inp.value.trim().slice(0, 24);
      inp.remove();
      if (!keep || !v || v === old) return void canvas.focus();
      if (doc.states.some((t, k) => k !== i && t.name === v)) return void this.ed.toast('State names are unique', 'err');
      this.apply({ ...doc, states: doc.states.map((t, k) => (k === i ? { ...t, name: v } : t)) });
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    canvas.append(inp);
    // after the press that opened it has finished moving the focus
    requestAnimationFrame(() => {
      inp.focus();
      inp.select();
      inp.addEventListener('blur', () => finish(true));
    });
  }

  private pickState(doc: FsmDoc, i: number): void {
    if (this.tool === 'arc') {
      if (this.arcFrom === null) { this.arcFrom = i; this.sync(); return; }
      this.addArc(doc, this.arcFrom, i);
      return;
    }
    this.sel = { kind: 'state', i };
    this.sync();
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const doc = this.doc;
    if (!doc) return;
    const sel = this.sel;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { stop(); this.deleteSel(); }
    else if (e.key === 'Escape' && (this.arcFrom !== null || this.tool !== 'select' || sel)) { stop(); this.arcFrom = null; this.tool = 'select'; this.sel = null; this.sync(); }
    else if (e.key === 'F2' && sel?.kind === 'state') { stop(); this.rename(doc, sel.i); }
    else if (e.key === 'n' || e.key === 'N') { stop(); this.addState(doc, this.freeSpot(doc)); }
    else if (e.key === 'a' || e.key === 'A') { stop(); this.tool = 'arc'; this.arcFrom = sel?.kind === 'state' ? sel.i : null; this.sync(); }
    else if (sel?.kind === 'state' && e.key.startsWith('Arrow')) {
      stop();
      const d = e.shiftKey ? 1 : GRID, st = doc.states[sel.i];
      const [dx, dy] = e.key === 'ArrowLeft' ? [-d, 0] : e.key === 'ArrowRight' ? [d, 0] : e.key === 'ArrowUp' ? [0, -d] : [0, d];
      this.apply({ ...doc, states: doc.states.map((s2, k) => (k === sel.i ? { ...s2, at: [Math.max(40, st.at[0] + dx), Math.max(40, st.at[1] + dy)] } : s2)) });
    }
  }

  /** The selection's properties. */
  private props(doc: FsmDoc): HTMLElement {
    const sel = this.sel;
    if (!sel) return h('div', { class: 'fsm-sec fsm-props' }, h('p', { class: 'tt-note' }, 'Select a state or an arc to set its outputs and conditions. An input combination no arc out of a state takes keeps the machine in that state.'));
    const outChecks = (on: string[] | undefined, set: (out: string[]) => void, what: string) => h('div', { class: 'fsm-row' }, h('span', { class: 'tt-lbl' }, what),
      doc.outs.map((o) => {
        const has = !!on?.includes(o);
        return h('label', { class: 'fsm-check' }, h('input', { type: 'checkbox', checked: has, onchange: () => set(has ? (on ?? []).filter((x) => x !== o) : [...(on ?? []), o]) }), ` ${o} = 1`);
      }));
    if (sel.kind === 'state') {
      const st = doc.states[sel.i], i = sel.i;
      const name = h('input', { class: 'tt-pin', value: st.name, size: Math.max(3, st.name.length), 'aria-label': 'State name' }) as HTMLInputElement;
      name.addEventListener('change', () => {
        const v = name.value.trim().slice(0, 24);
        if (!v || doc.states.some((t, k) => k !== i && t.name === v)) { name.value = st.name; return void this.ed.toast('State names are unique and not empty', 'err'); }
        this.apply({ ...doc, states: doc.states.map((t, k) => (k === i ? { ...t, name: v } : t)) });
      });
      return h('div', { class: 'fsm-sec fsm-props' },
        h('div', { class: 'fsm-row' }, h('span', { class: 'tt-lbl' }, 'State'), name,
          i === doc.reset ? h('span', { class: 'fsm-tag' }, 'reset state') : h('button', { class: 'btn sm', title: 'rst and power-on lead here', onclick: () => this.apply({ ...doc, reset: i }) }, 'Make reset state')),
        outChecks(st.out, (out) => this.apply({ ...doc, states: doc.states.map((t, k) => (k === i ? { ...t, out: out.length ? out : undefined } : t)) }), 'Moore'),
        h('p', { class: 'tt-note' }, 'Moore outputs hold for the whole time the machine is in this state.'));
    }
    const a = doc.arcs[sel.i], k = sel.i;
    const sameFrom = doc.arcs.map((x, j) => [x, j] as const).filter(([x]) => x.from === a.from);
    const pos = sameFrom.findIndex(([, j]) => j === k);
    return h('div', { class: 'fsm-sec fsm-props' },
      h('div', { class: 'fsm-row' }, h('span', { class: 'tt-lbl' }, 'Arc'), h('code', null, `${doc.states[a.from].name} → ${doc.states[a.to].name}`),
        h('code', { class: 'fsm-lab' }, arcLabel(doc, a)),
        sameFrom.length > 1 ? h('span', { class: 'tt-note' }, `checked ${pos + 1} of ${sameFrom.length}`) : null,
        pos > 0 ? h('button', { class: 'btn sm', title: 'Check this arc before the one above it (the first that matches wins)', onclick: () => this.reorder(doc, k, -1) }, '↑ Earlier') : null),
      doc.ins.length ? h('div', { class: 'fsm-row fsm-when' }, h('span', { class: 'tt-lbl' }, 'When'),
        doc.ins.map((x) => h('span', { class: 'fsm-in' }, h('code', null, x),
          h('div', { class: 'hdl-seg', role: 'radiogroup', 'aria-label': `${x} for this arc` }, ([[0, '0'], [1, '1'], [undefined, 'either']] as const).map(([val, t]) => {
            const on = a.when[x] === val;
            return h('button', {
              class: on ? 'on' : '', role: 'radio', 'aria-checked': String(on),
              onclick: () => { if (on) return; const when = { ...a.when }; if (val === undefined) delete when[x]; else when[x] = val; this.setArc(doc, k, { ...a, when }); },
            }, t);
          }))))) : h('p', { class: 'tt-note' }, 'No inputs: the arc is always taken.'),
      outChecks(a.out, (out) => this.setArc(doc, k, { ...a, out: out.length ? out : undefined }), 'Mealy'),
      h('p', { class: 'tt-note' }, `Taken when ${condText(doc, a.when)}. Mealy outputs are 1 while the next edge would take this arc.`));
  }

  private pinField(doc: FsmDoc, side: 'in' | 'out', k: number, name: string): HTMLElement {
    const inp = h('input', { class: 'tt-pin', value: name, size: Math.max(2, name.length), spellcheck: 'false', 'aria-label': `${side === 'in' ? 'Input' : 'Output'} ${k + 1} name` }) as HTMLInputElement;
    inp.addEventListener('change', () => {
      const v = inp.value.trim();
      if (v === name) return;
      const ren = (xs: string[] | undefined) => xs?.map((x) => (x === name ? v : x));
      this.apply(side === 'in'
        ? { ...doc, ins: doc.ins.map((x, i) => (i === k ? v : x)), arcs: doc.arcs.map((a) => ({ ...a, when: Object.fromEntries(Object.entries(a.when).map(([x, b]) => [x === name ? v : x, b])) })) }
        : { ...doc, outs: doc.outs.map((x, i) => (i === k ? v : x)), states: doc.states.map((st) => ({ ...st, out: ren(st.out) })), arcs: doc.arcs.map((a) => ({ ...a, out: ren(a.out) })) });
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = name; inp.blur(); } });
    const removable = side === 'in' || doc.outs.length > 1;
    const remove = () => this.apply(side === 'in'
      ? { ...doc, ins: doc.ins.filter((x) => x !== name), arcs: doc.arcs.map((a) => { const { [name]: _n, ...when } = a.when; return { ...a, when }; }) }
      : { ...doc, outs: doc.outs.filter((x) => x !== name), states: doc.states.map((st) => ({ ...st, out: st.out?.filter((x) => x !== name) })), arcs: doc.arcs.map((a) => ({ ...a, out: a.out?.filter((x) => x !== name) })) });
    return h('span', { class: `tt-pinbox ${side}` }, inp,
      removable ? h('button', { class: 'tt-x', title: side === 'in' ? `Remove ${name} (arcs stop reading it)` : `Remove ${name}`, 'aria-label': `Remove ${name}`, onclick: remove }, '×') : null);
  }
}

registerEditorPlugin((ed) => {
  // also in campaign levels: Check refuses a state-machine chip where the level is one (challenges.ts builderViolations)
  const ui = new FsmUi(ed);
  return () => ui.destroy();
});

registerNewChipKind({
  label: 'State machine', hint: 'draw a state diagram: the circuit is built from it', icon: 'flag',
  run: (ed) => ed.editWs((ws) => newFsmChip(ws).ws),
});
