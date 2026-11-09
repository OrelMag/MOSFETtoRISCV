// Chapter pixels's scan-out on a picture tube, in 3D: this entry stays tiny; the model (widgets/crt3dview.ts, the renderer)
// loads as its own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const crt3d = (): Widget => lazyModel('the picture tube', () => import('./crt3dview').then((m) => m.crtView()));
