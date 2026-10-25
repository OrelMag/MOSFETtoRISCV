// State-machine chips in the sandbox (plugin): the machine beside the canvas (a diagram to draw on: states dragged,
// added, arcs drawn from state to state; the selection's properties; the encodings and what each costs; the
// read-back of the built circuit), a banner on the canvas (Detach, Hide), New chip ▾ State machine. Every edit is
// one undo step that redraws the chip and its two table chips (fsmchip.ts). While the chip runs, the diagram lights
// the state its flip-flops hold.

import '../styles/editor-table.css';
import '../styles/editor-fsm.css';
import { fsmDiagram } from '../view/fsmdiagram';
import { readbackOk, readFsm, fsmStateOf } from '../sim/fsmread';
import { simulate } from '../sim/harness';
import { h } from '../ui/dom';
import { type Editor, registerEditorPlugin, registerNewChipKind } from './editor';
import type { FsmDoc } from './model';
import {
  arcLabel, arcOf, condText, detachFsm, type Encoding, encodingCosts, FSM_MAX_IN, FSM_MAX_OUT, FSM_MAX_STATES, fsmWarnings, newFsmChip, setFsm, specOf,
} from './fsmchip';

const HIDDEN_KEY = 'mosfet2riscv:fsm-hidden';
const load = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };

const ENC_LABEL: Record<Encoding, string> = { binary: 'Binary', gray: 'Gray', onehot: 'One-hot' };
type Tool = 'select' | 'state' | 'arc';
type Sel = { kind: 'state'; i: number } | { kind: 'arc'; i: number } | null;

const IN_NAMES = ['x', 'en', 'a', 'b', 'c', 'd', 'go', 'stop'];
const OUT_NAMES = ['y', 'z', 'done', 'busy', 'p', 'q', 'u', 'v'];
const nextName = (taken: string[], pool: string[], base: string) => pool.find((x) => !taken.includes(x)) ?? `${base}${taken.length}`;

class FsmUi {
  readonly pane: HTMLElement;
  private readonly body: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly unsub: () => void;
  private readonly paint = () => this.markLive();
  private hidden = new Set<string>(JSON.parse(load(HIDDEN_KEY) ?? '[]') as string[]);
  private tool: Tool = 'select';
  private sel: Sel = null;
  private arcFrom: number | null = null;
  private key = '';
  private diagram: ReturnType<typeof fsmDiagram> | null = null;
  private live = -1;
  /** Read-back verdicts by machine (JSON), so a redraw does not simulate again. */
  private checks = new Map<string, { ok: boolean; why?: string }>();

  constructor(readonly ed: Editor) {
    this.body = h('div', { class: 'fsm-body' });
    this.pane = h('div', { class: 'fsm-pane', hidden: true, role: 'region', 'aria-label': 'State machine' }, this.body);
    this.banner = h('div', { class: 'hdl-banner fsm-banner', hidden: true });
    ed.slots.left.append(this.pane);
    ed.slots.overlay.append(this.banner);
    this.pane.addEventListener('keydown', (e) => this.onKey(e));
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
    const key = JSON.stringify([id, doc, this.tool, this.sel, this.arcFrom]);
    if (key === this.key || this.pane.hidden) return;
    this.key = key;
    this.render(id, doc);
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
      ([['select', 'Select', 'Click a state or an arc; drag a state to move it'], ['state', '+ State', 'Click the diagram to add a state there'], ['arc', 'Arc', 'Click the state it leaves, then the state it enters (the same one for a loop)']] as const)
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

    this.body.replaceChildren(head, pins, tools,
      h('div', { class: 'fsm-canvas' }, svg, hint ? h('div', { class: 'fsm-hint' }, hint) : null),
      this.props(doc), h('div', { class: 'fsm-sec' }, h('span', { class: 'tt-lbl' }, 'Encoding · each one built and counted'), encs, opts), status);
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

  /** Pointer handling on the diagram: states selected / dragged / joined by an arc, arcs selected, states added. */
  private wireDiagram(svg: SVGSVGElement, doc: FsmDoc): void {
    const pt = (e: PointerEvent): [number, number] => {
      // the drawing on screen now (a drag's preview replaces it)
      const m = (this.body.querySelector<SVGSVGElement>('.fsm-canvas svg') ?? svg).getScreenCTM();
      if (!m) return [0, 0];
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
      return [Math.round(p.x), Math.round(p.y)];
    };
    const states = [...svg.querySelectorAll<SVGGElement>('g.fsm-st')];
    states.forEach((g, i) => {
      g.setAttribute('role', 'button');
      g.setAttribute('tabindex', '0');
      g.setAttribute('aria-label', `State ${doc.states[i].name}${i === doc.reset ? ' (reset)' : ''}`);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.pickState(doc, i); } });
      g.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (this.tool !== 'select') { this.pickState(doc, i); return; }
        this.sel = { kind: 'state', i };
        const start = pt(e), at0 = doc.states[i].at;
        let moved: [number, number] | null = null;
        g.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
          const p = pt(ev);
          const nx = Math.max(36, at0[0] + p[0] - start[0]), ny = Math.max(36, at0[1] + p[1] - start[1]);
          if (!moved && Math.hypot(nx - at0[0], ny - at0[1]) < 3) return;
          moved = [nx, ny];
          g.setAttribute('transform', `translate(${nx - at0[0]},${ny - at0[1]})`);
        };
        const up = () => {
          g.removeEventListener('pointermove', move);
          g.removeEventListener('pointerup', up);
          if (moved) this.apply({ ...doc, states: doc.states.map((s, k) => (k === i ? { ...s, at: moved! } : s)) });
          else this.sync();
        };
        g.addEventListener('pointermove', move);
        g.addEventListener('pointerup', up);
      });
    });
    // arcs: their wide invisible hit paths, in doc order (specOf adds no others without `implicit`)
    // Dragged: an arc bends (a self-loop turns), a label moves; double-click puts either back where it was drawn.
    const hand = (i: number, e: PointerEvent, what: 'curve' | 'label') => {
      e.stopPropagation();
      if (this.tool !== 'select') return;
      this.sel = { kind: 'arc', i };
      const a = doc.arcs[i], start = pt(e);
      const A = doc.states[a.from].at, B = doc.states[a.to].at;
      const spec0 = specOf(doc).arcs[i];
      let moved: FsmDoc | null = null;
      const move = (ev: PointerEvent) => {
        const p = pt(ev);
        if (!moved && Math.hypot(p[0] - start[0], p[1] - start[1]) < 3) return;
        let next: FsmDoc['arcs'][number];
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
    const unhand = (i: number, what: 'curve' | 'label') => {
      const { bend: _b, loop: _l, dx: _x, dy: _y, ...rest } = doc.arcs[i];
      const keep = what === 'label' ? { bend: doc.arcs[i].bend, loop: doc.arcs[i].loop } : { dx: doc.arcs[i].dx, dy: doc.arcs[i].dy };
      const a = { ...rest, ...Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined)) };
      this.apply({ ...doc, arcs: doc.arcs.map((x, k) => (k === i ? a : x)) });
    };
    [...svg.querySelectorAll<SVGPathElement>('path.fsm-hit')].forEach((p, i) => {
      p.addEventListener('pointerdown', (e) => hand(i, e, 'curve'));
      p.addEventListener('dblclick', () => unhand(i, 'curve'));
    });
    // labels: one per arc that has one, in arc order
    const labelled = doc.arcs.map((a, i) => [arcLabel(doc, a), i] as const).filter(([l]) => l).map(([, i]) => i);
    [...svg.querySelectorAll<SVGTextElement>('text.fsm-al')].slice(-labelled.length || 0).forEach((t, k) => {
      if (!labelled.length) return;
      const i = labelled[k];
      t.classList.add('fsm-drag');
      t.addEventListener('pointerdown', (e) => hand(i, e, 'label'));
      t.addEventListener('dblclick', () => unhand(i, 'label'));
    });
    svg.addEventListener('pointerdown', (e) => {
      if (this.tool === 'state') {
        const [x, y] = pt(e);
        if (doc.states.length >= FSM_MAX_STATES) return void this.ed.toast(`At most ${FSM_MAX_STATES} states`, 'err');
        let k = doc.states.length;
        while (doc.states.some((s) => s.name === `S${k}`)) k++;
        this.sel = { kind: 'state', i: doc.states.length };
        this.tool = 'select';
        this.apply({ ...doc, states: [...doc.states, { name: `S${k}`, at: [Math.max(36, x), Math.max(36, y)] }] });
      } else if (this.tool === 'select' && this.sel) { this.sel = null; this.sync(); }
    });
  }

  private pickState(doc: FsmDoc, i: number): void {
    if (this.tool === 'arc') {
      if (this.arcFrom === null) { this.arcFrom = i; this.sync(); return; }
      const from = this.arcFrom;
      this.arcFrom = null;
      this.tool = 'select';
      this.sel = { kind: 'arc', i: doc.arcs.length };
      // the first input combination no arc out of its state takes yet (else, like a new arc, x = 1)
      const n = doc.ins.length;
      const free = Array.from({ length: 1 << n }, (_, c) => doc.ins.map((_, k) => (c >> (n - 1 - k)) & 1)).find((inp) => arcOf(doc, from, inp) < 0);
      const when: Record<string, 0 | 1> = free ? Object.fromEntries(doc.ins.map((x, k) => [x, free[k] as 0 | 1])) : n ? { [doc.ins[0]]: 1 } : {};
      this.apply({ ...doc, arcs: [...doc.arcs, { from, to: i, when }] });
      return;
    }
    this.sel = { kind: 'state', i };
    this.sync();
  }

  private deleteSel(): void {
    const doc = this.doc, sel = this.sel;
    if (!doc || !sel) return;
    if (sel.kind === 'arc') { this.sel = null; this.apply({ ...doc, arcs: doc.arcs.filter((_, k) => k !== sel.i) }); return; }
    if (doc.states.length <= 1) return void this.ed.toast('A machine keeps at least one state', 'err');
    const i = sel.i, re = (s: number) => (s > i ? s - 1 : s);
    this.sel = null;
    this.apply({
      ...doc, states: doc.states.filter((_, k) => k !== i),
      arcs: doc.arcs.filter((a) => a.from !== i && a.to !== i).map((a) => ({ ...a, from: re(a.from), to: re(a.to) })),
      reset: doc.reset === i ? 0 : re(doc.reset),
    });
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest('input, select, textarea')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) { e.preventDefault(); e.stopPropagation(); this.deleteSel(); }
    else if (e.key === 'Escape' && (this.arcFrom !== null || this.tool !== 'select')) { e.stopPropagation(); this.arcFrom = null; this.tool = 'select'; this.sync(); }
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
      const s = doc.states[sel.i], i = sel.i;
      const name = h('input', { class: 'tt-pin', value: s.name, size: Math.max(3, s.name.length), 'aria-label': 'State name' }) as HTMLInputElement;
      name.addEventListener('change', () => {
        const v = name.value.trim().slice(0, 24);
        if (!v || doc.states.some((t, k) => k !== i && t.name === v)) { name.value = s.name; return void this.ed.toast('State names are unique and not empty', 'err'); }
        this.apply({ ...doc, states: doc.states.map((t, k) => (k === i ? { ...t, name: v } : t)) });
      });
      return h('div', { class: 'fsm-sec fsm-props' },
        h('div', { class: 'fsm-row' }, h('span', { class: 'tt-lbl' }, 'State'), name,
          i === doc.reset ? h('span', { class: 'fsm-tag' }, 'reset state') : h('button', { class: 'btn sm', title: 'rst and power-on lead here', onclick: () => this.apply({ ...doc, reset: i }) }, 'Make reset state')),
        outChecks(s.out, (out) => this.apply({ ...doc, states: doc.states.map((t, k) => (k === i ? { ...t, out: out.length ? out : undefined } : t)) }), 'Moore'),
        h('p', { class: 'tt-note' }, 'Moore outputs hold for the whole time the machine is in this state.'));
    }
    const a = doc.arcs[sel.i], k = sel.i;
    const setArc = (next: FsmDoc['arcs'][number]) => this.apply({ ...doc, arcs: doc.arcs.map((x, j) => (j === k ? next : x)) });
    const sameFrom = doc.arcs.map((x, j) => [x, j] as const).filter(([x]) => x.from === a.from);
    const pos = sameFrom.findIndex(([, j]) => j === k);
    const earlier = () => {
      const j = sameFrom[pos - 1][1];
      const arcs = [...doc.arcs];
      [arcs[j], arcs[k]] = [arcs[k], arcs[j]];
      this.sel = { kind: 'arc', i: j };
      this.apply({ ...doc, arcs });
    };
    return h('div', { class: 'fsm-sec fsm-props' },
      h('div', { class: 'fsm-row' }, h('span', { class: 'tt-lbl' }, 'Arc'), h('code', null, `${doc.states[a.from].name} → ${doc.states[a.to].name}`),
        h('code', { class: 'fsm-lab' }, arcLabel(doc, a)),
        sameFrom.length > 1 ? h('span', { class: 'tt-note' }, `checked ${pos + 1} of ${sameFrom.length}`) : null,
        pos > 0 ? h('button', { class: 'btn sm', title: 'Check this arc before the one above it (the first that matches wins)', onclick: earlier }, '↑ Earlier') : null),
      doc.ins.length ? h('div', { class: 'fsm-row fsm-when' }, h('span', { class: 'tt-lbl' }, 'When'),
        doc.ins.map((x) => h('span', { class: 'fsm-in' }, h('code', null, x),
          h('div', { class: 'hdl-seg', role: 'radiogroup', 'aria-label': `${x} for this arc` }, ([[0, '0'], [1, '1'], [undefined, 'either']] as const).map(([val, t]) => {
            const on = a.when[x] === val;
            return h('button', {
              class: on ? 'on' : '', role: 'radio', 'aria-checked': String(on),
              onclick: () => { if (on) return; const when = { ...a.when }; if (val === undefined) delete when[x]; else when[x] = val; setArc({ ...a, when }); },
            }, t);
          }))))) : h('p', { class: 'tt-note' }, 'No inputs: the arc is always taken.'),
      outChecks(a.out, (out) => setArc({ ...a, out: out.length ? out : undefined }), 'Mealy'),
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
        : { ...doc, outs: doc.outs.map((x, i) => (i === k ? v : x)), states: doc.states.map((s) => ({ ...s, out: ren(s.out) })), arcs: doc.arcs.map((a) => ({ ...a, out: ren(a.out) })) });
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = name; inp.blur(); } });
    const removable = side === 'in' || doc.outs.length > 1;
    const remove = () => this.apply(side === 'in'
      ? { ...doc, ins: doc.ins.filter((x) => x !== name), arcs: doc.arcs.map((a) => { const { [name]: _n, ...when } = a.when; return { ...a, when }; }) }
      : { ...doc, outs: doc.outs.filter((x) => x !== name), states: doc.states.map((s) => ({ ...s, out: s.out?.filter((x) => x !== name) })), arcs: doc.arcs.map((a) => ({ ...a, out: a.out?.filter((x) => x !== name) })) });
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
