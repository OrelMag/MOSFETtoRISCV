// Chapter 37's floating gate in 3D: this entry stays tiny; the model (widgets/fgate3dview.ts, the renderer) loads as its
// own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const fgate3d = (): Widget => lazyModel('the floating-gate cell', () => import('./fgate3dview').then((m) => m.fgateView()));
