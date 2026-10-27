// Load program for a SAP-1 in the sandbox (the CPU drawer's Edit… on Examples ▸ SAP-1): a sample or SAP-1 assembly
// assembled into 16 bytes and put into the RAM chip's two 74LS189s as their power-on contents (examplesap.ts
// withSapProgram), one undo step, then a power cycle so the computer starts on it.

import { assembleSap } from '../sap/asm';
import { disasm } from '../sap/isa';
import { SAP_PROGRAMS } from '../sap/programs';
import { h } from '../ui/dom';
import { partAt } from './cpu';
import type { Editor } from './editor';
import { withSapProgram } from './examplesap';
import { dialog } from './fileui';
import type { ChipDoc } from './model';
import type { SapMonitor } from './sapmon';

const IS_189 = /^ls189(_i([0-9a-f]{16}))?$/;

/** The RAM chip a SAP-1's 189s are in, and the bytes they hold at power-on; or why there is none. */
export function sapRamChip(ed: Editor, prefix: string): { doc: ChipDoc; bytes: number[] } | { error: string } {
  const at = partAt(ed.doc, `${prefix}ram`, ed.ws.chips);
  const ref = at?.part.ref;
  if (!ref || !('chip' in ref)) return { error: prefix ? 'a placed SAP-1 part keeps its RAM inside: program it through its prog, addrSw, dataSw and write pins, then rst' : 'no RAM chip (a user chip placed as ram)' };
  const doc = ed.ws.chips[ref.chip];
  const nib = (id: string) => {
    const p = doc?.parts.find((q) => q.id === id);
    const m = p && 'lib' in p.ref ? p.ref.lib.match(IS_189) : null;
    return m ? Array.from(m[2] ?? '0'.repeat(16), (c) => parseInt(c, 16)) : null;
  };
  const lo = nib('lo'), hi = nib('hi');
  if (!doc || !lo || !hi) return { error: 'the RAM chip has no two 74LS189s named lo and hi' };
  return { doc, bytes: lo.map((v, i) => (hi[i] << 4) | v) };
}

/** The bytes as source the assembler reads back (data and code alike: .byte, the instruction as a comment). */
const asSource = (bytes: number[]) => bytes.map((b, i) => `.byte 0x${b.toString(16).toUpperCase().padStart(2, '0')}   ; ${i.toString(16).toUpperCase()}: ${disasm(b)}`).join('\n');

export function openSapProgram(ed: Editor, mon: SapMonitor): void {
  const ram = sapRamChip(ed, mon.desc?.prefix ?? '');
  if ('error' in ram) return void ed.toast(`Load program: ${ram.error}`, 'err');
  const same = (src: string) => { const r = assembleSap(src); return !r.errors.length && ram.bytes.every((b, i) => b === (r.bytes[i] ?? 0)); };
  const cur = SAP_PROGRAMS.find((p) => same(p.src));
  const text = h('textarea', { rows: '16', spellcheck: 'false', class: 'sb-sap-src', 'aria-label': 'SAP-1 assembly' }, cur?.src ?? asSource(ram.bytes)) as HTMLTextAreaElement;
  const pick = h('select', { 'aria-label': 'Sample programs' },
    h('option', { value: '' }, cur ? `${cur.name} (in the RAM)` : 'In the RAM now'),
    SAP_PROGRAMS.map((p) => h('option', { value: p.id }, `${p.name} → ${p.outs.slice(0, 6).join(', ')}${p.outs.length > 6 ? ' …' : ''}`))) as HTMLSelectElement;
  pick.addEventListener('change', () => {
    const p = SAP_PROGRAMS.find((q) => q.id === pick.value);
    text.value = p ? p.src : cur?.src ?? asSource(ram.bytes);
    msg.textContent = '';
  });
  const msg = h('p', { class: 'sb-dlg-msg' });
  const load = () => {
    const r = assembleSap(text.value);
    if (r.errors.length) {
      msg.className = 'sb-dlg-msg err';
      msg.textContent = r.errors.slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join(' · ');
      return;
    }
    const now = sapRamChip(ed, mon.desc?.prefix ?? '');
    if ('error' in now) return void ed.toast(`Load program: ${now.error}`, 'err');
    ed.editWs((ws) => ({ ...ws, chips: { ...ws.chips, [now.doc.id]: withSapProgram(now.doc, r.bytes) } }));
    // The bytes are power-on contents: power-cycle so the computer starts on them (a rebuild carries the old state).
    ed.sim.flush();
    ed.sim.reset();
    ed.toast(`Loaded ${r.bytes.length} bytes into the RAM: the computer was power-cycled`);
    dlg.close();
  };
  const dlg = dialog(ed, 'Load a program into the RAM', [
    h('p', { class: 'sb-dlg-lead' }, 'SAP-1 assembly, a byte a line from address 0: LDA, ADD, SUB, STA, LDI, JMP, JC, JZ, OUT, HLT, labels and .byte. ',
      'The bytes become the two 74LS189s’ power-on contents (they stay through Reset; Undo takes them back). By hand instead, at any time: PROG on, an address and a byte on the DIP switches, W, … PROG off, RESET (E), Run.'),
    h('label', { class: 'sb-row' }, h('span', null, 'Sample'), pick),
    text, msg,
  ], [h('button', { class: 'btn sm ghost', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'btn sm primary', onclick: load }, 'Load')]);
  text.focus();
}
