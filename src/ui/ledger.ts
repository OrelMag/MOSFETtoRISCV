// A step's Ledger: the arithmetic of the scene written out in its own notation beside the prose, from the
// scene's ports after every change. 'add' is column addition with the carries above the columns (a − b as
// a + ¬b + 1 while sub is 1); hovering a column lights the parts that compute it.

import type { Ledger } from '../chapters/types';
import type { Stage } from '../view/stage';
import { h } from './dom';

export interface LedgerView {
  el: HTMLElement;
  update(): void;
}

const bitsOf = (v: number, w: number) => Array.from({ length: w }, (_, i) => (v >= 0 ? Math.floor(v / 2 ** i) % 2 : -1));
const cell = (b: number) => (b < 0 ? 'X' : String(b));

export function ledgerView(stage: Stage, l: Ledger): LedgerView {
  const el = h('div', { class: 'ledger', role: 'group', 'aria-label': 'Worked sum' });
  const light = (i: number | null) => {
    if (i === null || !l.col) stage.highlight(stage.target?.highlight ?? []);
    else stage.highlight(l.col(i), true);
  };
  const update = () => {
    const w = l.width;
    const a = stage.value(l.a), b0 = stage.value(l.b);
    const sub = l.sub ? stage.value(l.sub) === 1 : false;
    const b = b0 < 0 ? -1 : sub ? (2 ** w - 1) - b0 : b0;
    const cin = sub ? 1 : l.cin ? stage.value(l.cin) : 0;
    const sum = stage.value(l.sum);
    const cout = l.cout ? stage.value(l.cout) : -1;
    const A = bitsOf(a, w), B = bitsOf(b, w), S = bitsOf(sum, w);
    // the carries the arithmetic gives: into column i (carry[0] = cin), out of the top as carry[w]
    const carry: number[] = [cin];
    for (let i = 0; i < w; i++) {
      carry.push(A[i] < 0 || B[i] < 0 || carry[i] < 0 ? -1 : (A[i] + B[i] + carry[i]) >> 1);
    }
    const expect = a < 0 || b < 0 || cin < 0 ? -1 : a + b + cin;
    const want = expect < 0 ? -1 : expect % 2 ** w;
    const agree = want === sum && (!l.cout || cout === (expect < 0 ? -1 : Math.floor(expect / 2 ** w)));
    // columns: the carry out on the left, then bit w−1 … 0
    const cols = [w, ...Array.from({ length: w }, (_, j) => w - 1 - j)];
    const row = (label: string, cells: (string | null)[], value: string, cls = '') =>
      h('tr', { class: cls }, h('th', null, label), ...cells.map((c, j) => {
        const i = cols[j];
        const td = h('td', { 'data-col': String(i) }, c ?? '');
        if (i < w) {
          td.addEventListener('pointerenter', () => light(i));
          td.addEventListener('pointerleave', () => light(null));
        }
        return td;
      }), h('td', { class: 'ledger-v' }, value));
    const fmt = (v: number) => (v < 0 ? 'X' : String(v));
    el.replaceChildren(h('table', null, h('tbody', null,
      row('carry', cols.map((i) => (i === w ? null : i === 0 ? cell(carry[0]) : cell(carry[i])), ), '', 'ledger-carry'),
      row('a', cols.map((i) => (i === w ? null : cell(A[i]))), fmt(a)),
      row(sub ? '+ ¬b' : '+ b', cols.map((i) => (i === w ? null : cell(B[i]))), sub ? `${fmt(b)} (¬${fmt(b0)})` : fmt(b)),
      row('=', cols.map((i) => (i === w ? (l.cout ? cell(cout) : cell(carry[w])) : cell(S[i]))), l.cout && cout >= 0 ? `${fmt(sum)}, carry ${cout}` : fmt(sum), 'ledger-sum'))),
      h('p', { class: 'ledger-note' },
        sub ? `a − b = a + ¬b + 1: the 1 goes in as the carry into column 0.` : l.cin ? `The carry into column 0 is cin.` : '',
        agree ? '' : h('span', { class: 'ledger-warn' }, ' The circuit has not settled on this sum yet.')));
  };
  update();
  return { el, update };
}
