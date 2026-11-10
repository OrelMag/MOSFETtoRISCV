// The vector unit's state as a view (DOM): vl, vtype, the beat, and every vector register that is not zero, a column per
// lane. Shared by the Vectors chapter's Vector panel (widgets/vectors.ts vecPanel) and the sandbox's CPU drawer on an
// rv32iv_core (editor/cpuui.ts), so the two cannot drift. Read from the gates (riscv/cosim.ts vectorState).
import { vectorState } from '../riscv/cosim';
import { vtypeText, VILL } from '../riscv/rvv';
import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { pack } from '../sim/values';
import { h } from '../ui/dom';
import '../styles/vecview.css';

const kid = (n: HierNode, ...p: string[]) => p.reduce<HierNode | undefined>((x, k) => x?.children?.get(k), n);

/** The view of the unit `vu` now, and a key that changes exactly when the view does (to redraw only then). */
export function vecView(sim: Pick<Sim, 'getBits'>, vu: HierNode): { key: string; nodes: HTMLElement[] } {
  const st = vectorState(sim, vu);
  const cntNode = kid(vu, 'seq', 'cnt');
  const cnt = cntNode ? pack(sim.getBits(cntNode.ports.q)) : 0;
  const lm = st.vtype === VILL ? 0 : st.vtype & 3;
  const rows: { r: number; words: number[] }[] = [];
  for (let r = 0; r < 32; r++) {
    const words = [0, 1, 2, 3].map((i) => (st.v[16 * r + 4 * i] | (st.v[16 * r + 4 * i + 1] << 8) | (st.v[16 * r + 4 * i + 2] << 16) | (st.v[16 * r + 4 * i + 3] << 24)) >>> 0);
    if (r === 0 || words.some((w) => w !== 0)) rows.push({ r, words });
  }
  const key = `${st.vl}|${st.vtype}|${cnt}|${rows.map((x) => `${x.r}:${x.words.join(',')}`).join(';')}`;
  const nodes = () => [
    h('div', { class: 'vp-kpi' },
      h('div', null, h('b', null, String(st.vl)), h('span', null, 'vl')),
      h('div', null, h('b', null, st.vtype === VILL ? 'vill' : vtypeText(st.vtype).split(',').slice(0, 2).join(',')), h('span', null, 'vtype')),
      h('div', null, h('b', null, cnt ? `${cnt}` : '–'), h('span', null, `beat (L = ${1 << lm})`))),
    h('div', { class: 'vp-regs' }, h('span', { class: 'vp-n' }), ...[0, 1, 2, 3].map((i) => h('span', { class: `vp-h l${i}` }, `lane ${i}`)),
      ...rows.flatMap(({ r, words }) => [h('span', { class: 'vp-n' }, `v${r}`), ...words.map((w, i) => h('span', { class: `vp-w l${i}`, title: `v${r}, lane ${i}: ${w | 0}` }, String(w | 0)))])),
    h('p', { class: 'sub' }, 'Each register\'s four 32-bit elements, one per lane (as signed numbers); registers that are all zero are left out, v0 aside.'),
  ];
  return { key, get nodes() { return nodes(); } };
}
