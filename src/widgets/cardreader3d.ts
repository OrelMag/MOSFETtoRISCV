// Chapter P3's card reader in 3D: this entry stays tiny; the model (widgets/cardreader3dview.ts, the renderer) loads as its
// own chunks when the step opens.

import type { Deck } from '../cards/card';
import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

/** The reader feeding a computer from `deck`, `feed` edges a card; `sources`: each card's source line. */
export const cardReader3d = (deck: Deck, feed: number, sources: readonly string[]): Widget =>
  lazyModel('the card reader', () => import('./cardreader3dview').then((m) => m.readerView(deck, feed, sources)));
