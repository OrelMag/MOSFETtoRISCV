// ENIAC's decade ring counter in 3D: this entry stays tiny; the model (widgets/eniac3dview.ts, the renderer) loads as its own chunks.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const eniac3d = (): Widget => lazyModel('the decade ring counter', () => import('./eniac3dview').then((m) => m.eniacView()));
