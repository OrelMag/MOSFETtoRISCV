// A multiple-choice question box (a chapter step's quiz, a recap's or a codex entry's Check yourself), solved state in
// settings.solved under the caller's key.

import type { Quiz } from '../chapters/types';
import { h, icon } from './dom';
import { settings } from './settings';

/**
 * A multiple-choice question: a wrong pick says why it is wrong (Quiz.why) and stays marked; the right one shows the
 * explanation and records `key` as solved. `onSolved` runs after a new solve (the head's counters).
 */
export function quizBox(q: Quiz, key: string, label: string, onSolved: () => void): HTMLElement {
  const box = h('div', { class: 'challenge' });
  const tag = h('span', { class: 'tag' }, label);
  const explain = h('div', { class: 'explain' });
  const opts = h('div', { class: 'options' });
  const reveal = h('button', { class: 'btn ghost sm', style: 'margin-top:8px' }, 'Show answer');
  const right = () => {
    (opts.children[q.answer] as HTMLElement).classList.add('right');
    const why = q.why?.[q.answer];
    explain.innerHTML = why ? `${why} ${q.explain}` : q.explain;
    reveal.remove();
  };
  const markSolved = () => {
    box.classList.add('solved');
    tag.replaceChildren(icon('check', 12), ' Solved');
  };
  reveal.addEventListener('click', right);
  q.options.forEach((o, i) => {
    const btn = h('button', { class: 'btn' }, o);
    btn.addEventListener('click', () => {
      if (i !== q.answer) {
        btn.classList.add('wrong');
        explain.innerHTML = q.why?.[i] ?? 'Not quite. Try another answer.';
        return;
      }
      right();
      if (settings.isSolved(key)) return;
      settings.solve(key);
      markSolved();
      onSolved();
    });
    opts.append(btn);
  });
  box.append(h('div', { class: 'challenge-head' }, tag, h('span', { html: q.question })), opts, reveal, explain);
  if (settings.isSolved(key)) {
    markSolved();
    right();
  }
  return box;
}
