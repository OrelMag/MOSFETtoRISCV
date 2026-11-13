// Chapter pixels's scan-out on a picture tube, in 3D: this entry stays tiny; the model (widgets/crt3dview.ts, the renderer)
// loads as its own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

/** The placeholder's height, a little under the loaded model's (stage + its panel, measured: about 1 490 px wide, 2 090 px on a
 *  phone), so the page below does not jump when it arrives; lazyModel drops it once the model is in. */
const PLACEHOLDER = { wide: 1400, narrow: 1950 };

export const crt3d = (): Widget => {
  const w = lazyModel('the picture tube', () => import('./crt3dview').then((m) => m.crtView()));
  w.el.style.minHeight = `${matchMedia('(max-width: 600px)').matches ? PLACEHOLDER.narrow : PLACEHOLDER.wide}px`;
  return w;
};
