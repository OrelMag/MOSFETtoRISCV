// Chapter 40's Strowger selector in 3D: this entry stays tiny; the model (widgets/strowger3dview.ts, the renderer) loads
// as its own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const strowger3d = (): Widget => lazyModel('the Strowger selector', () => import('./strowger3dview').then((m) => m.strowgerView()));
