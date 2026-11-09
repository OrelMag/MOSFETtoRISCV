// Chapter telegraph: a telegraph key and sounder in 3D (loaded on demand, modelhost.ts).

import type { Widget } from '../view/stage';
import { lazyModel } from './modelhost';

export const telegraph3d = (): Widget => lazyModel('the telegraph key and sounder', () => import('./telegraph3dview').then((m) => m.telegraphView()));
