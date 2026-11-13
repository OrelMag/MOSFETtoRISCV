// Chapter silicon's planar / fin / nanosheet transistors in 3D: this entry stays tiny; the model (widgets/finfet3dview.ts, the
// renderer) loads as its own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const finfet3d = (): Widget => lazyModel('planar, fin and nanosheet transistors', () => import('./finfet3dview').then((m) => m.finfetView()));
