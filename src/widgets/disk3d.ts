// The flash chapter's hard disk in 3D: this entry stays tiny; the model (widgets/disk3dview.ts, the renderer) loads as its own
// chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const disk3d = (): Widget => lazyModel('the hard disk', () => import('./disk3dview').then((m) => m.diskView()));
