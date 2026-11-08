// "Three regions": the valve behind the faucet in 3D. This entry stays tiny; the model (widgets/valve3dview.ts, the renderer)
// loads as its own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const valve3d = (): Widget => lazyModel('the valve cutaway', () => import('./valve3dview').then((m) => m.valveView()));
