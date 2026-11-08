// The memory hierarchy as distances in 3D: this entry stays tiny; the model (widgets/hierarchy3dview.ts, the renderer)
// loads as its own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const hierarchy3d = (): Widget => lazyModel('the memory hierarchy as distances', () => import('./hierarchy3dview').then((m) => m.hierarchyView()));
