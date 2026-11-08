// Kelvin's tide predictor in 3D beside the Fourier step of "Signals and spectrum": this entry stays tiny; the model
// (widgets/tide3dview.ts, the renderer) loads as its own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const tide3d = (): Widget => lazyModel('the tide predictor', () => import('./tide3dview').then((m) => m.tideView()));
