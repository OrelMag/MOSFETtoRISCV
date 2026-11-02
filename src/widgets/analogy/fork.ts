// Figure: fork, control hazards (chapter "pipeline", "Control hazards").

import { h, s } from '../../ui/dom';
import { button, setPressed } from './common';
import { fork, FLUSH_PENALTY } from './pipe';
import { GRID_W, GRID_L, gridHeight, gridKids } from './pipegridsvg';

const COLS = Math.max(...[false, true].flatMap((g) => [false, true].map((a) => fork(g, a).cycles)));
const MAP_H = 62;

export default function mount(host: HTMLElement): void {
  let guess = false, actual = true, shown = COLS;
  const svg = s('svg', { viewBox: `0 0 ${GRID_W} ${MAP_H + gridHeight()}`, class: 'af-svg', role: 'img', 'aria-label': 'A branch instruction reaching a fork: the pipeline guesses a road and keeps fetching' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const guessBtn = button('', () => { guess = !guess; shown = COLS; paint(); }, false);
  const actualBtn = button('', () => { actual = !actual; shown = COLS; paint(); }, true);
  const stepBtn = button('Step', () => { shown = shown >= COLS ? 1 : shown + 1; paint(); });

  // the road: a stem, then the fall-through road and the taken road; a thick line on the guess, a ring on the real one
  const road = (): SVGElement[] => {
    const k: SVGElement[] = [];
    const x0 = GRID_L + 6, xf = 128, y0 = 30, yN = 48, yT = 12;
    k.push(s('path', { d: `M${x0} ${y0} L${xf} ${y0}`, class: 'af-road' }),
      s('path', { d: `M${xf} ${y0} L${xf + 30} ${yN} L${GRID_W - 96} ${yN}`, class: 'af-road' }),
      s('path', { d: `M${xf} ${y0} L${xf + 30} ${yT} L${GRID_W - 96} ${yT}`, class: 'af-road' }),
      s('text', { x: x0, y: 22, class: 'af-t af-m' }, 'br'),
      s('text', { x: GRID_W - 88, y: yN + 5, class: 'af-t' }, 'not taken'),
      s('text', { x: GRID_W - 88, y: yT + 5, class: 'af-t' }, 'taken'));
    const gy = guess ? yT : yN;
    k.push(s('path', { d: `M${xf} ${y0} L${xf + 30} ${gy} L${xf + 70} ${gy}`, class: 'af-guess' }),
      s('circle', { cx: GRID_W - 100, cy: actual ? yT : yN, r: 5, class: 'af-real' }));
    return k;
  };

  const paint = () => {
    const f = fork(guess, actual);
    const t = Math.min(shown, f.cycles);
    const grid = s('g', { transform: `translate(0 ${MAP_H})` }, ...gridKids({ cells: f.cells, cols: COLS, shown: t, label: (i) => f.rows[i].name }));
    svg.replaceChildren(...road(), grid);
    guessBtn.textContent = `Guess: ${guess ? 'taken' : 'not taken'}`;
    actualBtn.textContent = `Actual: ${actual ? 'taken' : 'not taken'}`;
    setPressed(guessBtn, guess);
    setPressed(actualBtn, actual);
    stepBtn.textContent = t >= f.cycles ? 'Replay' : `Step (${t}/${f.cycles})`;
    read.textContent = t < f.cycles ? `Cycle ${t} of ${f.cycles}.`
      : f.wrong
        ? `Orange road: the guess; ring: the road really taken. Wrong guess: the branch is resolved in E, and the ${FLUSH_PENALTY} instructions fetched on the guessed road (dashed) are flushed. The right road starts ${FLUSH_PENALTY} cycles late: ${f.lost} cycles lost, ${f.cycles} in all.`
        : `Orange road: the guess; ring: the road really taken. Right guess: the road really taken was already being fetched, so nothing is lost (${f.cycles} cycles).${guess ? ' Guessing taken needs a predictor that knows the target in F; the chapter\'s own pipeline always guesses not taken.' : ''}`;
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, guessBtn, actualBtn, stepBtn), read);
  paint();
}
