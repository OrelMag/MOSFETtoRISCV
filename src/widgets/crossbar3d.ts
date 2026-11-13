// The crossbar switch in 3D: this entry stays tiny; the model (widgets/crossbar3dview.ts, the renderer) loads as its own chunks
// when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const crossbar3d = (): Widget => lazyModel('the crossbar switch', () => import('./crossbar3dview').then((m) => m.crossbarView()));
