// The image sensor die in 3D: this entry stays tiny; the model (widgets/sensordie3dview.ts, the renderer) loads as its
// own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

/** The IMX183's die capturing a moving object with a rolling or a global shutter. */
export const sensorDie3d = (): Widget =>
  lazyModel('the sensor die', () => import('./sensordie3dview').then((m) => m.sensorDieView()));
