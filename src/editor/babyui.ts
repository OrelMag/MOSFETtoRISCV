// Edit… on the Baby in the CPU drawer: the program held in the part (editor/babypart.ts), in the Baby's assembly (ssem/asm.ts),
// with Kilburn's routine on a number of your own as the sample. Apply is one undo step; the drawer then power-cycles the
// machine (BabyMonitor.sync reports a new program) so the store starts with it.

import { h } from '../ui/dom';
import { assembleSsem } from '../ssem/asm';
import { kilburnSource } from '../ssem/programs';
import type { Editor } from './editor';
import { dialog } from './fileui';
import { setRef } from './ops';

export function openBabyProgram(ed: Editor, part: string, src: string): void {
  const text = h('textarea', { rows: '18', spellcheck: 'false', class: 'sb-sap-src', 'aria-label': 'Baby assembly' }, src) as HTMLTextAreaElement;
  const msg = h('p', { class: 'sb-dlg-msg' });
  const n = h('input', { type: 'number', min: '2', max: '999', value: '60', 'aria-label': 'The number to factor' }) as HTMLInputElement;
  const sample = h('button', { class: 'btn sm', onclick: () => { text.value = kilburnSource(Math.max(2, Math.min(999, Math.floor(Number(n.value)) || 60))); msg.textContent = ''; } }, 'Kilburn’s routine on');
  const apply = () => {
    const r = assembleSsem(text.value);
    if (r.errors.length) {
      msg.className = 'sb-dlg-msg err';
      msg.textContent = r.errors.slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join(' · ');
      return;
    }
    const e = setRef(ed.doc, part, { baby: { src: text.value } }, ed.defOf);
    if (e.reason) return void ed.toast(e.reason, 'err');
    ed.edit(() => e.doc);
    dlg.close();
  };
  const dlg = dialog(ed, 'The Baby’s program', [
    h('p', { class: 'sb-dlg-lead' }, 'One store line per statement, from line 0 (or after a number and a colon: 20:). JMP s, JRP s, LDN s, STO s, SUB s, CMP, STP (STOP), and NUM v for a number; labels end in a colon. ',
      'The program is the store’s power-on contents; applying it power-cycles the machine. Kilburn’s highest-factor routine finds the largest proper factor of its number and leaves it in line 27.'),
    h('label', { class: 'sb-row' }, sample, n),
    text, msg,
  ], [h('button', { class: 'btn sm ghost', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'btn sm primary', onclick: apply }, 'Apply')]);
  text.focus();
}
