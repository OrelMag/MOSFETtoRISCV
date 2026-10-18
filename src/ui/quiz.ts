// A multiple-choice question box (a chapter step's quiz, a recap's or a codex entry's Check yourself), solved state in
// settings.solved under the caller's key. The options are shown in an order fixed per question (authors tend to write
// the right answer first, and a pattern would give it away); `why` and `answer` keep the authored order.

import type { Quiz } from '../chapters/types';
import { h, icon } from './dom';
import { settings } from './settings';

/** A shuffle of 0 … n − 1 that depends only on `seed` (FNV-1a, then Fisher–Yates on its stream). */
export function shuffleOrder(n: number, seed: string): number[] {
  let x = 2166136261;
  for (let i = 0; i < seed.length; i++) x = Math.imul(x ^ seed.charCodeAt(i), 16777619);
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    x = Math.imul(x ^ (x >>> 15), 2246822507) ^ Math.imul(x ^ (x >>> 13), 3266489909);
    const j = (x >>> 0) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

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
  const buttons: HTMLElement[] = [];
  const right = () => {
    buttons[q.answer].classList.add('right');
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
    buttons.push(btn);
  });
  opts.append(...shuffleOrder(buttons.length, `${key}|${q.question}`).map((i) => buttons[i]));
  box.append(h('div', { class: 'challenge-head' }, tag, h('span', { html: q.question })), opts, reveal, explain);
  if (settings.isSolved(key)) {
    markSolved();
    right();
  }
  return box;
}
