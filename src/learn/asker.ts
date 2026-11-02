// A run of questions one at a time (browser): placement and test-out. Multiple choice goes through quizBox fresh, with
// its answer handed back here (nothing reaches settings.solved or the review queue); a drill question takes a typed
// answer and its exact checker. "I don't know yet" counts as wrong and moves on, as an answer would.

import { h } from '../ui/dom';
import { quizBox } from '../ui/quiz';
import type { Item } from './placement';

export interface Answer { tier: Item['tier']; right: boolean }

export function asker(items: Item[], onDone: (answers: Answer[]) => void, label = 'Question'): HTMLElement {
  const answers: Answer[] = [];
  const dots = h('div', { class: 'lp-dots', 'aria-hidden': 'true' }, ...items.map(() => h('i')));
  const count = h('span', { class: 'lp-count' });
  const body = h('div', { class: 'lp-q' });
  const nav = h('div', { class: 'lp-nav' });
  const el = h('div', { class: 'lp-asker' }, h('div', { class: 'lp-head' }, dots, count), body, nav);
  let at = 0;

  const next = () => {
    at++;
    if (at >= items.length) onDone(answers);
    else show();
  };
  const answer = (right: boolean) => {
    if (answers.length > at) return;
    answers.push({ tier: items[at].tier, right });
    dots.children[at].className = right ? 'right' : 'wrong';
    nav.replaceChildren(h('button', { class: 'btn primary', type: 'button', onclick: next }, at + 1 < items.length ? 'Next question' : 'See the result'));
    (nav.firstElementChild as HTMLElement).focus();
  };

  function show(): void {
    const it = items[at];
    count.textContent = `${label} ${at + 1} of ${items.length} · ${it.from}`;
    for (let i = 0; i < items.length; i++) dots.children[i].classList.toggle('cur', i === at);
    const skip = h('button', { class: 'btn', type: 'button', onclick: () => { if (answers.length <= at) answer(false); next(); } }, 'I don\'t know yet');
    if (it.kind === 'quiz') {
      body.replaceChildren(quizBox(it.quiz, `learn:${at}`, it.from, () => {}, { fresh: true, onAnswer: answer }));
    } else {
      const input = h('input', { class: 'lp-input', type: 'text', placeholder: it.q.placeholder ?? 'Your answer', 'aria-label': 'Your answer', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
      const verdict = h('div', { class: 'lp-verdict', 'aria-live': 'polite' });
      const check = () => {
        if (answers.length > at || !input.value.trim()) return;
        const r = it.q.check(input.value);
        verdict.className = `lp-verdict ${r.ok ? 'ok' : 'bad'}`;
        verdict.innerHTML = r.ok ? 'Right.' : `Not quite${r.why ? `: ${r.why}` : '.'} The answer: <code>${it.q.answer}</code>.${it.q.explain ? ` ${it.q.explain}` : ''}`;
        input.disabled = true;
        answer(r.ok);
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });
      const form = h('div', { class: 'lp-form' }, input, h('button', { class: 'btn primary', type: 'button', onclick: check }, 'Answer'));
      body.replaceChildren(h('div', { class: 'challenge' }, h('div', { class: 'lp-how', html: it.how }), h('p', { class: 'lp-prompt', html: it.q.prompt }), form, verdict));
      queueMicrotask(() => input.focus());
    }
    nav.replaceChildren(skip);
  }
  show();
  return el;
}
