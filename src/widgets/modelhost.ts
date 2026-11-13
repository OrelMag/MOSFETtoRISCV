// What a chapter imports to show a 3D model: stays tiny, so a chapter that lists one does not grow by the model. The
// model (its view, the renderer) loads as its own chunks; withModel puts it under the step's existing widget.

import type { Widget } from '../view/stage';
import type { BiasLink } from './mosshare';
import { whenAsked } from './modelshot';

/** Each model's loaded height in px (stage and its panel) at 1440 and at 390 px wide, by its `what`, measured on every 3D
 *  route (E:/audit/release/eyes/swan/b5/heights.mjs). A 520 px placeholder for a model of 1 000 to 2 800 px pushed what
 *  follows it down when it arrived (two models on one step: CLS 0.12). Unlisted: 520. */
const LOADED: Record<string, [number, number]> = {
  'a 6502-style NMOS gate': [987, 1311],
  'Babbage’s carry': [1739, 2355],
  'planar, fin and nanosheet transistors': [1035, 1428],
  'the 3D NAND string': [1042, 1331],
  'the 3D transistor': [1172, 1808],
  'the assembly line': [1201, 1709],
  'the card reader': [1641, 2090],
  'the CCD': [1555, 2259],
  'the chip, mask by mask': [1078, 1621],
  'the core memory plane': [1261, 2154],
  'the core rope': [1083, 1654],
  'the crossbar switch': [1059, 1510],
  'the decade ring counter': [1145, 1375],
  'the dipole': [1458, 1573],
  'the DRAM array': [1430, 1848],
  'the Enigma M4': [1486, 1961],
  'the EUV source and scanner': [1070, 1754],
  'the flip-chip package': [1128, 1855],
  'the floating-gate cell': [1296, 1959],
  'the hard disk': [1527, 2787],
  'the Jacquard head': [1110, 1407],
  'the logic module': [1046, 1292],
  'the loudspeaker': [1327, 2172],
  'the memory hierarchy as distances': [1100, 1866],
  'the MEMS microphone': [1250, 1946],
  'the mercury delay line': [1358, 2710],
  'the opened package': [1291, 1959],
  'the optical fibre': [1516, 2018],
  'the picture tube': [1622, 2314],
  'the pin press': [1337, 1814],
  'the pixel': [1510, 2076],
  'the pixel stack': [1570, 2125],
  'the quartz oscillator': [1337, 2123],
  'the sensor die': [1232, 1765],
  'the standard cell': [1301, 1470],
  'the Strowger selector': [1731, 2471],
  'the telegraph key and sounder': [1439, 1937],
  'the Teletype’s selector': [1003, 1460],
  'the tide predictor': [1537, 2704],
  'the twisted pair': [1265, 2176],
  'the valve cutaway': [1284, 2113],
  'the Williams tube': [1061, 1529],
};
/** A little under the measured height: a column narrower than 1440 px makes the stage shorter, and a placeholder taller
 *  than its model would pull the page up when it arrives. */
const UNDER = 0.9;

export function placeholderHeight(what: string): number {
  const m = LOADED[what];
  if (!m) return 520;
  return Math.round(m[typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches ? 1 : 0] * UNDER);
}

/** A placeholder of about the loaded height until `load` answers. */
export function lazyModel(what: string, load: () => Promise<Widget>): Widget {
  const el = document.createElement('div');
  el.className = 'widget relay3d m3d';
  el.style.minHeight = `${placeholderHeight(what)}px`;
  el.textContent = `Loading ${what}…`;
  let inner: Widget | null = null, dead = false;
  whenAsked(el, what, () => load()
    .then((w) => {
      if (dead) { w.destroy?.(); return; }
      inner = w;
      el.style.minHeight = '';
      el.replaceChildren(w.el);
    })
    .catch((e: unknown) => { if (!dead) el.textContent = `${what[0].toUpperCase()}${what.slice(1)} did not load (${String(e)}).`; }));
  return {
    el,
    update: () => inner?.update?.(),
    destroy: () => { dead = true; inner?.destroy?.(); },
  };
}

/** A step's widget with a model below it. */
export function withModel(base: Widget, model: Widget): Widget {
  const el = document.createElement('div');
  el.className = 'm3d-stack';
  el.append(base.el, model.el);
  return {
    el,
    update: () => { base.update?.(); model.update?.(); },
    destroy: () => { base.destroy?.(); model.destroy?.(); },
  };
}

/** Chapter 1: the transistor with its width showing. */
export const mosfet3d = (link?: BiasLink): Widget => lazyModel('the 3D transistor', () => import('./mosfet3dview').then((m) => m.mosfetView(link)));
