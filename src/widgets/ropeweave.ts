// Appendix F's weave widget: a toy core rope (agc/rope.ts) the learner reads and rewires. Four cores, two words a core,
// four bits a word: pick an address and watch the inhibit lines leave one core free to switch, the sense lines through
// it pulse, and the strand switch pass one word's lines to the sense amplifiers. Click a crossing to thread a sense
// line through its core or take it out: the only way to change what a rope holds.

import { groupNum } from '../sim/numfmt';
import { BLOCK2_ROPE, coresOf, readRope, rethread, weave, wordsIn, wordsOf, type ToyRope } from '../agc/rope';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import '../styles/agc.css';

const START = [0b1011, 0b0110, 0b1100, 0b0001, 0b0111, 0b1000, 0b0101, 0b1110];
const W = 720, CX0 = 150, PITCH = 132, CY = 150, CORE_RX = 30, CORE_RY = 58;
// a line passing a core arcs BYPASS beyond its own height, so the arcs nest without touching
const LINE_GAP = 12, BYPASS = 40;
const bin = (v: number, n: number) => v.toString(2).padStart(n, '0');

export function ropeWeaveWidget(): Widget {
  let rope: ToyRope = weave(START);
  let addr = 0;
  const lines = rope.strands * rope.bits; // sense lines, strand-major
  const lineY = (strand: number, bit: number) => CY - ((lines - 1) / 2) * LINE_GAP + (strand * rope.bits + bit) * LINE_GAP;
  const coreX = (c: number) => CX0 + c * PITCH;
  const inhY = (i: number) => CY + 104 + i * 16;
  const H = inhY(2 * rope.coreBits - 1) + 18;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'rope-svg', role: 'group', 'aria-label': 'A core rope of four cores: sense lines thread or pass each core, inhibit lines below' });
  const words = h('div', { class: 'rope-words', role: 'group', 'aria-label': 'The words the rope holds; pick one to read it' });
  const readout = h('p', { class: 'rope-read', 'aria-live': 'polite' });

  const paint = () => {
    const rd = readRope(rope, addr);
    svg.replaceChildren();
    // the inhibit lines below the cores
    svg.append(s('text', { x: 8, y: CY - 128, class: 'rope-lbl' }, 'sense lines'), s('text', { x: 8, y: inhY(0) - 14, class: 'rope-lbl' }, 'inhibit lines'));
    for (let k = 0; k < rope.coreBits; k++) for (const v of [0, 1]) {
      const i = 2 * k + v, y = inhY(i), driven = ((rd.core >> k) & 1) === v;
      let d = `M60,${y}`;
      for (let c = 0; c < coresOf(rope); c++) {
        const x = coreX(c), through = ((c >> k) & 1) !== v;
        // an inhibit line threads a core by rising into its hole; otherwise it runs straight under it
        d += through ? ` H${x - 18} L${x - 6},${CY + 48 + 3 * i} L${x + 6},${CY + 48 + 3 * i} L${x + 18},${y}` : ` H${x + 18}`;
      }
      svg.append(s('path', { d: `${d} H${W - 70}`, class: `rope-inh${driven ? ' on' : ''}` }),
        s('text', { x: W - 64, y: y + 4, class: 'rope-tag' }, `a${k} = ${v}`));
    }
    // the cores
    for (let c = 0; c < coresOf(rope); c++) {
      const free = rd.inhibits[c] === 0;
      svg.append(s('ellipse', { cx: coreX(c), cy: CY, rx: CORE_RX, ry: CORE_RY, class: `rope-core${free ? ' on' : ''}` }),
        s('text', { x: coreX(c), y: CY - 128, class: 'rope-tag', 'text-anchor': 'middle' }, `core ${bin(c, rope.coreBits)}`),
        s('text', { x: coreX(c), y: CY - 114, class: 'rope-tag dim', 'text-anchor': 'middle' }, free ? 'switches' : `${rd.inhibits[c]} inhibit${rd.inhibits[c] > 1 ? 's' : ''}`));
    }
    // the sense lines: straight through a core for a 1, round it for a 0; a click on a crossing rethreads it
    for (let st = 0; st < rope.strands; st++) for (let b = 0; b < rope.bits; b++) {
      const y = lineY(st, b), up = y < CY;
      let d = `M60,${y}`;
      for (let c = 0; c < coresOf(rope); c++) {
        const x = coreX(c);
        d += rope.thread[c][st][b] ? ` H${x + CORE_RX + 6}` : ` H${x - CORE_RX - 6} Q${x},${up ? y - 2 * BYPASS : y + 2 * BYPASS} ${x + CORE_RX + 6},${y}`;
      }
      const pulsed = rd.pulse[st][b], passed = pulsed && st === rd.strand;
      svg.append(s('path', { d: `${d} H${W - 70}`, class: `rope-sense${passed ? ' on' : pulsed ? ' blocked' : ''}${st === rd.strand ? ' sel' : ''}` }),
        s('text', { x: 52, y: y + 3, class: 'rope-tag', 'text-anchor': 'end' }, `w${st}.b${b}`));
      svg.append(s('text', { x: W - 64, y: y + 3, class: `rope-bit${passed ? ' on' : ''}` }, st === rd.strand ? (pulsed ? '1' : '0') : pulsed ? '×' : ''));
      for (let c = 0; c < coresOf(rope); c++) {
        const hit = s('rect', { x: coreX(c) - CORE_RX - 4, y: y - LINE_GAP / 2, width: 2 * CORE_RX + 8, height: LINE_GAP, class: 'rope-hit', role: 'button', tabindex: 0,
          'aria-label': `core ${c}, word ${st}, bit ${b}: ${rope.thread[c][st][b] ? 'threaded (1)' : 'passes by (0)'}; press to rethread` });
        const flip = () => { rope = rethread(rope, c, st, b); paint(); };
        hit.addEventListener('click', flip);
        hit.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
        svg.append(hit);
      }
    }
    svg.append(s('text', { x: W - 70, y: CY - 128, class: 'rope-lbl' }, 'read'));
    // the words: buttons to read each
    const all = wordsIn(rope);
    words.replaceChildren(...all.map((v, a) => h('button', { type: 'button', class: `btn sm rope-w${a === addr ? ' on' : ''}`, 'aria-pressed': String(a === addr),
      onclick: () => { addr = a; paint(); } }, h('span', null, `${a}`), h('code', null, bin(v, rope.bits)))));
    const threads = rope.thread.flat(2).filter(Boolean).length;
    readout.textContent = `Address ${addr} = core ${bin(rd.core, rope.coreBits)}, word ${rd.strand}: every other core carries a driven inhibit line, so only core ${bin(rd.core, rope.coreBits)} switches. `
      + `Every sense line threaded through it picks up a pulse (a 1; one that passes it by does not: a 0), and the strand switch passes word ${rd.strand}'s ${rope.bits} lines to the amplifiers: ${bin(rd.word, rope.bits)} (b3 … b0). `
      + `${threads} of ${coresOf(rope) * lines} crossings are threaded.`;
  };
  paint();

  const facts = h('p', { class: 'sub' },
    `The AGC's rope: each core stores ${BLOCK2_ROPE.wordsPerCore} words, so ${BLOCK2_ROPE.senseLines} sense lines run through or past it and ${BLOCK2_ROPE.bitsRead} reach the sense amplifiers; `
    + `${BLOCK2_ROPE.modules} modules hold ${groupNum(BLOCK2_ROPE.words)} words, ${groupNum(BLOCK2_ROPE.wordsPerModule)} a module, which makes ${BLOCK2_ROPE.coresPerModule} cores a module (R-700 vol. III, 3.5.2). `
    + `This toy: ${coresOf(rope)} cores, ${rope.strands} words a core, ${wordsOf(rope)} words.`);
  const el = h('div', { class: 'widget rope-weave' },
    h('div', { class: 'panel' }, h('h3', null, 'A rope of four cores: pick a word, or click a crossing to rethread it'), svg, readout),
    h('div', { class: 'panel' }, h('h3', null, 'The words it holds'), words, facts));
  return { el };
}
