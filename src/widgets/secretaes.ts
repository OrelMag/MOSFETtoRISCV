// Chapter "Keeping it secret", AES and SHA-256: a round you can step through, a flipped bit spreading, what a mode leaves showing, and a
// digest's avalanche. Every value is crypto/aes.ts, crypto/modes.ts or crypto/sha256.ts, the models the gates are compared with.

import '../styles/secret.css';
import { encryptTrace, fromHex, hex, type Bytes } from '../crypto/aes';
import { Enigma, type EnigmaSettings } from '../crypto/enigma';
import { bitsDiffer, ctrCrypt, ecbEncrypt, gcmOpen, gcmSeal, PIC, picture } from '../crypto/modes';
import { sha256, utf8 } from '../crypto/sha256';
import { APPENDIX_B } from '../crypto/vectors';
import { h, keepFocus, s } from '../ui/dom';
import type { Widget } from '../view/stage';

const STAGES = ['Start', 'SubBytes', 'ShiftRows', 'MixColumns', 'AddRoundKey'] as const;
type Stage = (typeof STAGES)[number];
const byte = (b: number) => b.toString(16).padStart(2, '0');

/** Column by column, as the standard draws the state. */
function stateGrid(st: Bytes, changed: boolean[] | null): HTMLElement {
  const g = h('div', { class: 'se-state', role: 'img', 'aria-label': `State: ${hex(st)}` });
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    const i = col * 4 + row;
    g.append(h('span', { class: changed?.[i] ? 'new' : '' }, byte(st[i])));
  }
  return g;
}

/** FIPS 197's worked example, round by round and step by step. */
export function aesExplorerWidget(): Widget {
  const t = encryptTrace(APPENDIX_B.input, APPENDIX_B.key);
  let round = 1, stage: Stage = 'Start';
  const r = () => t.rounds[round - 1];
  const stateAt = (rd: number, st: Stage): Bytes => {
    const x = t.rounds[rd - 1];
    return st === 'Start' ? x.start : st === 'SubBytes' ? x.afterSub : st === 'ShiftRows' ? x.afterShift : st === 'MixColumns' ? (x.afterMix ?? x.afterShift) : x.out;
  };
  const left = h('div', { class: 'se-statebox' }), key = h('div', { class: 'se-statebox' }), say = h('p', { class: 'se-read' });
  const slider = h('input', { type: 'range', min: 1, max: 10, step: 1, value: 1, 'aria-label': 'Round' }) as HTMLInputElement, out = h('output');
  const words: Record<Stage, string> = {
    Start: 'The state this round begins from: 16 bytes, in four columns.',
    SubBytes: 'Every byte through the S-box. This is the only step that is not linear, and it is why the cipher cannot be solved as a system of XORs.',
    ShiftRows: 'Row r turns by r bytes: pure wiring, no gates. Each column now holds bytes from four different columns.',
    MixColumns: 'Each column is multiplied by a fixed matrix in GF(2⁸): every output byte depends on all four input bytes.',
    AddRoundKey: 'XOR with this round\'s key: the only step that uses it. SubBytes, ShiftRows and MixColumns use no key of their own; what they work on already depends on the earlier round keys.',
  };
  const buttons = STAGES.map((st) => {
    const b = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false' }, st) as HTMLButtonElement;
    b.addEventListener('click', () => { stage = st; keepFocus(b, draw); });
    return b;
  });
  function draw(): void {
    const noMix = round === 10 && stage === 'MixColumns', now = stateAt(round, stage), i = STAGES.indexOf(stage);
    const before = i === 0 ? null : stateAt(round, STAGES[i - 1]);
    left.replaceChildren(h('div', { class: 'se-label' }, stage === 'Start' ? `Round ${round}: start` : `After ${stage}`), stateGrid(now, before ? now.map((b, k) => b !== before[k]) : null));
    key.replaceChildren(h('div', { class: 'se-label' }, `Round key ${round}`), stateGrid(r().roundKey, null));
    say.textContent = noMix ? 'The last round has no MixColumns. It is linear and would sit just before the key XOR, so it could be moved through that XOR and adds no strength; leaving it out makes decryption line up.' : words[stage];
    out.textContent = String(round);
    buttons.forEach((b, k) => b.setAttribute('aria-pressed', k === i ? 'true' : 'false'));
  }
  slider.addEventListener('input', () => { round = Number(slider.value); draw(); });
  draw();
  return {
    el: h('div', { class: 'panel se' },
      h('h3', { class: 'm3-title' }, 'FIPS 197’s worked example, round by round'),
      h('label', { class: 'se-slide' }, h('span', null, 'Round'), slider, out),
      h('div', { class: 'se-row' }, ...buttons),
      h('div', { class: 'se-states' }, left, key),
      say,
      h('p', { class: 'se-read' }, 'Ciphertext after round 10: ', h('code', null, hex(t.output)))),
  };
}

const PLAIN_MSG = 'WETTERVORHERSAGEBISKAYA';
const ENIGMA_KEY: EnigmaSettings = { reflector: 'b', greek: 'beta', rotors: ['II', 'V', 'III'], rings: 'AAAA', start: 'AQHC', plugs: 'AM BT CX DR FY GL HQ IU JK NZ' };

/** A bit flipped in the input, followed round by round: bits of the state that differ. */
export function avalancheWidget(): Widget {
  const W = 620, H = 200, L = 34, B = 26, T = 10, base = encryptTrace(APPENDIX_B.input, APPENDIX_B.key);
  let bit = 0;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'se-chart', role: 'img', 'aria-label': 'Bits of the state that differ after each round' });
  const Y = (v: number) => T + (H - T - B) * (1 - v / 128), bw = (W - L - 8) / 11;
  const series = () => {
    const inp = [...APPENDIX_B.input];
    inp[bit >> 3] ^= 0x80 >> (bit & 7);
    const t = encryptTrace(inp, APPENDIX_B.key);
    return [bitsDiffer(t.afterInitial, base.afterInitial), ...t.rounds.map((r, i) => bitsDiffer(r.out, base.rounds[i].out))];
  };
  const read = h('p', { class: 'se-read' }), tbl = h('details', { class: 'deeper' });
  function draw(): void {
    const v = series();
    svg.replaceChildren();
    for (const g of [0, 64, 128]) {
      svg.append(s('line', { x1: L, x2: W - 4, y1: Y(g), y2: Y(g), class: g === 64 ? 'se-half' : 'se-grid' }));
      svg.append(s('text', { x: L - 6, y: Y(g) + 4, 'text-anchor': 'end', class: 'se-tick' }, String(g)));
    }
    v.forEach((n, i) => {
      const x = L + i * bw + 4, w = bw - 8, y = Y(n), g = s('g', { class: 'se-barg' });
      g.append(s('title', null, `${i === 0 ? 'Before round 1' : `After round ${i}`}: ${n} of 128 bits differ`));
      g.append(s('rect', { x, y, width: w, height: Math.max(1.5, Y(0) - y), rx: 3, class: 'se-barv' }));
      svg.append(g);
      svg.append(s('text', { x: x + w / 2, y: H - 9, 'text-anchor': 'middle', class: 'se-tick' }, i === 0 ? 'in' : String(i)));
    });
    const at = v.findIndex((n) => n >= 40);
    read.textContent = `Flipped input bit ${bit}. It starts as 1 bit of difference; ${at > 0 ? `by round ${at} it is ${v[at]}` : `it reaches ${Math.max(...v)}`}; after round 10, ${v[10]} of 128. The dashed line is half, 64: what two unrelated blocks would show.`;
    tbl.replaceChildren(h('summary', null, 'The numbers'), h('p', { class: 'se-read' }, v.map((n, i) => `${i === 0 ? 'in' : i}: ${n}`).join(' · ')));
  }
  const slider = h('input', { type: 'range', min: 0, max: 127, step: 1, value: 0, 'aria-label': 'Which input bit to flip' }) as HTMLInputElement;
  slider.addEventListener('input', () => { bit = Number(slider.value); draw(); });
  // The same experiment on the Enigma: one letter of input, one letter of output.
  const a = new Enigma(ENIGMA_KEY).run(PLAIN_MSG), changed = `${PLAIN_MSG.slice(0, 5)}${PLAIN_MSG[5] === 'Q' ? 'P' : 'Q'}${PLAIN_MSG.slice(6)}`, b = new Enigma(ENIGMA_KEY).run(changed);
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  draw();
  return {
    el: h('div', { class: 'panel se' },
      h('h3', { class: 'm3-title' }, 'Bits of the state that differ, by round'),
      svg,
      h('label', { class: 'se-slide' }, h('span', null, 'Bit flipped'), slider),
      read, tbl,
      h('p', { class: 'se-read' }, 'The same test on the Enigma: change one letter of a ', String(a.length), '-letter message and ', h('b', null, String(diff)), ` ${diff === 1 ? 'letter' : 'letters'} of its ciphertext ${diff === 1 ? 'changes' : 'change'}. The wheels never see the message.`)),
  };
}

function paint(c: HTMLCanvasElement, px: Bytes): void {
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(PIC, PIC);
  for (let i = 0; i < PIC * PIC; i++) { const v = px[i]; img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
}

/** Pictures through each mode, and a message changed in flight. */
export function modesWidget(): Widget {
  const key = APPENDIX_B.key, n = fromHex('f0f1f2f3f4f5f6f7f8f9fafb00000001'), n2 = fromHex('a0a1a2a3a4a5a6a7a8a9aaab00000001');
  const a = picture(0), b = picture(1);
  const VIEWS: [string, string, () => Bytes][] = [
    ['The picture', 'What is being sent: one byte a pixel, 16 pixels a block.', () => a],
    ['ECB', 'Each block enciphered alone. Every block is scrambled and the picture is still there, because equal blocks stay equal.', () => ecbEncrypt(a, key)],
    ['CTR', 'A counter enciphered, and XORed in. No block repeats, so nothing shows.', () => ctrCrypt(a, key, n)],
    ['CTR, new nonce', 'A second picture under a fresh counter: just as unreadable.', () => ctrCrypt(b, key, n2)],
    ['Same nonce twice', 'Two pictures sent with the same counter, and their ciphertexts XORed by someone with no key. The keystream cancels and both pictures appear.', () => { const x = ctrCrypt(a, key, n), y = ctrCrypt(b, key, n); return x.map((v, i) => v ^ y[i]); }],
  ];
  const canvas = h('canvas', { width: PIC, height: PIC, class: 'se-pic', role: 'img', 'aria-label': 'The picture after this mode' }) as HTMLCanvasElement;
  const say = h('p', { class: 'se-read' });
  const btns = VIEWS.map(([label, text, f]) => {
    const b2 = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false' }, label) as HTMLButtonElement;
    b2.addEventListener('click', () => keepFocus(b2, () => show(label, text, f)));
    return b2;
  });
  function show(label: string, text: string, f: () => Bytes): void {
    paint(canvas, f());
    say.textContent = text;
    canvas.setAttribute('aria-label', `${label}. ${text}`);
    btns.forEach((x) => x.setAttribute('aria-pressed', x.textContent === label ? 'true' : 'false'));
  }
  // Tampering: CTR lets a change straight through; GCM refuses it.
  const msg = utf8('PAY ALICE 100 EUR'), iv = fromHex('000102030405060708090a0b'), sealed = gcmSeal(msg, key, iv), at = msg.indexOf('1'.charCodeAt(0));
  const text = (d: Bytes) => new TextDecoder().decode(new Uint8Array(d));
  const c0 = ctrCrypt(msg, key, n), tamperedCtr = [...c0]; tamperedCtr[at] ^= '1'.charCodeAt(0) ^ '9'.charCodeAt(0);
  const tamperedGcm = [...sealed.ciphertext]; tamperedGcm[at] ^= '1'.charCodeAt(0) ^ '9'.charCodeAt(0);
  const opened = gcmOpen({ ciphertext: tamperedGcm, tag: sealed.tag }, key, iv);
  const el = h('div', { class: 'panel se' },
    h('h3', { class: 'm3-title' }, 'A cipher is not yet a way to send a message'),
    h('div', { class: 'se-row' }, ...btns),
    h('div', { class: 'se-picrow' }, canvas, say),
    h('h4', { class: 'se-sub' }, 'Secret is not the same as unchanged'),
    h('p', { class: 'se-read' }, 'One byte of ciphertext XORed in flight, by someone with no key, who only knows where the amount is: ',
      h('br'), 'CTR delivers ', h('code', null, text(ctrCrypt(tamperedCtr, key, n))), '. ',
      h('br'), 'GCM, with its tag, delivers ', h('code', null, opened ? text(opened) : 'nothing: the tag does not match'), '.'));
  show(VIEWS[0][0], VIEWS[0][1], VIEWS[0][2]);
  return { el };
}

/** A digest, and how much of it one changed character moves. */
export function shaWidget(): Widget {
  let prev = sha256(utf8('abc')), said = 0;
  const input = h('input', { type: 'text', value: 'abc', class: 'se-text', 'aria-label': 'Text to hash', maxlength: 200 }) as HTMLInputElement;
  const digest = h('div', { class: 'se-digest' }), read = h('p', { class: 'se-read' }), spoken = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  function draw(first = false): void {
    const d = sha256(utf8(input.value));
    digest.replaceChildren(...[...d].map((c, i) => h('span', { class: !first && c !== prev[i] ? 'new' : '' }, c)));
    const n = bitsDiffer(fromHex(d), fromHex(prev));
    read.textContent = first ? 'The digest of "abc", the standard\'s first example. Change one character.' : `${n} of 256 bits differ from the previous digest. Chance alone would give about 128.`;
    // Spoken once the typing pauses, not at every key.
    clearTimeout(said);
    if (!first) said = window.setTimeout(() => { spoken.textContent = read.textContent; }, 700);
    prev = d;
  }
  input.addEventListener('input', () => draw());
  draw(true);
  return {
    el: h('div', { class: 'panel se' },
      h('h3', { class: 'm3-title' }, 'SHA-256 of what you type'),
      input, digest, read, spoken),
    destroy() { clearTimeout(said); },
  };
}

