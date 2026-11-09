// Chapter silicon's standard cell in 3D. Stays tiny: the model loads as its own chunk.

import type { Widget } from '../view/stage';
import { lazyModel } from './modelhost';

export const cell3d = (): Widget => lazyModel('the standard cell', () => import('./cell3dview').then((m) => m.cellView()));
