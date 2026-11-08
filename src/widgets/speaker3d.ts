// The loudspeaker and microphone in 3D: this entry stays tiny; the model (widgets/speaker3dview.ts, the renderer) loads as
// its own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const speaker3d = (): Widget => lazyModel('the loudspeaker', () => import('./speaker3dview').then((m) => m.speakerView()));
