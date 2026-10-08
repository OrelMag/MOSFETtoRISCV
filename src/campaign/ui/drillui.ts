// A drill in the level panel: one generated question at a time, a text answer checked exactly,
// a K-map drawn when the question has one (cells the typed expression covers are shaded live),
// a running count; the level is solved after `goal` correct answers, graded on mistakes.

import { h, icon } from '../../ui/dom';
import { evalBool, type KmapSpec, parseBool, type Question, rng, DRILLS } from '../drills';
import { progress } from '../progress';
import type { CampaignNode } from '../types';

const GRAY2 = [0, 1, 3, 2];

/** K-map cells: rows and columns in Gray order. Returns the table and a function shading cells for an expression. */
function kmapEl(k: KmapSpec): { el: HTMLElement; shade(expr: string): void } {
  const n = k.vars.length;
  const rv = n === 4 ? 2 : 1, cv = n - rv;
  const rows = rv === 2 ? GRAY2 : [0, 1], cols = cv === 2 ? GRAY2 : [0, 1];
  const cells = new Map<number, HTMLElement>();
  const head = h('tr', null, h('th', { class: 'corner' }, `${k.vars.slice(0, rv).join('')} \\ ${k.vars.slice(rv).join('')}`),
    cols.map((c) => h('th', null, c.toString(2).padStart(cv, '0'))));
  const body = rows.map((r) => h('tr', null, h('th', null, r.toString(2).padStart(rv, '0')), cols.map((c) => {
    const m = (r << cv) | c;
    const v = k.ones.includes(m) ? '1' : k.dc.includes(m) ? '×' : '0';
    const td = h('td', { class: `v${v === '×' ? 'x' : v}`, title: `minterm ${m}` }, v);
    cells.set(m, td);
    return td;
  })));
  const el = h('table', { class: 'cp-kmap' }, head, body);
  return {
    el,
    shade(expr: string) {
      const p = expr.trim() ? parseBool(expr, k.vars) : null;
      for (const [m, td] of cells) {
        td.classList.remove('cov', 'bad', 'miss');
        if (!p || 'error' in p) continue;
        const on = evalBool(p.ex, m, n) === 1;
        if (on && k.ones.includes(m)) td.classList.add('cov');
        else if (on && !k.dc.includes(m)) td.classList.add('bad');
        else if (!on && k.ones.includes(m)) td.classList.add('miss');
      }
    },
  };
}

/** The drill's interactive card. */
export function drillCard(n: CampaignNode): HTMLElement {
  const d = DRILLS[n.drill ?? ''];
  if (!d) return h('p', { class: 'sub' }, 'Unknown drill.');
  const r = rng((Date.now() ^ (Math.random() * 1e9)) >>> 0);
  let right = 0, mistakes = 0, revealed = false;
  let q: Question = d.make(r);
  const card = h('div', { class: 'cp-drill' });
  const howEl = h('p', { class: 'sub' });
  howEl.innerHTML = d.how;

  const render = () => {
    const solved = progress().get(n.id)?.status === 'solved';
    const prompt = h('p', { class: 'cp-drill-q' });
    prompt.innerHTML = q.prompt;
    const km = q.kmap ? kmapEl(q.kmap) : null;
    const input = h('input', { type: 'text', class: 'cp-drill-in', placeholder: q.placeholder ?? 'your answer', 'aria-label': 'Your answer', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
    const fb = h('p', { class: 'cp-drill-fb', role: 'status', 'aria-live': 'polite' });
    const next = () => {
      q = d.make(r);
      revealed = false;
      render();
      card.querySelector<HTMLInputElement>('.cp-drill-in')?.focus();
    };
    const check = () => {
      if (revealed) return next();
      const res = q.check(input.value);
      if (res.ok) {
        right++;
        fb.className = 'cp-drill-fb ok';
        fb.replaceChildren(icon('check', 14), ' Correct. ', q.explain ? explain(q.explain) : '');
        if (right >= d.goal) {
          const g = progress().solve(n.id, { mistakes });
          fb.append(h('b', null, ` Drill complete ${'★'.repeat(g.stars)}${'☆'.repeat(3 - g.stars)}`));
        }
        input.disabled = true;
        btn.textContent = 'Next';
        revealed = true;
      } else {
        mistakes++;
        fb.className = 'cp-drill-fb bad';
        fb.replaceChildren(icon('close', 14), ` Not yet${res.why ? `: ${res.why}` : ''}.`);
      }
      count.textContent = tally();
    };
    const btn = h('button', { class: 'btn sm primary', onclick: check }, 'Check');
    const show = h('button', { class: 'btn sm ghost', onclick: () => {
      if (revealed) return;
      mistakes++;
      revealed = true;
      fb.className = 'cp-drill-fb';
      fb.replaceChildren('Answer: ', h('code', null, q.answer), ' ', q.explain ? explain(q.explain) : '');
      input.disabled = true;
      btn.textContent = 'Next';
      count.textContent = tally();
    } }, 'Show answer');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        check();
      }
    });
    if (km) input.addEventListener('input', () => km.shade(input.value));
    const count = h('span', { class: 'cp-drill-count' }, tally());
    card.replaceChildren(howEl, h('div', { class: 'cp-drill-box' }, prompt, km?.el ?? null,
      h('div', { class: 'cp-drill-row' }, input, btn, show), fb),
    h('div', { class: 'cp-drill-foot' }, count, solved ? h('span', { class: 'cp-done' }, icon('check', 14), 'Passed: keep practising if you like') : null));
  };
  const tally = () => `${Math.min(right, d.goal)}/${d.goal} correct · ${mistakes} mistake${mistakes === 1 ? '' : 's'}`;
  const explain = (s: string) => {
    const e = h('span', { class: 'sub' });
    e.innerHTML = s;
    return e;
  };
  render();
  return card;
}
