// The site's player for computed sound: one voice at a time, nothing until a click, stopped when the page changes. Without Web Audio the button
// says so and the step reads the same. Sound is never the only proof: every clip sits beside a plot and a number.

import { prepareClip, type Clip } from '../dsp/clip';
import { h } from '../ui/dom';

const Ctor = (): typeof AudioContext | null => (typeof AudioContext === 'function' ? AudioContext : null);
let ctx: AudioContext | null = null, voice: AudioBufferSourceNode | null = null, onStop: (() => void) | null = null, listening = false;

export function stopClip(): void {
  if (voice) { voice.onended = null; try { voice.stop(); } catch { /* already over */ } voice = null; }
  onStop?.(); onStop = null;
}

function start(c: Clip, ended: () => void): boolean {
  const AC = Ctor();
  if (!AC) return false;
  stopClip();
  try {
    ctx ??= new AC();
    if (!listening) { listening = true; window.addEventListener('hashchange', stopClip); }
    void ctx.resume();
    const data = prepareClip(c.samples), buf = ctx.createBuffer(1, data.length, c.rate), src = ctx.createBufferSource();
    buf.getChannelData(0).set(data);
    src.buffer = buf; src.connect(ctx.destination);
    src.onended = () => { if (voice === src) { voice = null; onStop = null; ended(); } };
    src.start();
    voice = src; onStop = ended;
    return true;
  } catch { return false; }
}

const SOURCE = { model: 'from the model', gates: 'from the gates' } as const;

/** A button that plays what `make` computes when pressed, and says what made it. `make` may return null, with `refused` saying why. */
export function clipButton(label: string, make: () => Clip | null, refused = 'Nothing to play') {
  const b = h('button', { type: 'button', class: 'btn sm' }, label) as HTMLButtonElement, what = h('span', { class: 'sub clip-what' });
  let playing = false;
  const rest = () => { playing = false; b.textContent = label; b.setAttribute('aria-pressed', 'false'); };
  const noSound = () => { b.disabled = true; b.textContent = 'No sound in this browser'; what.textContent = ''; };
  if (!Ctor()) noSound();
  b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', () => {
    if (playing) { stopClip(); return; }
    const c = make();
    if (!c) { what.textContent = refused; return; }
    if (!start(c, rest)) { noSound(); return; }
    playing = true;
    b.textContent = 'Stop'; b.setAttribute('aria-pressed', 'true');
    what.textContent = `${SOURCE[c.source]}${c.note ? `: ${c.note}` : ''}`;
  });
  return { el: h('span', { class: 'clip' }, b, what), button: b };
}
