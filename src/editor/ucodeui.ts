// "Microcode…": the microcode painter (widgets/ucodepainter.ts) on a placed multicycle CPU. The CPU's controller is
// the library part mc_micro (or, edited, a part { ucode: Microprogram }); Apply swaps that part's reference, so the
// wires stay and the change is one undo step, and the CPU drawer's golden model follows the rebuilt CPU.

import { isBook } from '../lib/ucode';
import type { Editor } from './editor';
import type { PartRef } from './model';
import { setRef } from './ops';
import { microcodePart, microprogramOfPart } from './ucodepart';
import { undoKey } from '../ui/dom';

/** Open the painter on the chip's multicycle CPU. */
export function openMicrocodeEditor(ed: Editor): void {
  const part = microcodePart(ed.doc, ed.sel.parts);
  if (!part) return void ed.toast('Microcode needs a multicycle CPU with a microprogrammed controller (Open in Sandbox on chapter 23\'s microcode CPU)', 'err');
  void import('../widgets/ucodepainter').then((m) => m.openMicrocode({
    program: microprogramOfPart(part), host: ed.el, mode: 'dialog', subtitle: part.id,
    onClose: () => ed.view.svg.focus?.(),
    onApply: (p) => {
      const ref: PartRef = isBook(p) ? { lib: 'mc_micro' } : { ucode: p };
      let err = '';
      ed.editWs((ws) => {
        const r = setRef(ws.chips[ed.chipId], part.id, ref, ed.defOf);
        if (r.reason) { err = r.reason; return ws; }
        return { ...ws, chips: { ...ws.chips, [ed.chipId]: r.doc } };
      });
      if (err) return void ed.toast(err, 'err');
      ed.toast(isBook(p) ? `The controller runs the book's microcode again (${undoKey()} undoes)` : `The controller runs your microcode (${undoKey()} undoes); the CPU drawer checks it against the golden model`);
    },
  }));
}
