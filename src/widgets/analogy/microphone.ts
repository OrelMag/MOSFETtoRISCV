// Figure: one microphone, four speakers as tri-state buffers on one wire (appendix "appendix-sap", "What a bus really is").

import { h, s } from '../../ui/dom';
import { button, setPressed } from './common';
import { mic, SPEAKERS, SPEECH } from './steer';

const W = 360, H = 124;

export default function mount(host: HTMLElement): void {
  const on: boolean[] = new Array(SPEAKERS).fill(false);
  on[0] = true;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'af-svg', role: 'img', 'aria-label': 'Four speakers connected to one shared wire through tri-state buffers' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const btns = Array.from({ length: SPEAKERS }, (_, i) => button(`Speaker ${i}`, () => { on[i] = !on[i]; paint(); }, on[i]));

  const paint = () => {
    const r = mic(on);
    const bad = r.value === 'X';
    const xs = Array.from({ length: SPEAKERS }, (_, i) => 45 + i * 90);
    const parts = xs.flatMap((x, i) => [
      s('line', { x1: x, y1: 46, x2: x, y2: 70, class: on[i] ? (bad ? 'af-w af-badw' : 'af-w live') : 'af-w' }),
      s('rect', { x: x - 34, y: 70, width: 68, height: 48, rx: 5, class: on[i] ? 'af-bucket af-lit' : 'af-bucket' }),
      s('text', { x, y: 90, 'text-anchor': 'middle', class: on[i] ? 'af-t af-litt' : 'af-t' }, `S${i}`),
      s('text', { x, y: 109, 'text-anchor': 'middle', class: 'af-t af-m' }, on[i] ? `says ${SPEECH[i]}` : 'silent'),
    ]);
    svg.replaceChildren(
      s('line', { x1: 14, y1: 46, x2: 346, y2: 46, class: bad ? 'af-w af-badw' : r.value === 'Z' ? 'af-w' : 'af-w live' }),
      ...parts,
      s('text', { x: 14, y: 22, class: 'af-t af-m' }, 'wire'),
      s('text', { x: 346, y: 26, 'text-anchor': 'end', class: bad ? 'af-big bad' : 'af-big' }, r.value));
    btns.forEach((b, i) => setPressed(b, on[i]));
    const n = on.filter(Boolean).length;
    read.textContent = r.value === 'Z' ? 'Nobody is enabled: the wire floats (Z), neither 0 nor 1.'
      : bad ? `Two drivers disagree: ${r.short ?? 'a short'}. The wire reads X.`
        : n === 1 ? `One driver: the wire is ${r.value} and every listener sees it.`
          : `${n} drivers, all saying ${r.value}: no short, but nothing guards against the day they differ.`;
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, ...btns), read);
  paint();
}
