// The 3D NAND string in 3D: this entry stays tiny; the model (widgets/nand3dview.ts, the renderer) loads as its own chunks
// when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const nand3d = (): Widget => lazyModel('the 3D NAND string', () => import('./nand3dview').then((m) => m.nandView()));
