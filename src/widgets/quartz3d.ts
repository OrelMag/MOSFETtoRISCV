// The quartz oscillator in 3D: this entry stays tiny; the model (widgets/quartz3dview.ts, the renderer) loads as its own
// chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const quartz3d = (): Widget => lazyModel('the quartz oscillator', () => import('./quartz3dview').then((m) => m.quartzView()));
