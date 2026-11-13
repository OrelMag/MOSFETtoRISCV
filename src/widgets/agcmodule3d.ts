// The AGC logic module in 3D: this entry stays tiny; the model (widgets/agcmodule3dview.ts, the renderer) loads as its own chunks.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const agcModule3d = (): Widget => lazyModel('the logic module', () => import('./agcmodule3dview').then((m) => m.agcModuleView()));
