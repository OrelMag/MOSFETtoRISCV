// Files and links for the sandbox: the toolbar's File menu (export / import chips, share link,
// Verilog, images, the chip manager), share-link banners for #/sandbox/s/<payload>, drag and
// drop of exported files onto the canvas, and the autosave indicator. Everything that changes
// the workspace is one undo step; nothing is ever imported without the user's click.

import '../styles/editor-files.css';
import { exportHdl } from '../sim/svexport';
import { h, icon, placeMenu, s } from '../ui/dom';
import { registerToolbarAction, type Editor } from './editor';
import { openIsaEditor } from './isaui';
import { dropDeckFile } from './cardui';
import { isDeckFile } from '../cards/card';
import { addFolder, folderGroups, newFolderName, removeFolder } from './folders';
import type { ChipDoc } from './model';
import { projectNameOf, readProjects } from './projects';
import {
  chipFileName, chipInfo, deleteChip, duplicateChip, fileBase, SHARE_WARN, shareUrl, summarize, summaryLine,
  workspaceFileName, type ImportSummary,
} from './files';
import { pngImage, saveFile, svgImage } from '../view/image';
import { decodeShare, encodeShare } from './share';
import { BACKUP_KEY, closure, deleteLocalData, exportJson, importChips, importJson, localData, type DataScope } from './store';

// ---------------------------------------------------------------------------------------------
// Small DOM helpers

/** Icons this module needs that the site's set lacks (same 24×24 stroke style). */
const GLYPHS: Record<string, string> = {
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 10l5-5 5 5M5 20h14"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  stack: '<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 0 1 2-2h11"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
};
export function glyph(name: string, size = 16): SVGSVGElement {
  if (!GLYPHS[name]) return icon(name, size);
  const el = s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  el.innerHTML = GLYPHS[name];
  return el;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

/** A modal dialog over the editor (Esc or a click outside closes it). */
export function dialog(ed: Editor, title: string, body: (Node | string | null)[], foot: HTMLElement[] = [], cls = ''): { el: HTMLElement; body: HTMLElement; close: () => void } {
  closeMenu();
  const close = () => {
    ov.remove();
    ed.view.svg.focus({ preventScroll: true });
  };
  const content = h('div', { class: 'sb-dlg-body' }, body);
  const ov = h('div', { class: `sb-help sb-dlg ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: (e: Event) => { if (e.target === ov) close(); } },
    h('div', { class: 'panel' },
      h('div', { class: 'sb-help-head' }, h('h3', null, title), h('button', { class: 'btn ghost icon-only', 'aria-label': 'Close', onclick: close }, icon('close', 16))),
      content,
      h('div', { class: 'sb-dlg-foot' }, foot.length ? foot : h('button', { class: 'btn primary sm', onclick: close }, 'OK'))));
  ov.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
  ed.el.append(ov);
  (ov.querySelector('.sb-dlg-foot button') as HTMLButtonElement | null)?.focus();
  return { el: ov, body: content, close };
}

// ---------------------------------------------------------------------------------------------
// The File menu

let menu: HTMLElement | null = null;
/** What had the focus when the menu opened: Esc puts it back there. */
let opener: HTMLElement | null = null;
const onOutside = (e: PointerEvent) => {
  if (menu && !menu.contains(e.target as Node) && !(e.target as Element).closest?.('[data-action="file"]')) closeMenu();
};
const onMenuKey = (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return;
  const back = opener;
  closeMenu();
  if (back?.isConnected) back.focus();
};
function closeMenu(): void {
  menu?.remove();
  menu = null;
  opener = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onMenuKey, true);
}

interface MenuItem { icon: string; label: string; hint: string; run(ed: Editor): void }
const MENU: (MenuItem | null)[] = [
  { icon: 'download', label: 'Export this chip…', hint: 'the chip and every chip inside it, as a .json file', run: (ed) => exportChip(ed) },
  { icon: 'download', label: 'Export all chips…', hint: 'this project, its folders and favorites, as a .json file', run: (ed) => exportAll(ed) },
  { icon: 'upload', label: 'Import…', hint: 'chips from an exported file, Verilog (.v, .sv) or a Yosys netlist (or drop it on the canvas)', run: (ed) => pickImport(ed) },
  null,
  { icon: 'link', label: 'Share link…', hint: 'the circuit packed into a URL: nothing is uploaded', run: (ed) => void shareDialog(ed) },
  null,
  { icon: 'code', label: 'Export Verilog', hint: 'the whole hierarchy, structural SystemVerilog (.sv)', run: (ed) => exportVerilog(ed) },
  { icon: 'image', label: 'Export image (SVG)', hint: 'the canvas as drawn, in the current theme', run: (ed) => exportImage(ed, 'svg') },
  { icon: 'image', label: 'Export image (PNG)', hint: 'the same at 2× resolution', run: (ed) => void exportImage(ed, 'png') },
  null,
  { icon: 'code', label: 'Instruction sets…', hint: 'custom ISAs: an assembler and a listing for your CPU from a table', run: (ed) => openIsaEditor(ed) },
  { icon: 'stack', label: 'Manage chips…', hint: 'sizes, who uses what; open, duplicate, delete', run: (ed) => manageDialog(ed) },
  { icon: 'trash', label: 'Delete local data…', hint: 'erase what this site keeps in this browser', run: (ed) => deleteDataDialog(ed) },
];

function openMenu(ed: Editor): void {
  if (menu) return closeMenu();
  const btn = ed.actionAnchor('file');
  opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : btn;
  const r = btn?.getBoundingClientRect() ?? new DOMRect(16, 60, 0, 0);
  menu = h('div', { class: 'sb-menu', role: 'menu', 'aria-label': 'File' });
  for (const it of MENU) {
    if (!it) { menu.append(h('hr')); continue; }
    menu.append(h('button', { role: 'menuitem', onclick: () => { closeMenu(); it.run(ed); } },
      glyph(it.icon), h('span', null, h('b', null, it.label), h('small', null, it.hint))));
  }
  ed.el.append(menu);
  const w = menu.offsetWidth;
  placeMenu(menu, r, Math.max(8, Math.min(r.right - w, innerWidth - w - 8)));
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onMenuKey, true);
  menu.querySelector('button')?.focus();
}

registerToolbarAction({ id: 'file', title: 'Export, import, share', icon: 'menu', label: 'File', order: 5, run: openMenu });

// ---------------------------------------------------------------------------------------------
// Export / import

function exportChip(ed: Editor): void {
  saveFile(chipFileName(ed.doc), exportJson(ed.ws, [ed.chipId]));
  const n = closure(ed.ws, [ed.chipId]).length;
  ed.toast(`Exported ${ed.doc.name}${n > 1 ? ` with the ${plural(n - 1, 'chip')} inside it` : ''}`);
}

function exportAll(ed: Editor): void {
  const project = projectNameOf(ed.project);
  saveFile(workspaceFileName(new Date(), project), exportJson(ed.ws, Object.keys(ed.ws.chips), project));
  ed.toast(`Exported ${plural(Object.keys(ed.ws.chips).length, 'chip')}`);
}

function pickImport(ed: Editor): void {
  const input = h('input', { type: 'file', accept: ['.json,application/json', ...importers.flatMap((i) => i.accept)].join(','), style: 'display:none' }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.remove();
    if (f) void importFile(ed, f);
  });
  ed.el.append(input);
  input.click();
}

/** Exports are small; a huge file is not one (and would freeze the tab while parsing). */
export const MAX_FILE = 32 << 20;

/** Other kinds of file the importer takes (hdlui.ts: Verilog, Yosys netlists), tried before a sandbox export. */
export interface FileImporter {
  /** Extensions for the file picker ('.v'). */
  accept: string[];
  /** Does it take this file (by name, or by its text)? */
  takes(name: string, text: string): boolean;
  run(ed: Editor, name: string, text: string): void;
}
const importers: FileImporter[] = [];
export function registerFileImporter(i: FileImporter): void {
  importers.push(i);
}
const importable = (name: string) => /\.json$/i.test(name) || importers.some((i) => i.accept.some((x) => name.toLowerCase().endsWith(x)));

async function importFile(ed: Editor, f: File): Promise<void> {
  if (f.size > MAX_FILE) return void ed.toast(`${f.name}: too large for a sandbox export (${kb(f.size)})`, 'err');
  let text: string;
  try {
    text = await f.text();
  } catch {
    return void ed.toast(`${f.name}: could not be read`, 'err');
  }
  const other = importers.find((i) => i.takes(f.name, text));
  if (other) return other.run(ed, f.name, text);
  const r = importJson(text, ed.ws);
  if ('error' in r) return void ed.toast(`${f.name}: ${r.error}`, 'err');
  if (r.added.length) ed.editWs(() => r.ws);
  const sum = summarize(r);
  if (sum.open) ed.openChip(sum.open);
  summaryDialog(ed, `Imported ${f.name}`, sum);
}

function summaryDialog(ed: Editor, title: string, sum: ImportSummary): void {
  const chipList = (xs: { id: string; name: string }[]) => h('ul', { class: 'sb-chiplist' }, xs.map((c) => h('li', null, h('b', null, c.name), ' ', h('code', null, c.id))));
  const body: HTMLElement[] = [h('p', { class: 'sb-dlg-lead' }, `${summaryLine(sum)}.${sum.added.length ? ' Ctrl+Z undoes the import.' : ''}`)];
  const fresh = sum.added.filter((a) => !sum.renamed.some((r) => r.to === a.id));
  if (fresh.length) body.push(h('h4', null, `Added (${fresh.length})`), chipList(fresh));
  if (sum.renamed.length) {
    body.push(h('h4', null, `Renamed (${sum.renamed.length})`),
      h('p', { class: 'sb-sum' }, 'A different chip of yours already has this id: the imported one came in under a new id, and the imported chips that place it were updated. Your chips are unchanged.'),
      h('ul', { class: 'sb-chiplist' }, sum.renamed.map((r) => h('li', null, h('b', null, r.name), ' ', h('code', null, r.from), ' → ', h('code', null, r.to)))));
  }
  if (sum.skipped.length) body.push(h('h4', null, `Already here (${sum.skipped.length})`), h('p', { class: 'sb-sum' }, 'Identical to one of your chips, so not added twice.'), chipList(sum.skipped));
  dialog(ed, title, body);
}

// ---------------------------------------------------------------------------------------------
// Share links

async function shareDialog(ed: Editor): Promise<void> {
  const chips = closure(ed.ws, [ed.chipId]);
  const name = ed.doc.name;
  let url: string;
  try {
    url = shareUrl(location.href, await encodeShare(chips));
  } catch (e) {
    return void ed.toast(`Could not build the link: ${(e as Error).message}`, 'err');
  }
  const field = h('input', { type: 'text', class: 'sb-share-url', readonly: true, value: url, spellcheck: 'false', 'aria-label': 'Share link', onfocus: () => field.select() }) as HTMLInputElement;
  const note = h('p', { class: 'sb-share-note', role: 'status' });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      note.textContent = 'Copied to the clipboard.';
      note.className = 'sb-share-note ok';
    } catch {
      field.focus();
      field.select();
      // The clipboard API needs a secure context and permission; the old command often works anyway.
      const ok = (() => { try { return document.execCommand('copy'); } catch { return false; } })();
      note.textContent = ok ? 'Copied to the clipboard.' : 'Select the link above and press Ctrl+C (⌘C) to copy it.';
      note.className = `sb-share-note${ok ? ' ok' : ''}`;
    }
  };
  const long = url.length > SHARE_WARN;
  const body = [
    h('p', { class: 'sb-dlg-lead' }, 'Whoever opens this link gets a copy of ', h('b', null, name),
      chips.length > 1 ? ` and the ${plural(chips.length - 1, 'chip')} inside it` : '', '. The circuit travels inside the link: nothing is uploaded, and they choose whether to import it.'),
    h('div', { class: 'sb-share-row' }, field, h('button', { class: 'btn sm', onclick: () => void copy() }, glyph('link', 14), 'Copy')),
    h('p', { class: 'sb-sum' }, `${plural(chips.length, 'chip')} · ${url.length.toLocaleString('en')} characters (${kb(url.length)})`),
    long ? h('p', { class: 'sb-warn' }, `Long links may break in some apps (mail, chat, URL shorteners) — export a file instead.`) : null,
    note,
  ];
  const foot = [
    long ? h('button', { class: 'btn sm', onclick: () => exportChip(ed) }, glyph('download', 14), 'Export file') : null,
    h('button', { class: 'btn primary sm', onclick: () => d.close() }, 'Done'),
  ].filter((x): x is HTMLButtonElement => !!x);
  const d = dialog(ed, 'Share link', body, foot, 'sb-share');
  field.focus();
  field.select();
  void copy();
}

// ---------------------------------------------------------------------------------------------
// Verilog and images

function exportVerilog(ed: Editor): void {
  const c = ed.compiled;
  if (!c || !ed.doc.parts.length) return void ed.toast('Nothing to export: the chip is empty', 'err');
  if (c.diags.some((d) => d.level === 'error')) return void ed.toast('Fix the errors in this chip first (see the properties panel)', 'err');
  try {
    const f = exportHdl(c.def, 'structure');
    saveFile(`${fileBase(ed.doc.name)}.sv`, f.text, 'text/plain');
    ed.toast(`Exported ${plural(f.modules, 'module')} (top: ${f.top})`);
  } catch (e) {
    ed.toast(`Cannot export Verilog: ${(e as Error).message}`, 'err');
  }
}

async function exportImage(ed: Editor, kind: 'svg' | 'png'): Promise<void> {
  const box = ed.view.contentBox(ed.defOf);
  if (!box) return void ed.toast('Nothing to export: the chip is empty', 'err');
  const center = ed.view.svg.closest('.sb-center') ?? document.body;
  // The selection is editing state, not part of the picture.
  ed.view.setSelection({});
  let text: string;
  try {
    text = svgImage(ed.view.svg, box, getComputedStyle(center).backgroundColor);
  } finally {
    ed.view.setSelection(ed.sel);
  }
  const base = fileBase(ed.doc.name);
  if (kind === 'svg') return saveFile(`${base}.svg`, text, 'image/svg+xml');
  try {
    saveFile(`${base}.png`, await pngImage(text));
  } catch (e) {
    ed.toast(`Cannot make a PNG: ${(e as Error).message}`, 'err');
  }
}

// ---------------------------------------------------------------------------------------------
// The chip manager

function manageDialog(ed: Editor): void {
  const msg = h('p', { class: 'sb-dlg-msg', role: 'status' });
  const table = h('table', { class: 'sb-chips' });
  const say = (text: string, err = false) => {
    msg.textContent = text;
    msg.className = `sb-dlg-msg${err ? ' err' : text ? ' ok' : ''}`;
  };
  /** A folder whose name is being typed (a new one, or Rename). */
  let editing: string | null = null;
  /** The chip being dragged by its handle. */
  let dragged: string | null = null;
  const NEW = '\u0000new';

  const dropTarget = (row: HTMLElement, folder: string | null) => {
    row.addEventListener('dragover', (e) => {
      if (!dragged) return;
      e.preventDefault();
      row.classList.add('sb-drop');
    });
    row.addEventListener('dragleave', () => row.classList.remove('sb-drop'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('sb-drop');
      if (dragged) ed.fileChip(dragged, folder);
      dragged = null;
    });
  };

  const folderRow = (name: string, n: number) => {
    const cells: (HTMLElement | string)[] = [];
    if (editing === name) {
      const input = h('input', { type: 'text', class: 'sb-name-field sm', value: name, maxlength: '40', 'aria-label': 'Folder name' }) as HTMLInputElement;
      let done = false;
      const finish = (keep: boolean) => {
        if (done) return;
        done = true;
        editing = null;
        const why = keep && input.value.trim() !== name ? ed.renameFolder(name, input.value) : null;
        if (why) say(`Not renamed: ${why}.`, true);
        render();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      queueMicrotask(() => { input.focus(); input.select(); });
      cells.push(input);
    } else cells.push(h('span', null, name));
    const row = h('tr', { class: 'sb-folder-row', 'data-folder': name },
      h('td', { colspan: '4' }, icon('folder', 14), ...cells, h('small', null, ` ${n} ${n === 1 ? 'chip' : 'chips'}`)),
      h('td', { class: 'acts' },
        h('button', { class: 'btn ghost sm', onclick: () => { editing = name; render(); } }, 'Rename'),
        h('button', { class: 'btn ghost sm', title: 'The folder goes; its chips stay, in no folder (Ctrl+Z brings it back)', onclick: () => {
          ed.editWs((ws) => removeFolder(ws, name));
          say(`Deleted the folder ${name}${n ? `: its ${n === 1 ? 'chip is' : `${n} chips are`} in no folder now` : ''}.`);
        } }, 'Delete folder')));
    dropTarget(row, name);
    return row;
  };

  const render = () => {
    const ws = ed.ws;
    const name = (id: string) => ws.chips[id]?.name ?? id;
    const folders = ws.folders ?? [];
    const chipRow = (c: ChipDoc, folder: string | null) => {
      const info = chipInfo(ws, c.id);
      const del = h('button', { class: 'btn ghost sm', title: info.usedBy.length ? `Used by ${info.usedBy.map(name).join(', ')}` : 'Delete (Ctrl+Z brings it back)', onclick: () => {
        const r = deleteChip(ed.ws, c.id);
        if ('error' in r) return say(`Cannot delete ${c.name}: it is ${r.error}. Remove it from ${r.usedBy.length > 1 ? 'those chips' : 'that chip'} first.`, true);
        ed.editWs(() => r.ws);
        say(`Deleted ${c.name} (Ctrl+Z brings it back).`);
      } }, 'Delete');
      if (info.usedBy.length) del.classList.add('sb-blocked');
      const sel = h('select', { 'aria-label': `Folder of ${c.name}` },
        h('option', { value: '' }, '— none —'), folders.map((f) => h('option', { value: f.name }, f.name)), h('option', { value: NEW }, 'New folder…')) as HTMLSelectElement;
      sel.value = folder ?? '';
      sel.addEventListener('change', () => {
        if (sel.value !== NEW) return ed.fileChip(c.id, sel.value || null);
        editing = newFolderName(ed.ws);
        ed.fileChip(c.id, editing);
      });
      const grip = h('span', { class: 'sb-grip', draggable: 'true', title: 'Drag onto a folder', 'aria-hidden': 'true' }, '⠿');
      grip.addEventListener('dragstart', (e) => {
        dragged = c.id;
        e.dataTransfer?.setData('text/plain', c.name);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      grip.addEventListener('dragend', () => { dragged = null; });
      return h('tr', { class: `${c.id === ed.chipId ? 'on' : ''}${folders.length ? ' sb-in-folder' : ''}`, 'data-chip': c.id },
        h('td', null, h('b', null, folders.length ? grip : null, c.name), h('code', null, c.id)),
        h('td', { class: 'num' }, `${info.parts}`, h('small', null, info.parts === 1 ? ' part' : ' parts'), h('br'), `${info.wires}`, h('small', null, info.wires === 1 ? ' wire' : ' wires')),
        h('td', { class: 'sb-users' }, info.usedBy.length ? info.usedBy.map(name).join(', ') : h('span', { class: 'sb-none' }, '—')),
        h('td', null, sel),
        h('td', { class: 'acts' },
          h('button', { class: 'btn ghost sm', disabled: c.id === ed.chipId, onclick: () => { ed.openChip(c.id); d.close(); } }, 'Open'),
          h('button', { class: 'btn ghost sm', title: 'A copy under a new id and name, in the same folder', onclick: () => {
            const r = duplicateChip(ed.ws, c.id);
            if (!r) return;
            ed.editWs(() => r.ws);
            say(`Added ${r.ws.chips[r.id].name}.`);
          } }, 'Duplicate'),
          del));
    };
    const rows: HTMLElement[] = [];
    for (const g of folderGroups(ws)) {
      if (g.name !== null) rows.push(folderRow(g.name, g.chips.length));
      else if (folders.length) {
        const row = h('tr', { class: 'sb-folder-row sb-unfiled' }, h('td', { colspan: '5' }, h('span', null, 'Not in a folder'), h('small', null, ` ${g.chips.length} ${g.chips.length === 1 ? 'chip' : 'chips'}`)));
        dropTarget(row, null);
        rows.push(row);
      }
      for (const c of g.chips) rows.push(chipRow(c, g.name));
    }
    table.replaceChildren(h('thead', null, h('tr', null, h('th', null, 'Chip'), h('th', null, 'Size'), h('th', null, 'Used by'), h('th', null, 'Folder'), h('th'))), h('tbody', null, rows));
  };
  render();
  const lead = h('p', { class: 'sb-dlg-lead sb-manage-lead' }, 'Project ', h('b', null, projectNameOf(ed.project)),
    ' · drag a chip onto a folder, or pick one in its row: folders only help you find chips, they change no ids or links.');
  const d = dialog(ed, `Your chips (${Object.keys(ed.ws.chips).length})`, [lead, h('div', { class: 'sb-chips-wrap' }, table), msg], [
    h('button', { class: 'btn ghost sm', onclick: () => {
      const r = addFolder(ed.ws, newFolderName(ed.ws));
      if ('error' in r) return say(`Cannot add a folder: ${r.error}.`, true);
      editing = r.name;
      ed.editWs(() => r.ws);
    } }, icon('folderPlus', 14), 'New folder'),
    h('button', { class: 'btn ghost sm', onclick: () => exportAll(ed) }, glyph('download', 14), 'Export all'),
    h('button', { class: 'btn primary sm', onclick: () => d.close() }, 'Done'),
  ], 'sb-manage');
  const head = d.el.querySelector('h3')!;
  const off = ed.onChange(() => {
    if (!d.el.isConnected) return void off();
    head.textContent = `Your chips (${Object.keys(ed.ws.chips).length})`;
    render();
  });
}

// ---------------------------------------------------------------------------------------------
// Delete local data

/** Erase the sandbox's storage (or everything the site stored), then reload into a fresh start. */
function deleteDataDialog(ed: Editor): void {
  const bytes = (sc: DataScope) => localData(sc).reduce((n, d) => n + d.bytes, 0);
  let scope: DataScope = 'sandbox';
  const opt = (sc: DataScope, title: string, hint: string) => {
    const r = h('input', { type: 'radio', name: 'sb-del-scope', value: sc, checked: sc === scope }) as HTMLInputElement;
    r.addEventListener('change', () => { if (r.checked) scope = sc; });
    return h('label', { class: 'sb-del-opt' }, r, h('span', null, h('b', null, title), h('small', null, `${hint} · ${kb(bytes(sc))}`)));
  };
  const n = Object.keys(ed.ws.chips).length;
  const projects = readProjects().list.length;
  const d = dialog(ed, 'Delete local data', [
    h('p', { class: 'sb-dlg-lead' }, 'Everything you make here lives only in this browser: nothing is kept on a server. ',
      h('b', null, 'Deleting cannot be undone'), ' (Ctrl+Z will not bring it back): export your chips first to keep a copy.'),
    h('div', { class: 'sb-del-opts', role: 'radiogroup', 'aria-label': 'What to delete' },
      opt('sandbox', 'Sandbox', projects > 1 ? `all ${projects} projects (${plural(n, 'chip')} in this one), palette favorites and the sandbox's preferences` : `your ${plural(n, 'chip')}, palette favorites and the sandbox's preferences`),
      opt('all', 'Everything', 'the sandbox, chapter and campaign progress, and every setting (theme, wire colours, speeds)')),
  ], [
    h('button', { class: 'btn ghost sm', onclick: () => exportAll(ed) }, glyph('download', 14), 'Export all chips'),
    h('button', { class: 'btn ghost sm', onclick: () => d.close() }, 'Cancel'),
    h('button', { class: 'btn sm sb-danger', onclick: () => {
      ed.stopSaving();
      deleteLocalData(scope);
      history.replaceState(null, '', '#/sandbox');
      location.reload();
    } }, glyph('trash', 14), 'Delete and reload'),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Per-editor parts: banners, share route, drag and drop, autosave indicator, backup notice

export interface FilesUi {
  /** Show the banner for a share link's payload (null: the link has none). */
  openShare(payload: string | null): void;
  destroy(): void;
}

export function installFiles(ed: Editor): FilesUi {
  let dead = false;
  const banners = h('div', { class: 'sb-banners' });
  ed.slots.overlay.append(banners);

  const banner = (kind: 'info' | 'warn' | 'err', id: string, text: (Node | string)[], buttons: HTMLElement[]) => {
    banners.querySelector(`[data-banner="${id}"]`)?.remove();
    const el = h('div', { class: `sb-banner ${kind}`, role: kind === 'err' ? 'alert' : 'status', 'data-banner': id },
      h('div', { class: 'sb-banner-text' }, text), h('div', { class: 'sb-banner-btns' }, buttons));
    banners.append(el);
    return el;
  };
  const btn = (label: string, run: () => void, primary = false) => h('button', { class: `btn sm${primary ? ' primary' : ' ghost'}`, onclick: run }, label);

  // ---- share links
  let shareSeq = 0;
  /** Leave the share route: the address bar shows the chip being edited. */
  const leaveShare = (id = ed.chipId) => {
    if (/^#\/?sandbox\/s\//.test(location.hash)) history.replaceState(null, '', `#/sandbox/${id}`);
  };
  const openShare = async (payload: string | null) => {
    const seq = ++shareSeq;
    banners.querySelector('[data-banner="share"]')?.remove();
    const chips = payload ? await decodeShare(payload) : { error: 'the link holds no circuit' };
    if (dead || seq !== shareSeq) return;
    if ('error' in chips) {
      const el = banner('err', 'share', [h('b', null, 'This share link could not be opened: '), `${chips.error}. Ask for the link again, or for an exported file.`],
        [btn('Dismiss', () => { el.remove(); leaveShare(); })]);
      return;
    }
    const top = chips[chips.length - 1];
    const others = chips.slice(0, -1).map((c) => c.name);
    const shown = others.slice(0, 5).join(', ') + (others.length > 5 ? ` and ${others.length - 5} more` : '');
    const el = banner('info', 'share', [
      `This link contains ${plural(chips.length, 'chip')}: `, h('b', null, top.name), others.length ? ` (with ${shown})` : '', '. ',
      h('span', { class: 'sb-muted' }, 'Importing adds copies to your sandbox; your chips are never overwritten.'),
    ], [
      btn('Import', () => {
        el.remove();
        const r = importChips(chips, ed.ws);
        if (r.added.length) ed.editWs(() => r.ws);
        const sum = summarize(r);
        leaveShare(sum.open ?? ed.chipId);
        if (sum.open) ed.openChip(sum.open);
        ed.toast(`${summaryLine(sum)}${sum.renamed.length ? `: ${sum.renamed.map((x) => `${x.from} → ${x.to}`).join(', ')}` : ''}`);
      }, true),
      btn('Dismiss', () => { el.remove(); leaveShare(); }),
    ]);
  };

  // ---- drag and drop
  const canvas = ed.slots.overlay.parentElement ?? ed.el;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let depth = 0;
  const over = (on: boolean) => canvas.classList.toggle('sb-drop', on);
  const onEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    over(true);
  };
  const onOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  };
  const onLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) { depth = 0; over(false); }
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    over(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    // A deck of cards goes into the selected ROM or card reader, else onto a new reader where it fell.
    const deck = files.find((x) => isDeckFile(x.name));
    if (deck) return void dropDeckFile(ed, deck, ed.view.cam.toWorld(e.clientX, e.clientY));
    const f = files.find((x) => importable(x.name) || x.type === 'application/json');
    if (!f) return void ed.toast('Drop a .json file exported from the sandbox, Verilog (.v, .sv), a Yosys netlist or a deck of cards (.deck.json)', 'err');
    if (files.length > 1) ed.toast(`One file at a time: importing ${f.name}`);
    void importFile(ed, f);
  };
  // The whole editor accepts the drop (a file dropped on the palette must not navigate away).
  ed.el.addEventListener('dragenter', onEnter);
  ed.el.addEventListener('dragover', onOver);
  ed.el.addEventListener('dragleave', onLeave);
  ed.el.addEventListener('drop', onDrop);

  // ---- autosave indicator
  const dot = h('span', { class: 'sb-save-dot' });
  const label = h('span', { class: 'sb-save-label' });
  const ind = h('button', { class: 'sb-save', 'aria-live': 'polite', onclick: () => {
    const st = ed.saveState;
    if (st.state !== 'error') return ed.toast('Your chips are saved in this browser as you work. Export them to keep a copy elsewhere.');
    storageFull(true);
  } }, dot, label);
  ed.slots.top.append(ind);
  let lastState = '';
  const storageFull = (force = false) => {
    if (!force && banners.querySelector('[data-banner="save"]')) return;
    const el = banner('warn', 'save', [h('b', null, 'Not saved: '), `${ed.saveState.reason ?? 'browser storage failed'}. Until then your work lives only in this tab.`],
      [btn('Export all chips', () => exportAll(ed), true), btn('Dismiss', () => el.remove())]);
  };
  const showSave = () => {
    const st = ed.saveState;
    if (st.state === lastState) return;
    if (st.state === 'error' && lastState !== 'error') storageFull();
    if (st.state === 'saved') banners.querySelector('[data-banner="save"]')?.remove();
    lastState = st.state;
    ind.dataset.state = st.state;
    label.textContent = st.state === 'saved' ? 'Saved' : st.state === 'saving' ? 'Saving…' : /full/.test(st.reason ?? '') ? 'Storage full' : 'Not saved';
    ind.title = st.state === 'error' ? `${st.reason} (click for options)` : st.state === 'saved' ? 'Saved in this browser' : 'Saving in this browser';
  };
  const offSave = ed.onSave(showSave);
  showSave();

  // ---- a backup of unreadable data (store.ts keeps it rather than losing it)
  let backup: string | null = null;
  try {
    backup = localStorage.getItem(BACKUP_KEY);
  } catch {
    // no storage: nothing to recover
  }
  if (backup) {
    const text = backup;
    const el = banner('warn', 'backup', [h('b', null, 'Backup found: '), 'saved sandbox data could not be read (damaged, or saved by a newer version of the site), so the sandbox started fresh. The old data is kept.'], [
      btn('Download it', () => saveFile('sandbox-backup.json', text), true),
      btn('Delete it', () => {
        if (!confirm('Delete the unreadable sandbox data for good? Download it first if you might need it.')) return;
        try { localStorage.removeItem(BACKUP_KEY); } catch { /* nothing to do */ }
        el.remove();
      }),
      btn('Later', () => el.remove()),
    ]);
  }

  return {
    openShare: (p) => void openShare(p),
    destroy: () => {
      dead = true;
      offSave();
      closeMenu();
      ed.el.removeEventListener('dragenter', onEnter);
      ed.el.removeEventListener('dragover', onOver);
      ed.el.removeEventListener('dragleave', onLeave);
      ed.el.removeEventListener('drop', onDrop);
    },
  };
}
