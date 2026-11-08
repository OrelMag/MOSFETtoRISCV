// The half-wave dipole in 3D (loaded on demand, modelhost.ts): this entry stays tiny; the model loads as its own chunk.

import type { Widget } from '../view/stage';
import { lazyModel } from './modelhost';

export const dipole3d = (): Widget => lazyModel('the dipole', () => import('./dipole3dview').then((m) => m.dipoleView()));
