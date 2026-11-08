// The image sensor's optical stack in 3D: this entry stays tiny; the model (widgets/sensorstack3dview.ts, the renderer)
// loads as its own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

/** A 2 × 2 Bayer quad cut open, front- or back-side illuminated, with rays traced through it. */
export const sensorStack3d = (): Widget =>
  lazyModel('the pixel stack', () => import('./sensorstack3dview').then((m) => m.sensorStackView()));
