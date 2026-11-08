// Babbage's carry in 3D: this entry stays tiny; the model (widgets/babbage3dview.ts, the renderer) loads as its own chunks.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const babbage3d = (): Widget => lazyModel('Babbage’s carry', () => import('./babbage3dview').then((m) => m.babbageView()));
