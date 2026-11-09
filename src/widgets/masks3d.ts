// Chapter silicon's "How chips are made", the inverter in 3D mask by mask. Stays tiny: the model loads as its own chunk.

import type { Widget } from '../view/stage';
import { lazyModel } from './modelhost';

export const masks3d = (): Widget => lazyModel('the chip, mask by mask', () => import('./masks3dview').then((m) => m.masksView()));
