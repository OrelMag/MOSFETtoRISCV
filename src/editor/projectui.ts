// The project switcher at the top of the sandbox's palette (projects.ts keeps the index): the
// current project's name, and a menu listing every project with New, Duplicate, Rename, Export,
// Import a file as a new project and Delete. Switching saves the current project and rebuilds the
// editor on the other one (the page does that: ProjectHooks.switchTo).

import { h, icon, placeMenu } from '../ui/dom';
import type { Editor } from './editor';
import { fileBase, workspaceFileName } from './files';
import { dialog, glyph, MAX_FILE } from './fileui';
import {
  MAIN_PROJECT, createProject, deleteProject, duplicateProject, projectNameOf, readProjects, renameProject, uniqueProjectName, type ProjectMeta,
} from './projects';
import { exportJson, MAX_PROJECT_NAME, readExport, workspaceFromExport } from './store';
import { saveFile } from '../view/image';

export interface ProjectHooks {
  /** Save this project and open another (after a delete, the first one). */
  switchTo(id: string, note?: string): void;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else the date. */
export function ago(t: number | undefined, now = Date.now()): string {
  if (t === undefined) return 'not saved yet';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  if (s < 14 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(t).toLocaleDateString();
}

/** The project's name now (the index may have been renamed by this or another tab). */
const projectName = (ed: Editor) => projectNameOf(ed.project);

export function installProjects(ed: Editor, hooks: ProjectHooks): { destroy(): void } {
  let menu: HTMLElement | null = null;
  const btn = h('button', { class: 'sb-proj', 'aria-haspopup': 'menu', title: 'Projects: separate sets of chips' }) as HTMLButtonElement;
  const label = () => {
    const n = Object.keys(ed.ws.chips).length;
    // "Project:" keeps it apart from the palette's My chips group
    btn.replaceChildren(icon('project', 14), h('span', { class: 'sb-proj-name' }, h('small', null, 'Project:'), h('b', null, projectName(ed))), icon('chevD', 12));
    btn.title = `Project ${projectName(ed)}, ${plural(n, 'chip')}: switch, copy or export projects (separate sets of chips)`;
  };
  label();
  ed.palette.top.append(btn);
  const off = ed.onChange(label);

  const close = () => {
    menu?.remove();
    menu = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
  };
  const outside = (e: PointerEvent) => { if (menu && !menu.contains(e.target as Node) && !btn.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); btn.focus(); } };

  const item = (ic: string, title: string, hint: string, run: () => void, opts: { cur?: boolean; disabled?: string } = {}) => {
    const b = h('button', { role: opts.cur ? 'menuitemradio' : 'menuitem', class: opts.cur ? 'cur' : '', 'aria-checked': opts.cur ? 'true' : null, disabled: !!opts.disabled, title: opts.disabled ?? null,
      onclick: () => { close(); run(); } }, glyph(ic), h('span', null, h('b', null, title), h('small', null, hint)), opts.cur ? h('span', { class: 'sb-proj-check' }, icon('check', 14)) : null);
    return b;
  };

  const open = () => {
    if (menu) return close();
    ed.save(); // the index's counts and times include this project's last edit
    const idx = readProjects();
    const cur = idx.list.find((p) => p.id === ed.project);
    const name = cur?.name ?? 'My chips';
    const info = (p: ProjectMeta) => {
      const n = p.id === ed.project ? Object.keys(ed.ws.chips).length : p.chips;
      return [n === undefined ? null : plural(n, 'chip'), ago(p.modified), p.id === MAIN_PROJECT ? 'campaign levels' : null].filter(Boolean).join(' · ');
    };
    menu = h('div', { class: 'sb-menu sb-proj-menu', role: 'menu', 'aria-label': 'Projects' },
      h('div', { class: 'sb-menu-head' }, 'Projects'),
      idx.list.map((p) => item('project', p.name, info(p), () => { if (p.id !== ed.project) hooks.switchTo(p.id); }, { cur: p.id === ed.project })),
      h('hr'),
      item('plus', 'New project', 'An empty workspace with one Main chip', () => newDialog(ed, hooks)),
      item('copy', `Duplicate “${name}”`, 'A copy to try something risky in', () => {
        ed.save();
        const r = duplicateProject(ed.project);
        if (!r.ok) return ed.toast(`Cannot duplicate: ${r.reason}`, 'err');
        hooks.switchTo(r.id, `Now in ${r.name}, a copy of ${name}`);
      }),
      item('pen', 'Rename…', 'Only the name; chips and links are unchanged', () => renameDialog(ed, label)),
      item('download', 'Export this project', 'Every chip, its folders and favorites, one .json file', () => exportProject(ed)),
      item('upload', 'Import a file as a new project', 'Instead of merging it into this one', () => pickProjectFile(ed, hooks)),
      item('trash', 'Delete this project…', 'Asks first; export it to keep a copy', () => deleteDialog(ed, hooks),
        { disabled: ed.project === MAIN_PROJECT ? 'The first project holds your campaign levels: it can be renamed, not deleted' : undefined }));
    ed.el.append(menu);
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    placeMenu(menu, r, Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)));
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    menu.querySelector<HTMLElement>('button.cur, button')?.focus();
  };
  btn.addEventListener('click', open);

  return { destroy: () => { close(); off(); btn.remove(); } };
}

/** A dialog asking for a name: `ok` returns why it cannot be used, or null to close. */
function nameDialog(ed: Editor, title: string, lead: string, value: string, okLabel: string, ok: (name: string) => string | null): void {
  const input = h('input', { type: 'text', class: 'sb-name-field', value, spellcheck: 'false', maxlength: String(MAX_PROJECT_NAME), 'aria-label': 'Project name' }) as HTMLInputElement;
  const msg = h('p', { class: 'sb-dlg-msg', role: 'status' });
  const go = () => {
    const why = ok(input.value);
    if (why) { msg.textContent = why; msg.className = 'sb-dlg-msg err'; return; }
    d.close();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  const d = dialog(ed, title, [h('p', { class: 'sb-dlg-lead' }, lead), input, msg], [
    h('button', { class: 'btn ghost sm', onclick: () => d.close() }, 'Cancel'),
    h('button', { class: 'btn primary sm', onclick: go }, okLabel),
  ]);
  input.focus();
  input.select();
}

function newDialog(ed: Editor, hooks: ProjectHooks): void {
  nameDialog(ed, 'New project', 'A separate set of chips, with its own folders, favorites and open tabs. Switch between projects at the top of the palette.',
    uniqueProjectName(readProjects(), 'Project'), 'Create', (name) => {
      if (!name.trim()) return 'a project needs a name';
      const r = createProject(name);
      if (!r.ok) return r.reason;
      hooks.switchTo(r.id, `Now in ${r.name}`);
      return null;
    });
}

function renameDialog(ed: Editor, done: () => void): void {
  nameDialog(ed, 'Rename project', 'Only the name changes: chip ids, share links and exported files stay the same.', projectName(ed), 'Rename', (name) => {
    const r = renameProject(ed.project, name);
    if (!r.ok) return r.reason;
    done();
    ed.toast(`Renamed to ${r.name}`);
    return null;
  });
}

function exportProject(ed: Editor): void {
  const name = projectName(ed);
  saveFile(workspaceFileName(new Date(), name), exportJson(ed.ws, Object.keys(ed.ws.chips), name));
  ed.toast(`Exported ${name}: ${plural(Object.keys(ed.ws.chips).length, 'chip')}`);
}

function pickProjectFile(ed: Editor, hooks: ProjectHooks): void {
  const input = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.remove();
    if (f) void importAsProject(ed, hooks, f);
  });
  ed.el.append(input);
  input.click();
}

async function importAsProject(ed: Editor, hooks: ProjectHooks, f: File): Promise<void> {
  if (f.size > MAX_FILE) return void ed.toast(`${f.name}: too large for a sandbox export`, 'err');
  let text: string;
  try {
    text = await f.text();
  } catch {
    return void ed.toast(`${f.name}: could not be read`, 'err');
  }
  const x = readExport(text);
  if ('error' in x) return void ed.toast(`${f.name}: ${x.error}`, 'err');
  const ws = workspaceFromExport(x);
  const r = createProject(x.project ?? fileBase(f.name.replace(/\.json$/i, ''), 'Imported').replace(/-/g, ' '), ws);
  if (!r.ok) return void ed.toast(`${f.name}: ${r.reason}`, 'err');
  hooks.switchTo(r.id, `Imported ${f.name} as ${r.name}: ${plural(Object.keys(ws.chips).length, 'chip')}`);
}

function deleteDialog(ed: Editor, hooks: ProjectHooks): void {
  const name = projectName(ed);
  const n = Object.keys(ed.ws.chips).length;
  const d = dialog(ed, `Delete ${name}?`, [
    h('p', { class: 'sb-dlg-lead' }, `Its ${plural(n, 'chip')} are erased from this browser. `, h('b', null, 'This cannot be undone'),
      ' (Ctrl+Z will not bring it back): export the project first to keep a copy. Your other projects are not touched.'),
  ], [
    h('button', { class: 'btn ghost sm', onclick: () => exportProject(ed) }, glyph('download', 14), 'Export it'),
    h('button', { class: 'btn ghost sm', onclick: () => d.close() }, 'Cancel'),
    h('button', { class: 'btn sm sb-danger', onclick: () => {
      const r = deleteProject(ed.project);
      d.close();
      if (!r.ok) return ed.toast(`Cannot delete: ${r.reason}`, 'err');
      ed.stopSaving(); // closing the editor must not write the deleted project back
      hooks.switchTo(MAIN_PROJECT, `Deleted ${name}`);
    } }, glyph('trash', 14), 'Delete project'),
  ]);
}
