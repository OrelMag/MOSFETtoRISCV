// The CMOS 4T pixel in 3D: this entry stays tiny; the model (widgets/pixel4t3dview.ts, the renderer) loads as its own
// chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const pixel4t3d = (): Widget => lazyModel('the pixel', () => import('./pixel4t3dview').then((m) => m.pixel4tView()));
