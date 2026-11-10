// "Lay out by logic depth" in the sandbox: the canvas menu's row and the import summary's button. The layout is measured
// against the drawing first (relayout.ts relayoutOffer) and offered only where it reads better; elsewhere the row stays,
// switched off, with the numbers that say why. Measured when the menu opens, once per document version.

import type { MenuEntry } from '../ui/menu';
import { undoKey } from '../ui/dom';
import type { Editor } from './editor';
import { isGenerated } from './hdl';
import type { ChipDoc, PartRef, Workspace } from './model';
import type { PartResult } from './parts';
import { MEASURE_MAX_PARTS, offerText, type RelayoutOffer, relayoutOffer } from './relayout';

/** Strictly worse, or a tie (the layout would change the drawing for nothing). */
const asDrawn = (o: Extract<RelayoutOffer, { kind: 'worse' }>) =>
  o.after.crossings + o.after.throughParts > o.before.crossings + o.before.throughParts ? 'Already reads better as drawn' : 'Reads as well as drawn';

const cache = new WeakMap<ChipDoc, RelayoutOffer>();

const resolver = (ed: Editor) => (ref: PartRef): PartResult => ed.defOfRef(ref) ?? { error: 'a part that does not resolve' };

/** The offer for a chip of the workspace (cached per document object: an edit makes a new one). */
export function offerFor(ed: Editor, ws: Workspace, id: string): RelayoutOffer {
  const doc = ws.chips[id];
  let o = cache.get(doc);
  if (!o) cache.set(doc, (o = relayoutOffer(doc, resolver(ed), isGenerated(ws, id))));
  return o;
}

function apply(ed: Editor, o: Extract<RelayoutOffer, { kind: 'better' }>): void {
  ed.edit(() => o.doc);
  ed.fitView();
  ed.toast(`Laid out by logic depth: ${offerText(o.before, o.after)}${o.dropped.length ? `; dropped ${o.dropped.join(', ')}` : ''}. ${undoKey()} undoes it`);
}

/** The canvas menu's row for the open chip (null: nothing to place). */
export function relayoutRow(ed: Editor): MenuEntry {
  const doc = ed.doc;
  if (!doc.parts.length) return null;
  const label = 'Lay out by logic depth';
  if (doc.parts.length > MEASURE_MAX_PARTS && !cache.has(doc)) {
    return { label, hint: `Not measured yet (${doc.parts.length} parts): measured first, applied only if it reads better`, run: () => {
      const o = offerFor(ed, ed.ws, doc.id);
      if (o.kind === 'better') apply(ed, o);
      else ed.toast(o.kind === 'refused' ? `Not laid out: ${o.why}` : `Not laid out: ${asDrawn(o).toLowerCase()} (${offerText(o.before, o.after)})`);
    } };
  }
  const o = offerFor(ed, ed.ws, doc.id);
  if (o.kind === 'refused') return { label, why: o.why };
  if (o.kind === 'worse') return { label, why: `${asDrawn(o)} (${offerText(o.before, o.after)})` };
  return { label, hint: offerText(o.before, o.after), run: () => apply(ed, o) };
}

/** Of the chips just imported, those a layout by logic depth draws better, with their offers. */
export function betterOf(ed: Editor, ws: Workspace, ids: string[]): { id: string; offer: Extract<RelayoutOffer, { kind: 'better' }> }[] {
  return ids.flatMap((id) => {
    if (ws.chips[id].parts.length > MEASURE_MAX_PARTS) return [];
    const offer = offerFor(ed, ws, id);
    return offer.kind === 'better' ? [{ id, offer }] : [];
  });
}
