// The MEMS microphone in 3D: this entry stays tiny; the model (widgets/mems3dview.ts, the renderer) loads as its own chunks
// when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const mems3d = (): Widget => lazyModel('the MEMS microphone', () => import('./mems3dview').then((m) => m.micView()));
