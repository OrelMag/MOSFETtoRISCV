// Panels of chapter "Designing state machines" (chapters/ch-fsm.ts): the diagram with the cost of each state code and a
// switch between them, the diagram with the register's raw code (an unused one has no state), and the read-back of a
// circuit over the diagram it should be (wrong arcs red, the expected ones dashed). The machines are lib/fsmbook.ts's.

import '../styles/fsmbook.css';
import { type EncodingCost } from '../editor/fsmchip';
import { codeCosts, ENCODING_NAMES, fsmCircuit, fsmSpecOf } from '../lib/fsmbook';
import type { FsmSpec } from '../lib/fsm';
import { fsmStateOf, pathBits, readbackOk, readbackSpec, readFsm } from '../sim/fsmread';
import { simulate } from '../sim/harness';
import { pack } from '../sim/values';
import { h } from '../ui/dom';
import { fsmDiagram } from '../view/fsmdiagram';
import type { ScenePanel, Stage, Widget } from '../view/stage';
import { fsmView, type FsmBind } from './fsmpanel';
import type { FsmDoc } from '../editor/model';

type Encoding = FsmDoc['encoding'];

const legend = (spec: FsmSpec) => h('div', { class: 'fsm-legend' },
  h('span', null, h('i', { class: 'cur' }), 'current'), h('span', null, h('i', { class: 'next' }), 'next edge'),
  h('span', null, h('i', { class: 'last' }), 'last edge'), spec.arcs.some((a) => a.out) ? h('span', null, h('i', { class: 'out' }), 'output 1') : null);

// ---- step 3: the same machine in three codes ------------------------------------------------------------------------------

/**
 * The detector's diagram (its states labelled with the codes of `enc`), the three codes' costs from the sandbox builder's
 * own count, and a switch that reloads the scene with the circuit built in the code picked.
 */
export function encodingPanel(doc: FsmDoc, enc: Encoding, pick: (stage: Stage, enc: Encoding) => void): ScenePanel {
  return (stage: Stage): Widget => {
    const spec = fsmSpecOf({ ...doc, encoding: enc });
    const view = fsmView(stage, spec, { parts: false });
    const costs = codeCosts();
    const row = (c: EncodingCost, moore: EncodingCost | undefined) => h('tr', { class: c.enc === enc ? 'pick' : '' },
      h('td', null, ENCODING_NAMES[c.enc]), h('td', { class: 'num' }, String(c.dffs)), h('td', { class: 'num' }, String(c.logic)),
      h('td', { class: 'num' }, h('b', null, String(c.nands))), h('td', { class: 'num' }, String(moore?.nands ?? '')));
    const table = h('table', { class: 'cmp fsm-enc' },
      h('thead', null, h('tr', null, h('th', null, 'code'), h('th', null, 'flip-flops'), h('th', null, 'logic'), h('th', null, 'NANDs'), h('th', null, 'Moore NANDs'))),
      h('tbody', null, costs.mealy.map((c, i) => row(c, costs.moore[i]))));
    const toggle = h('div', { class: 'fsm-tog', role: 'group', 'aria-label': 'State code' },
      (['binary', 'gray', 'onehot'] as Encoding[]).map((e) => h('button', {
        class: `btn sm${e === enc ? ' on' : ''}`, type: 'button', 'aria-pressed': String(e === enc), onclick: () => { if (e !== enc) pick(stage, e); },
      }, ENCODING_NAMES[e])));
    const codes = h('div', { class: 'fsm-codes' });
    const bits = spec.codeBits ?? 1;
    codes.textContent = `${spec.states.map((s) => s.name).join(' ')} = ${spec.states.map((s) => s.code.toString(2).padStart(enc === 'onehot' ? spec.states.length : bits, '0')).join(' ')}`;
    const head = h('h4', null, 'Codes and cost', h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel fsm-panel fsm-enc-panel', 'data-phone': 'flow' }, head, view.el, legend(spec), toggle, codes, table,
      h('div', { class: 'fsm-note' }, 'NANDs as the builder counts them: flip-flops plus the minimized tables and the reset gates. Moore column: the four-state version (y on S3).'));
    head.addEventListener('click', () => el.classList.toggle('collapsed'));
    return { el, update: view.update, destroy: view.destroy };
  };
}

// ---- step 5: the register's raw code --------------------------------------------------------------------------------------

/** The diagram plus a line with the state register's bits: which state they name, or that no state has this code. */
export function codePanel(spec: FsmSpec, bind: FsmBind = {}, title = 'State machine'): ScenePanel {
  return (stage: Stage): Widget => {
    const view = fsmView(stage, spec, bind);
    const line = h('div', { class: 'fsm-code' });
    const head = h('h4', null, title, h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel fsm-panel', 'data-phone': 'flow' }, head, view.el, line, legend(spec));
    head.addEventListener('click', () => el.classList.toggle('collapsed'));
    const update = () => {
      view.update?.();
      if (!stage.sim) return;
      const b = pathBits(stage.sim.design.root, bind.state ?? spec.stateBits);
      const raw = b ? stage.sim.getBits(b) : [];
      const code = raw.length ? pack(raw) : -1;
      const text = raw.slice().reverse().join('');
      const s = fsmStateOf(stage.sim, spec, bind.state);
      line.className = `fsm-code${s >= 0 ? '' : ' unused'}`;
      line.replaceChildren(h('span', { class: 'k' }, 'register'), h('code', null, text || 'X'),
        h('span', null, code < 0 ? ' unknown' : s >= 0 ? ` = ${spec.states[s].name}` : ' = no state has this code'));
    };
    return { el, update, destroy: view.destroy };
  };
}

// ---- step 6: read back --------------------------------------------------------------------------------------------------

/**
 * Reads the stage's circuit back (sim/fsmread.ts: every reachable state and arc, on a simulation of its own) and draws
 * it over `target`: right arcs as drawn, wrong ones red with the expected arc dashed, and a verdict.
 */
export function readbackPanel(target: FsmSpec, title = 'Read back'): ScenePanel {
  return (stage: Stage): Widget => {
    const head = h('h4', null, title, h('span', { class: 'fold-hint' }));
    const body = h('div', { class: 'fsm-rb' });
    const el = h('div', { class: 'mem-panel fsm-panel fsm-rb-panel', 'data-phone': 'flow' }, head, body);
    head.addEventListener('click', () => el.classList.toggle('collapsed'));
    let shown: unknown = null;
    const update = () => {
      const def = stage.sim?.design.root.def;
      if (!def || def === shown) return;
      shown = def;
      const r = readFsm(simulate(def), target);
      const bad = r.arcs.filter((a) => !a.ok);
      const name = (i: number) => r.states[i].name;
      const inp = (a: (typeof r.arcs)[number]) => target.inputs.filter((n) => !(n in (target.resetIn ?? {}))).map((n) => `${n} = ${a.inp[n]}`).join(', ');
      const ok = readbackOk(r);
      body.replaceChildren(
        fsmDiagram(readbackSpec(target, r)).el,
        h('div', { class: `fsm-verdict ${ok ? 'ok' : 'bad'}` }, ok
          ? `Every state and every arc is the diagram's: ${r.states.length} states, ${r.arcs.length} arcs read.`
          : `${bad.length} of ${r.arcs.length} arcs differ from the diagram.`),
        ...(bad.length ? [h('ul', { class: 'fsm-rb-list' }, ...bad.slice(0, 4).map((a) => h('li', null,
          `In ${name(a.from)} with ${inp(a)}: goes to ${name(a.to)}${Object.values(a.out).some((v) => v === 1) ? ' and raises y' : ''}; the diagram says ${a.specTo >= 0 ? target.states[a.specTo].name : '?'}${Object.values(a.specOut).some((v) => v === 1) ? ' and y' : ''}.`)))] : []));
    };
    return { el, update, destroy: () => undefined };
  };
}

export { fsmCircuit };
