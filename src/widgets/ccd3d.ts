// The three-phase CCD in 3D: this entry stays tiny; the model (widgets/ccd3dview.ts, the renderer) loads as its own
// chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const ccd3d = (): Widget => lazyModel('the CCD', () => import('./ccd3dview').then((m) => m.ccdView()));
