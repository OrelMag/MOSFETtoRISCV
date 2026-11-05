// The naval Enigma M4 in 3D: this entry stays tiny; the model (widgets/enigma3dview.ts, the renderer) loads as its own chunks
// when the step opens. Waiting for its code-breaking chapter.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';
import type { EnigmaViewOptions } from './enigma3dview';

export const enigma3d = (opts: EnigmaViewOptions = {}): Widget => lazyModel('the Enigma M4', () => import('./enigma3dview').then((m) => m.enigmaView(opts)));
