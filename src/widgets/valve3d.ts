// "Three regions": the valve behind the faucet in 3D. This entry stays tiny; the model (widgets/valve3dview.ts, the renderer)
// loads as its own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';
import type { BiasLink } from './mosshare';

/** `link`: the gate and drain of the widget above, when the step shares them (mosshare.ts). */
export const valve3d = (link?: BiasLink): Widget => lazyModel('the valve cutaway', () => import('./valve3dview').then((m) => m.valveView(link)));
