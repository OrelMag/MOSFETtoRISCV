// Chapter P3's pin press in 3D: this entry stays tiny; the model (widgets/press3dview.ts, the renderer) loads as its own
// chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const press3d = (): Widget => lazyModel('the pin press', () => import('./press3dview').then((m) => m.pressView()));
