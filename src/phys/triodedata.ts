// The real tube beside the model: the Tung-Sol 6SN7GTB data sheet's (today's reissue, hosted by Electro-Harmonix: not ENIAC-era data) transfer characteristics (plate current against grid
// voltage, heater 6.3 V, "Ip = f(Eg)", page 3), read off the published chart at every 2 V of grid (±0.5 mA: the chart's
// grid is 5 mA by 2 V). https://shop.ehx.com/catalog/tubes-specs/6SN7GTB%20TS.pdf (DOM-free, tested against phys/triode.ts).

import { plateCurrent } from './triode';

export const TUNGSOL_SHEET = 'Tung-Sol 6SN7GTB data sheet (the current reissue, as Electro-Harmonix publishes it), Ip = f(Eg) at Ef 6.3 V, read off the chart (±0.5 mA)';
export const TUNGSOL_URL = 'https://shop.ehx.com/catalog/tubes-specs/6SN7GTB%20TS.pdf';

/** Grid voltages read (V). */
export const TS_GRID = [0, -2, -4, -6, -8, -10, -12, -14, -16] as const;
/** Plate current (mA) at each of TS_GRID, per plate voltage (V). */
export const TUNGSOL_IP: Readonly<Record<200 | 250 | 300, readonly number[]>> = {
  200: [30.9, 22.5, 13.5, 6.9, 2.2, 0.6, 0, 0, 0],
  250: [42.9, 34.5, 23.7, 14.6, 8.1, 3.7, 1.2, 0.35, 0],
  300: [53.4, 44.6, 33.7, 23.1, 15.8, 9.3, 4.7, 1.8, 0],
};
export const TS_PLATES = [200, 250, 300] as const;

/** The model against the sheet at each point read: its error in mA (model − sheet), and the largest. */
export function fitErrors(): { ep: number; vg: number; sheet: number; model: number; err: number }[] {
  return TS_PLATES.flatMap((ep) => TS_GRID.map((vg, i) => {
    const sheet = TUNGSOL_IP[ep][i], model = plateCurrent(vg, ep) * 1e3;
    return { ep, vg, sheet, model, err: model - sheet };
  }));
}
export const worstFit = () => fitErrors().reduce((a, b) => (Math.abs(b.err) > Math.abs(a.err) ? b : a));
