// Importing another tool's circuits (Digital .dig, Logisim-evolution .circ): the file importer that reads them
// (import/digital.ts, import/logisim.ts, DOM-free), and the summary shown before anything is written: the chips, what
// each kind of part became, what could not be brought over. Import adds the chips to a folder of their own (one undo
// step) and opens the top one; nothing already in the workspace changes.

import '../styles/editor-import.css';
import type { Editor } from '../editor/editor';
import { dialog, registerFileImporter } from '../editor/fileui';
import { addFolder, cleanFolderName, findFolder, moveToFolder } from '../editor/folders';
import { h } from '../ui/dom';
import type { ImportFailure, ImportOptions, ImportResult, SourceFile } from './report';

export interface CircuitReader {
  /** "Digital", "Logisim-evolution": named in the dialog. */
  tool: string;
  accept: string[];
  takes(name: string, text: string): boolean;
  read(files: SourceFile[], opts: ImportOptions): ImportResult | ImportFailure;
}

const base = (name: string) => name.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');

function show(ed: Editor, reader: CircuitReader, files: SourceFile[]): void {
  const r = reader.read(files, { taken: new Set(Object.keys(ed.ws.chips)) });
  const title = files.length === 1 ? files[0].name : `${files.length} ${reader.tool} files`;
  if ('error' in r) return void ed.toast(`${title}: ${r.error}`, 'err');
  const top = r.chips.find((c) => c.id === r.top) ?? r.chips[r.chips.length - 1];
  const folder = h('input', { type: 'text', value: base(files.length === 1 ? files[0].name : top.name), 'aria-label': 'Folder', class: 'sb-imp-folder' }) as HTMLInputElement;
  const tests = r.chips.reduce((a, c) => a + (c.tests?.length ?? 0), 0);
  const chips = h('ul', { class: 'sb-imp-chips' }, [...r.chips].reverse().map((c) => h('li', { class: c.id === top.id ? 'top' : '' },
    h('span', null, h('b', null, c.name), c.id === top.id ? h('span', { class: 'muted' }, ' (top)') : null),
    h('span', { class: 'muted mono' }, `${c.parts.length} part${c.parts.length === 1 ? '' : 's'}${c.tests?.length ? ` · ${c.tests.length} test${c.tests.length > 1 ? 's' : ''}` : ''}`))));
  const map = h('table', { class: 'sb-imp-map' },
    h('thead', null, h('tr', null, h('th', null, reader.tool), h('th', null, 'becomes'), h('th', null, h('span', { class: 'sr-only' }, 'status')))),
    h('tbody', null, r.mapping.map((m) => h('tr', { class: m.status },
      h('td', { class: 'mono' }, m.from, m.count > 1 ? h('span', { class: 'muted' }, ` ×${m.count}`) : null),
      h('td', null, m.becomes),
      h('td', { class: 'mark', title: m.status === 'ok' ? 'brought over' : m.status === 'stub' ? 'no equivalent: an empty chip with its pins' : 'left out' }, m.status === 'ok' ? '✓' : m.status === 'stub' ? '!' : '–')))));
  const body: (Node | string)[] = [
    h('p', { class: 'sb-dlg-lead' }, `${reader.tool}: ${r.chips.length} circuit${r.chips.length === 1 ? '' : 's'}${tests ? `, ${tests} test table${tests > 1 ? 's' : ''}` : ''}. They become chips in a folder of their own; nothing you have is overwritten.`),
    h('div', { class: 'sb-imp-cols' },
      h('div', null, h('h4', null, 'Chips'), chips, h('label', { class: 'sb-imp-folder-row' }, 'Folder ', folder)),
      h('div', null, h('h4', null, 'What each part becomes'), map)),
  ];
  if (r.problems.length) {
    body.push(h('div', { class: 'sb-imp-problems', role: 'note' },
      h('p', null, h('b', null, `${r.problems.length} thing${r.problems.length > 1 ? 's' : ''} to know`)),
      h('ul', null, r.problems.slice(0, 12).map((p) => h('li', null, p)), r.problems.length > 12 ? h('li', null, `… and ${r.problems.length - 12} more`) : null)));
  }
  const go = h('button', { class: 'btn primary sm' }, `Import ${r.chips.length} chip${r.chips.length === 1 ? '' : 's'}`);
  const cancel = h('button', { class: 'btn sm' }, 'Cancel');
  const d = dialog(ed, `Import ${title}`, body, [cancel, go], 'sb-imp-dlg');
  cancel.addEventListener('click', d.close);
  go.addEventListener('click', () => {
    const name = cleanFolderName(folder.value) ?? base(title);
    ed.editWs((ws) => {
      let next = { ...ws, chips: { ...ws.chips } };
      for (const c of r.chips) next.chips[c.id] = c;
      let f = findFolder(next, name)?.name;
      if (!f) {
        const a = addFolder(next, name);
        if (!('error' in a)) { next = a.ws; f = a.name; }
      }
      if (f) for (const c of r.chips) next = moveToFolder(next, c.id, f);
      return next;
    });
    d.close();
    ed.openChip(top.id);
    ed.toast(`Imported ${r.chips.length} chip${r.chips.length === 1 ? '' : 's'} into “${name}”${tests ? `, with ${tests} test table${tests > 1 ? 's' : ''} (Tests)` : ''}. Ctrl+Z undoes it`);
  });
  go.focus();
}

/** Registers a reader as a file importer: picked or dropped, alone or with the other files of its project. */
export function registerCircuitReader(reader: CircuitReader): void {
  registerFileImporter({
    accept: reader.accept,
    takes: reader.takes,
    run: (ed, name, text) => show(ed, reader, [{ name, text }]),
    runMany: (ed, files) => show(ed, reader, files),
  });
}
