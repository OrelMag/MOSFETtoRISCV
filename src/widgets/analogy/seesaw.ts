// Figure: the sense amplifier as a seesaw (chapter "dram", "The sense amplifier"), on the leaky figure's charge-sharing numbers.

import { h, s } from '../../ui/dom';
import { CELL_C, BITLINE_C } from '../../lib/dram';
import { DRAM_OFFSET_MV } from './model';
import { seesawDiffMv, seesawSense, type Sensed } from './mem';
import { button, setPressed } from './common';

const W = 360, CX = 180, CY = 104, HALF = 150, TILT_PER_MV = 8 / 110, SLAM = 20;

export default function mount(host: HTMLElement): void {
  let level = 0.8, precharged = true, sensed: Sensed | null = null;
  const svg = s('svg', { viewBox: `0 0 ${W} 214`, class: 'af-svg', role: 'img', 'aria-label': 'A seesaw balanced at half the supply, tipped by the cell and slammed to a rail by the sense amplifier' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const val = h('span', { class: 'num' });
  const slider = h('input', { type: 'range', min: '0', max: '100', value: String(Math.round(level * 100)), 'aria-label': 'Cell level, percent of VDD' }) as HTMLInputElement;
  slider.addEventListener('input', () => { level = Number(slider.value) / 100; sensed = null; paint(); });
  const preBtn = button('Precharge: on', () => { precharged = !precharged; sensed = null; paint(); }, true);
  const senseBtn = button('Sense', () => {
    sensed = seesawSense(level, precharged);
    level = sensed.cell;
    slider.value = String(level * 100);
    paint();
  });

  const paint = () => {
    const d = seesawDiffMv(level, precharged), x = Math.abs(d) < DRAM_OFFSET_MV;
    const slam = sensed ? (sensed.resolved ? SLAM : -SLAM) : 0;
    const ang = sensed ? slam : Math.max(-9, Math.min(9, d * TILT_PER_MV));
    const left = sensed ? (sensed.resolved ? 'VDD' : '0') : 'bit line', right = sensed ? (sensed.resolved ? '0' : 'VDD') : 'reference ½';
    svg.replaceChildren(
      s('path', { d: `M${CX - 26},${CY + 58} L${CX},${CY + 4} L${CX + 26},${CY + 58} Z`, class: 'af-room' }),
      s('g', { transform: `rotate(${ang.toFixed(2)} ${CX} ${CY})` },
        s('rect', { x: CX - HALF, y: CY - 5, width: HALF * 2, height: 10, rx: 3, class: `af-plank${sensed ? ' slam' : x ? ' maybe' : ''}` }),
        // the feather (the cell's charge) rests on the bit-line end
        s('g', { transform: `translate(${CX - HALF + 28} ${CY - 26})` },
          s('path', { d: 'M-16,22 C-8,2 8,-2 18,6 C8,10 -2,16 -16,22 Z', class: `af-feather${precharged || sensed ? '' : ' off'}` }),
          s('path', { d: 'M-16,22 L14,7', class: 'af-quill' }))),
      s('text', { x: CX - HALF, y: 18, class: 'af-t af-m' }, left),
      s('text', { x: CX + HALF, y: 18, 'text-anchor': 'end', class: 'af-t af-m' }, right),
      s('text', { x: CX, y: CY + 80, 'text-anchor': 'middle', class: 'af-t af-m' }, 'balance point: VDD / 2'),
      s('text', { x: CX, y: 206, 'text-anchor': 'middle', class: `af-big sm${sensed?.read === 'X' || (!sensed && x) ? ' bad' : ''}` },
        sensed ? (sensed.coin ? `X → coin toss → ${sensed.resolved}` : `reads ${sensed.read}, cell rewritten`) : `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(0)} mV${x ? ' · under 15: ?' : ''}`));
    val.textContent = `${(level * 100).toFixed(0)} %`;
    setPressed(preBtn, precharged);
    preBtn.textContent = precharged ? 'Precharge: on' : 'Precharge: off';
    senseBtn.disabled = sensed !== null;
    const share = `ΔV = (level − ½)·VDD·${CELL_C} / (${CELL_C} + ${BITLINE_C}) fF`;
    read.textContent = sensed
      ? (sensed.coin
        ? `Under the ${DRAM_OFFSET_MV.toFixed(0)} mV offset the amplifier latched X, which settles to either rail: this time the coin said ${sensed.resolved}, and the cell is rewritten to ${sensed.cell} whatever it held.`
        : `The amplifier drove the bit line to the ${sensed.resolved ? 'VDD' : '0'} rail and the cell, still connected, was written back to ${sensed.cell}: the read restored it.`)
      : !precharged
      ? `Precharge off: the bit line still sits at the rail the last read left it on, so the cell hardly moves it (${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(0)} mV from the reference). The seesaw starts tipped and the amplifier reads that old 1, whatever the cell holds.`
      : x
        ? `${share} = ${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} mV, under the amplifier's ${DRAM_OFFSET_MV.toFixed(0)} mV offset: the feather is too light to tip it, and the result is a coin toss (X).`
        : `${share} = ${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(0)} mV, over the ${DRAM_OFFSET_MV.toFixed(0)} mV offset: the seesaw tips to ${d > 0 ? 'the bit-line end, a 1' : 'the reference end, a 0'}.`;
  };
  host.replaceChildren(svg,
    h('div', { class: 'af-ctl' }, h('label', null, 'Cell level', slider, val), preBtn, senseBtn,
      button('Re-arm', () => { sensed = null; paint(); })),
    read);
  paint();
}
