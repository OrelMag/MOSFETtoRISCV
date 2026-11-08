// Light in glass, in 3D: the fibre cut away (loaded on demand, modelhost.ts; the model is widgets/fibre3dview.ts).

import type { Widget } from '../view/stage';
import { lazyModel } from './modelhost';

export const fibre3d = (initial: 'multi' | 'single' = 'multi'): Widget => lazyModel('the optical fibre', () => import('./fibre3dview').then((m) => m.fibreView(initial)));
