// EUV lithography in 3D: the light source and the scanner (loaded on demand, modelhost.ts; the model is widgets/euv3dview.ts).

import type { Widget } from '../view/stage';
import { lazyModel } from './modelhost';

export const euv3d = (scene: 'source' | 'scanner' = 'source'): Widget => lazyModel('the EUV source and scanner', () => import('./euv3dview').then((m) => m.euvView(scene)));
