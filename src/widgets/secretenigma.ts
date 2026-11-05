// Chapter "Keeping it secret", its opening: one key press as a permutation you can read, the crib against the reflector's flaw, and
// the Bombe's reasoning run live over every wheel position. All of it the cipher itself (crypto/enigma.ts, crypto/bombe.ts).

import '../styles/secret.css';
import { bombeCipher, bombeRun, BOMBE_KEY, BOMBE_PLAIN, centreOf, cribOffsets, menuOf, type BombeRun, type BombeSetup } from '../crypto/bombe';
import { ALPHABET, chr, Enigma, idx, U264 } from '../crypto/enigma';
import { h, keepFocus, s } from '../ui/dom';
import type { Widget } from '../view/stage';

const n0 = (x: number) => Math.round(x).toLocaleString('en-US').replace(/,/g, ' ');

/** What one window position does: every letter's partner, and what the machine can never do. */
export function permutationWidget(): Widget {
  let e = new Enigma(U264.settings), picked = 'V';
  const grid = h('div', { class: 'se-perm', role: 'group', 'aria-label': 'Each letter and the letter it lights at this position' });
  const stats = h('p', { class: 'se-read' }), wins = h('span', { class: 'se-win' });
  const cells = [...ALPHABET].map((ch) => {
    const b = h('button', { type: 'button', class: 'se-cell' }) as HTMLButtonElement;
    b.addEventListener('click', () => { picked = ch; draw(); });
    grid.append(b);
    return b;
  });
  function draw(): void {
    const map = [...ALPHABET].map((ch) => e.trace(ch).output), partner = map[idx(picked)];
    let fixed = 0, swaps = 0;
    map.forEach((o, i) => { if (o === chr(i)) fixed++; if (map[idx(o)] === chr(i)) swaps++; });
    cells.forEach((b, i) => {
      const ch = chr(i), on = ch === picked, other = ch === partner;
      b.replaceChildren(h('b', null, ch), h('span', null, map[i]));
      b.className = `se-cell${on ? ' on' : ''}${other ? ' other' : ''}`;
      b.setAttribute('aria-label', `${ch} lights ${map[i]}`);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    wins.textContent = e.windows();
    stats.replaceChildren(
      h('span', null, picked, ' lights ', h('b', null, partner), ', and ', partner, ' lights ', h('b', null, map[idx(partner)]), '. '),
      h('span', null, 'Letters that light themselves: ', h('b', null, String(fixed)), '. Letters whose partner lights them back: ', h('b', null, String(swaps)), ' of 26.'),
    );
  }
  const step = h('button', { type: 'button', class: 'btn sm' }, 'Press a key: the wheels step') as HTMLButtonElement;
  step.addEventListener('click', () => { e.step(); keepFocus(step, draw); });
  const back = h('button', { type: 'button', class: 'btn sm' }, 'Back to VJNA') as HTMLButtonElement;
  back.addEventListener('click', () => { e = new Enigma(U264.settings); keepFocus(back, draw); });
  const el = h('div', { class: 'panel se' },
    h('h3', { class: 'm3-title' }, 'One position, one permutation'),
    h('div', { class: 'se-row' }, h('span', null, 'Windows ', wins), step, back),
    grid, stats);
  draw();
  return { el };
}

/** Slide a crib along U-264's ciphertext: a letter over itself rules the place out. */
export function cribWidget(): Widget {
  const cipher = U264.cipher, crib = 'BEIANGRIFF', survivors = cribOffsets(cipher, crib), last = cipher.length - crib.length, truth = U264.plain.indexOf(crib);
  let at = survivors[0] === 0 ? 1 : 0;
  const slider = h('input', { type: 'range', min: 0, max: last, step: 1, value: at, 'aria-label': 'Where the crib stands under the ciphertext' }) as HTMLInputElement;
  const rows = h('div', { class: 'se-crib' }), verdict = h('p', { class: 'se-read', 'aria-live': 'polite' });
  function draw(): void {
    const from = Math.max(0, Math.min(at - 6, cipher.length - 26)), span = 26;
    const top = h('div', { class: 'se-line' }), bot = h('div', { class: 'se-line' });
    let crashes = 0;
    for (let i = from; i < from + span && i < cipher.length; i++) {
      const c = cipher[i], k = i >= at && i < at + crib.length ? crib[i - at] : '', hit = k && k === c;
      if (hit) crashes++;
      top.append(h('span', { class: hit ? 'crash' : k ? 'over' : '' }, c));
      bot.append(h('span', { class: hit ? 'crash' : k ? 'over' : 'gap' }, k || '·'));
    }
    rows.replaceChildren(h('div', { class: 'se-label' }, 'Cipher'), top, h('div', { class: 'se-label' }, 'Crib'), bot);
    const isTrue = at === truth;
    verdict.replaceChildren(
      crashes ? h('span', { class: 'bad' }, `Place ${at}: ${crashes} ${crashes === 1 ? 'letter stands' : 'letters stand'} over ${crashes === 1 ? 'itself' : 'themselves'}. The machine cannot do that, so the crib is not here.`)
        : h('span', { class: 'ok' }, `Place ${at}: no letter over itself. It might be here.${isTrue ? ' It is: U-264 sent BEIANGRIFF exactly here.' : ''}`),
      h('br'),
      h('span', null, 'Over the whole message, ', h('b', null, String(survivors.length)), ' of ', String(last + 1), ' places survive for this ten-letter crib.'),
    );
  }
  slider.addEventListener('input', () => { at = Number(slider.value); draw(); });
  const jump = h('button', { type: 'button', class: 'btn sm' }, 'Go to where it really was') as HTMLButtonElement;
  jump.addEventListener('click', () => { at = truth; slider.value = String(at); keepFocus(jump, draw); });
  const el = h('div', { class: 'panel se' },
    h('h3', { class: 'm3-title' }, 'Dragging a crib along U-264’s message'),
    rows,
    h('div', { class: 'se-row' }, h('label', { class: 'se-slide' }, h('span', null, 'Place'), slider), jump),
    verdict);
  draw();
  return { el };
}

/** The crib as a graph, on a circle: a letter per node, an edge per place. Its loops are what test a setting. */
function menuSvg(crib: string, cipher: string): SVGElement {
  const edges = menuOf(crib, cipher), letters = [...new Set(edges.flatMap((e) => [e.a, e.b]))].sort(), R = 118, C = 150, centre = centreOf(crib, cipher);
  const at = (c: string): [number, number] => { const a = (letters.indexOf(c) / letters.length) * 2 * Math.PI - Math.PI / 2; return [C + R * Math.cos(a), C + R * Math.sin(a)]; };
  const svg = s('svg', { viewBox: '0 0 300 300', class: 'se-menu', role: 'img', 'aria-label': `The menu: ${edges.length} letter pairs joining ${letters.length} letters, with test letter ${centre}` });
  for (const e of edges) {
    const [x0, y0] = at(e.a), [x1, y1] = at(e.b);
    svg.append(s('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: 'se-edge' }));
    svg.append(s('text', { x: (x0 + x1) / 2, y: (y0 + y1) / 2 + 3, class: 'se-place', 'text-anchor': 'middle' }, String(e.at + 1)));
  }
  for (const c of letters) {
    const [x, y] = at(c);
    svg.append(s('circle', { cx: x, cy: y, r: 11, class: `se-node${c === centre ? ' centre' : ''}` }));
    svg.append(s('text', { x, y: y + 4, class: `se-nodet${c === centre ? ' centre' : ''}`, 'text-anchor': 'middle' }, c));
  }
  return svg;
}

const BUDGET_MS = 12;

/** Every wheel position tried for one wheel order, with the plugboard unknown. */
export function bombeWidget(): Widget {
  const cipher = bombeCipher();
  let diagonal = true, run: BombeRun | null = null, raf = 0, began = 0, took = 0, lastStops = -1;
  const setup = (): BombeSetup => ({ rotors: BOMBE_KEY.rotors, rings: BOMBE_KEY.rings, reflector: 'b', greek: 'beta', greekAt: BOMBE_KEY.start[0], crib: BOMBE_PLAIN, cipher, diagonal });
  const go = h('button', { type: 'button', class: 'btn sm' }, 'Run all 17 576 positions') as HTMLButtonElement;
  const toggle = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Diagonal board' }) as HTMLInputElement;
  const bar = h('div', { class: 'se-bar' }), fill = h('i');
  bar.append(fill);
  const out = h('p', { class: 'se-read', 'aria-live': 'polite' }, 'Press Run. Each position is tested as the Bombe tested it.');
  const list = h('div', { class: 'se-stops' });
  function show(): void {
    if (!run) return;
    fill.style.width = `${(run.done / run.total) * 100}%`;
    const finished = run.done >= run.total;
    if (!finished) { out.textContent = `Position ${n0(run.done)} of ${n0(run.total)}, ${run.stops.length} stops so far.`; return; }
    const hit = run.stops.some((x) => x.windows === BOMBE_KEY.start);
    out.replaceChildren(
      h('b', null, String(run.stops.length)), ` ${run.stops.length === 1 ? 'stop' : 'stops'} in ${n0(took)} ms in this browser`,
      lastStops >= 0 && lastStops !== run.stops.length ? ` (the last run, ${diagonal ? 'without' : 'with'} the board: ${lastStops})` : '',
      `. ${hit ? 'The true setting is among them.' : 'The true setting is not among them.'}`,
    );
    list.replaceChildren(...run.stops.slice(0, 40).map((x) => h('span', { class: x.windows === BOMBE_KEY.start ? 'stop true' : 'stop' }, `${x.windows.slice(1)} ${x.plug}/${x.value}`)));
    lastStops = run.stops.length;
  }
  function frame(): void {
    raf = 0;
    if (!run) return;
    const t0 = performance.now();
    let done = false;
    while (performance.now() - t0 < BUDGET_MS && !done) done = run.step(64);
    if (done) { took = performance.now() - began; go.disabled = false; go.textContent = 'Run again'; show(); return; }
    show();
    raf = requestAnimationFrame(frame);
  }
  go.addEventListener('click', () => {
    run = bombeRun(setup()); began = performance.now(); list.replaceChildren(); go.disabled = true;
    raf = requestAnimationFrame(frame);
  });
  toggle.addEventListener('change', () => { diagonal = toggle.checked; });
  const pair = (t: string, v: string) => h('div', { class: 'se-pair' }, h('span', { class: 'se-label' }, t), h('code', null, v));
  const el = h('div', { class: 'panel se' },
    h('h3', { class: 'm3-title' }, 'A crib, its menu, and a run'),
    h('div', { class: 'se-bombe' },
      h('div', { class: 'se-col' },
        pair('Crib', BOMBE_PLAIN), pair('Cipher', cipher),
        h('p', { class: 'm3-sub' }, `Wheel order ${BOMBE_KEY.rotors.join(' ')}, the only part of the key assumed known: in practice each order was another run. Test letter ${centreOf(BOMBE_PLAIN, cipher)}.`),
        h('div', { class: 'se-row' }, go, h('label', { class: 'se-check' }, toggle, h('span', null, 'Diagonal board'))),
        bar, out, list),
      h('div', { class: 'se-col' }, menuSvg(BOMBE_PLAIN, cipher))));
  return { el, destroy() { cancelAnimationFrame(raf); run = null; } };
}

const table = (head: string[], rows: string[][]) => h('div', { class: 'se-scroll' }, h('table', { class: 'se-table' },
  h('thead', null, h('tr', null, ...head.map((t) => h('th', null, t)))),
  h('tbody', null, ...rows.map((r) => h('tr', null, ...r.map((t) => h('td', null, t)))))));

/** What each failure of the machine became as a rule. */
export function lessonsWidget(): Widget {
  return { el: h('div', { class: 'panel se' }, h('h3', { class: 'm3-title' }, 'The failures, and the rules they became'), table(['Enigma', 'The rule it taught', 'AES-128 and modern practice'], [
    ['No letter enciphers to itself: a tell that needs no key.', 'No structural property may hold across keys.', 'Designed so that no such relation is known. A block can map to itself, as it should for a random permutation.'],
    ['Its strength is mostly the plugboard, and a method goes round it.', 'A key must not split into parts attacked one at a time. Count what an attack does, not the settings.', 'Every output bit depends on every key bit within a few rounds. 128 bits, with no known shortcut of practical size.'],
    ['Wheels and procedure were kept secret, then captured or worked out.', 'Only the key is secret (Kerckhoffs, 1883).', 'The design and its test vectors are published. You will check gates against them.'],
    ['Message keys sent twice; stereotyped openings gave cribs.', 'Assume the attacker knows or chooses the plaintext.', 'Security is defined against chosen plaintext. Fresh nonces, never reused.'],
    ['The same day\'s key for a whole network, printed on paper.', 'Key distribution is the hard problem.', 'Key exchange in public, so no sheet is printed: the end of this chapter.'],
  ])) };
}

/** Where each machine's function lives: the line from the wiring to the stored program. */
export function machinesWidget(): Widget {
  return { el: h('div', { class: 'panel se' }, h('h3', { class: 'm3-title' }, 'Where the function lives'), table(['Machine', 'Year', 'Made of', 'Its function is set by', 'A stored program?'], [
    ['Enigma', '1920s–45', 'Rotors, contacts, bulbs', 'Its wiring, and a daily key', 'No: it does one thing'],
    ['Bombe (Turing, Welchman)', '1940', 'Drums and relays', 'A menu, wired up for each job', 'No'],
    ['Colossus (Flowers), against Lorenz, not Enigma', '1943–44', '1 600, then 2 400 valves', 'Switches and plug panels', 'No'],
    ['Turing\'s universal machine', '1936', 'On paper', 'A description of another machine, on its own tape', 'The idea of one'],
    ['Manchester Baby', '1948', 'Valves and a CRT memory', 'Words in read-write memory', 'Yes: first run 21 June 1948'],
    ['The CPU you built in this book', 'Here', 'NANDs', 'Words in memory', 'Yes'],
  ])) };
}
