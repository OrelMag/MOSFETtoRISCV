// Chapter exchange's Teletype Model 33 selector in 3D: this entry stays tiny; the model (widgets/teletype3dview.ts, the
// renderer) loads as its own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const teletype3d = (): Widget => lazyModel('the Teletype’s selector', () => import('./teletype3dview').then((m) => m.teletypeView()));
