// Chapter P3's Jacquard loom in 3D: this entry stays tiny; the model (widgets/loom3dview.ts, the renderer) loads as its own
// chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const loom3d = (): Widget => lazyModel('the Jacquard head', () => import('./loom3dview').then((m) => m.loomView()));
