// EDSAC's mercury delay line in 3D: this entry stays tiny; the model (widgets/mercury3dview.ts, the renderer) loads as its
// own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const mercury3d = (): Widget => lazyModel('the mercury delay line', () => import('./mercury3dview').then((m) => m.mercuryView()));
