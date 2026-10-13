// A live state diagram over a scene (view/fsmdiagram.ts): the current state from the state register, the
// arc taken at the last rising edge, the arc the next edge takes with the inputs now (the next-state
// logic's answer, so it moves when an input changes), the states this pass has visited, and optionally a
// ribbon of the last cycles. Hovering an arc lights the gates that make it in the schematic; hovering a
// state shows what it does.

import { fsmArc, type FsmSpec } from '../lib/fsm';
import { fsmInputsOf, fsmStateOf, pathBits } from '../sim/fsmread';
import { pack } from '../sim/values';
import { h } from '../ui/dom';
import { fsmDiagram, type FsmMarks } from '../view/fsmdiagram';
import type { ScenePanel, Stage, Widget } from '../view/stage';

export interface FsmBind {
  /** Where the state bits and inputs are read in this scene (default: the spec's own names, from the root). */
  state?: string[];
  inputs?: Record<string, string>;
  /** The spec's arc parts are instances of this scene's root: light them on hover. */
  parts?: boolean;
  /** Rows of the last-cycles ribbon: a port / path, or 'state'. */
  ribbon?: { label: string; path: string }[];
}

interface Memory { trail: number[]; last?: number; rows: string[][]; cycles: number }
const RIBBON = 8;

/** The diagram as an element bound to a stage (for panels that embed it). */
export function fsmView(stage: Stage, spec: FsmSpec, bind: FsmBind = {}): Widget {
  const card = h('div', { class: 'fsm-card' });
  card.hidden = true;
  let marks: FsmMarks = {};
  const dg = fsmDiagram(spec, {
    onArc: (i) => {
      marks = { ...marks, hoverArc: i ?? undefined };
      dg.mark(marks);
      if (!bind.parts) return;
      const parts = i === null ? [] : spec.arcs[i].parts ?? [];
      stage.highlight(parts.length ? parts : stage.scene?.highlight ?? [], parts.length > 0);
    },
    onState: (i) => {
      marks = { ...marks, hoverState: i ?? undefined };
      dg.mark(marks);
      card.hidden = i === null;
      if (i === null) return;
      const st = spec.states[i];
      const on = Object.entries(st.out ?? {}).filter(([k, v]) => v && k !== 'state');
      card.replaceChildren(...[h('b', null, st.name), h('span', { class: 'sub' }, ` code ${st.code.toString(2).padStart(spec.codeBits ?? 1, '0')}`),
        st.does ? h('div', null, st.does) : null,
        on.length ? h('div', { class: 'fsm-sig' }, on.map(([k, v]) => h('code', null, v === 1 ? k : `${k} = ${v}`))) : null].filter((x): x is HTMLElement => !!x));
    },
  });
  const ribbon = bind.ribbon ? h('div', { class: 'fsm-ribbon' }) : null;
  const el = h('div', { class: 'fsm-view' }, dg.el, card, ribbon);
  const mem: Memory = { trail: [], rows: [], cycles: stage.cycles };
  let pending = -1, prev = -1;

  const read = () => {
    const sim = stage.sim!;
    const cur = fsmStateOf(sim, spec, bind.state);
    const inp = fsmInputsOf(sim, spec, bind.inputs);
    return { cur, inp, next: cur >= 0 ? fsmArc(spec, cur, inp) : -1 };
  };
  const value = (path: string, cur: number) => {
    if (path === 'state') return cur >= 0 ? spec.states[cur].name : 'X';
    const b = pathBits(stage.sim!.design.root, [path]);
    const v = b ? pack(stage.sim!.getBits(b)) : -1;
    return v < 0 ? 'X' : String(v);
  };
  const row = (cur: number) => bind.ribbon!.map((r) => value(r.path, cur));
  const hook = {
    before: () => {
      if (!stage.sim) return;
      const r = read();
      pending = r.next;
      prev = r.cur;
      if (ribbon) mem.rows = [...mem.rows, row(r.cur)].slice(-RIBBON);
    },
    after: () => {
      if (!stage.sim) return;
      const cur = fsmStateOf(stage.sim, spec, bind.state);
      mem.last = pending >= 0 && spec.arcs[pending].to === cur ? pending : spec.arcs.findIndex((a) => a.from === prev && a.to === cur);
      if (mem.last < 0) mem.last = undefined;
      mem.trail = cur === spec.reset || !mem.trail.length ? [cur] : [...mem.trail, cur];
      mem.cycles = stage.cycles;
    },
  };
  stage.edgeHooks.add(hook);
  const history = {
    save: () => ({ ...mem, trail: [...mem.trail], rows: [...mem.rows] }),
    restore: (s: unknown) => Object.assign(mem, s as Memory),
  };
  stage.historyHooks.add(history);

  const update = () => {
    if (!stage.sim) return;
    // Reset (the stage's cycle count went back): forget the path and the ribbon.
    if (stage.cycles < mem.cycles) { mem.trail = []; mem.rows = []; mem.last = undefined; }
    mem.cycles = stage.cycles;
    const r = read();
    if (!mem.trail.length && r.cur >= 0) mem.trail = [r.cur];
    marks = { ...marks, cur: r.cur >= 0 ? r.cur : undefined, next: r.next >= 0 ? r.next : undefined, last: mem.last, trail: mem.trail };
    dg.mark(marks);
    if (ribbon) {
      const now = row(r.cur), outs = new Set(spec.outputs);
      const cols = [...mem.rows, now];
      ribbon.style.gridTemplateColumns = `auto repeat(${RIBBON + 1}, 1fr)`;
      ribbon.replaceChildren(...bind.ribbon!.flatMap((rb, k) => [
        h('span', { class: 'k' }, rb.label),
        ...Array.from({ length: RIBBON + 1 }, (_, c) => {
          const col = cols[c - (RIBBON + 1 - cols.length)];
          const v = col?.[k] ?? '';
          return h('span', { class: `${c === RIBBON ? 'now' : ''}${outs.has(rb.path) && v === '1' ? ' one' : ''}` }, v);
        })]));
      ribbon.title = 'The last cycles, oldest first; the highlighted column is now (outputs before the edge).';
    }
  };
  return {
    el, update,
    destroy: () => { stage.edgeHooks.delete(hook); stage.historyHooks.delete(history); },
  };
}

/** A scene panel: the diagram with a title, docked like the other scene panels. */
export function fsmPanel(spec: FsmSpec, bind: FsmBind = {}, title = 'State machine'): ScenePanel {
  return (stage: Stage): Widget => {
    const view = fsmView(stage, spec, bind);
    const head = h('h4', null, title, h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel fsm-panel' }, head, view.el,
      h('div', { class: 'fsm-legend' },
        h('span', null, h('i', { class: 'cur' }), 'current'), h('span', null, h('i', { class: 'next' }), 'next edge'),
        h('span', null, h('i', { class: 'last' }), 'last edge'), spec.arcs.some((a) => a.out) ? h('span', null, h('i', { class: 'out' }), 'output 1') : null));
    head.addEventListener('click', () => el.classList.toggle('collapsed'));
    return { el, update: view.update, destroy: view.destroy };
  };
}
