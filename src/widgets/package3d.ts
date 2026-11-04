// Chapter 41: the package between a pad and a pin, in 3D (loaded on demand, modelhost.ts).

import type { Widget } from '../view/stage';
import { lazyModel } from './modelhost';

export const package3d = (): Widget => lazyModel('the opened package', () => import('./package3dview').then((m) => m.packageView()));
