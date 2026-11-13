// A lidded flip-chip package, in 3D and cut open (loaded on demand, modelhost.ts; the model is widgets/flipchip3dview.ts).

import type { Widget } from '../view/stage';
import { lazyModel } from './modelhost';

export const flipchip3d = (): Widget => lazyModel('the flip-chip package', () => import('./flipchip3dview').then((m) => m.flipchipView()));
