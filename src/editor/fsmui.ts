// The read-back drawer of a state-machine challenge: the learner's circuit explored from reset
// (sim/fsmread.ts) and drawn over the target diagram, wrong arcs red with the expected arc dashed.

import type { FsmSpec } from '../lib/fsm';
import { readbackOk, readbackSpec, readFsm } from '../sim/fsmread';
import { simulate } from '../sim/harness';
import type { ComponentDef } from '../sim/types';
import { h } from '../ui/dom';
import { fsmDiagram } from '../view/fsmdiagram';

/** The drawer's body for this circuit (compiled def and level) against the spec. */
export function readbackEl(spec: FsmSpec, def: ComponentDef | undefined, mode: 'gate' | 'switch'): HTMLElement {
  if (!def) return h('p', { class: 'sb-fsm-msg' }, 'The chip does not compile yet.');
  let r;
  try {
    r = readFsm(simulate(def, mode), spec);
  } catch (e) {
    return h('p', { class: 'sb-fsm-msg' }, `Cannot read it back: ${e instanceof Error ? e.message : String(e)}.`);
  }
  const ok = readbackOk(r);
  const bad = r.arcs.filter((a) => !a.ok);
  const shown = spec.inputs.filter((n) => !(n in (spec.resetIn ?? {})));
  const inputs = (a: (typeof bad)[number]) => shown.map((n) => `${n} = ${a.inp[n]}`).join(', ');
  const outs = (o: Record<string, number>) => spec.outputs.filter((n) => n in o).map((n) => `${n} = ${o[n] < 0 ? 'X' : o[n]}`).join(', ');
  const name = (i: number) => r.states[i].name;
  return h('div', { class: 'sb-fsm' },
    h('p', { class: `sb-fsm-verdict ${ok ? 'ok' : 'bad'}` }, ok
      ? `Your circuit is this state machine: ${r.states.length} states reached from reset, every transition and output right.`
      : `${bad.length} transition${bad.length === 1 ? '' : 's'} differ${bad.length === 1 ? 's' : ''} from the target${r.truncated ? ' (stopped after 32 states)' : ''}.`),
    h('div', { class: 'sb-fsm-dg' }, fsmDiagram(readbackSpec(spec, r)).el),
    h('div', { class: 'fsm-legend' },
      h('span', null, h('i', { class: 'bad' }), 'yours, differs'), h('span', null, h('i', { class: 'spec' }), 'expected'),
      spec.arcs.some((a) => a.out) ? h('span', null, h('i', { class: 'out' }), 'output 1') : null),
    bad.length ? h('ul', { class: 'sb-fsm-list' }, bad.slice(0, 8).map((a) => h('li', null,
      h('b', null, name(a.from)), ` with ${inputs(a)}: goes to `, h('b', null, name(a.to)), outs(a.out) ? `, ${outs(a.out)}` : '',
      a.specTo >= 0 ? h('span', null, `; expected ${spec.states[a.specTo].name}${outs(a.specOut) ? `, ${outs(a.specOut)}` : ''}`) : null))) : null,
    h('p', { class: 'sb-fsm-how' }, `How: from reset, every input combination for one clock cycle, breadth first. A state is everything the circuit holds,
      so no flip-flop needs a name; each is paired with the target state the same inputs reach. A primed name (S1′) is a second circuit state where the
      target has one.`));
}
