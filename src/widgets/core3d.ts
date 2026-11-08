// A plane of ferrite cores in 3D: this entry stays tiny; the model (widgets/core3dview.ts, the renderer) loads as its own
// chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const core3d = (): Widget => lazyModel('the core memory plane', () => import('./core3dview').then((m) => m.coreView()));
