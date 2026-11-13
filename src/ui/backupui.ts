// The backup file's buttons and dialogs (settings menu, home page, the Safari note). The rules are in backup.ts.

import { saveFile } from '../view/image';
import { applyMerge, backupName, describe, makeBackup, mergeBackup, readBackup, summarize, type MergeResult, type Summary } from './backup';
import { h } from './dom';
import { keepProgress } from './persist';

const storage = (): Storage | null => {
  try { return localStorage; } catch { return null; }
};

/** A modal over the page (native <dialog>: focus trapped, Esc closes and gives the focus back). */
function modal(title: string, body: (Node | string)[], foot: HTMLElement[]): HTMLDialogElement {
  const opener = document.activeElement as HTMLElement | null;
  const d = h('dialog', { class: 'bk-dlg', 'aria-label': title }, h('h3', null, title), ...body, h('div', { class: 'bk-foot' }, ...foot)) as HTMLDialogElement;
  d.addEventListener('close', () => { d.remove(); opener?.focus?.(); });
  document.body.append(d);
  d.showModal();
  return d;
}

/** A short line at the bottom of the page that a screen reader announces (the download itself shows nothing). */
function note(msg: string): void {
  const el = h('div', { class: 'bk-note', role: 'status' }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}

const list = (lines: string[]) => h('ul', { class: 'bk-list' }, lines.map((l) => h('li', null, l)));

/** Download everything the site keeps in this browser as one file. */
export function exportBackup(): void {
  const kv = storage();
  if (!kv) { modal('Export all progress', ['The browser does not allow this site to store data, so there is nothing to export.'], [okBtn()]); return; }
  const text = makeBackup(kv, __APP_VERSION__);
  saveFile(backupName(), text);
  void keepProgress();
  note(`Backup saved as ${backupName()}`);
}

const okBtn = (label = 'OK', fn?: () => void) => h('button', { class: 'btn sm primary', onclick: (e: Event) => { (e.target as HTMLElement).closest('dialog')?.close(); fn?.(); } }, label);
const cancelBtn = () => h('button', { class: 'btn sm ghost', onclick: (e: Event) => (e.target as HTMLElement).closest('dialog')?.close() }, 'Cancel');

/** Pick a backup file, show what it holds and what would change, then merge it in (and reload). */
export function importBackup(): void {
  const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true }) as HTMLInputElement;
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    input.remove();
    if (f) review(await f.text(), f.name);
  });
  document.body.append(input);
  input.click();
}

const delta = (a: Summary, b: Summary): string[] => {
  const out: string[] = [];
  const add = (n: number, what: string) => { if (n > 0) out.push(`+${n} ${what}`); };
  add(b.steps - a.steps, 'chapter steps seen');
  add(b.checks - a.checks, 'checks solved');
  add(b.campaignSolved - a.campaignSolved, 'campaign levels solved');
  add(b.puzzles - a.puzzles, 'puzzles solved');
  add(b.projects - a.projects, 'sandbox projects');
  add(b.chips - a.chips, 'chips');
  add(b.notes - a.notes, 'notes');
  add(b.bookmarks - a.bookmarks, 'bookmarks');
  add(b.reviewed - a.reviewed, 'review questions');
  add(b.testedOut - a.testedOut, 'chapters tested out');
  add(b.other - a.other, 'small preferences');
  return out;
};

function review(text: string, name: string): void {
  const kv = storage();
  if (!kv) { modal('Import progress', ['The browser does not allow this site to store data.'], [okBtn()]); return; }
  const r = readBackup(text);
  if ('error' in r) { modal('Import progress', [h('p', null, r.error)], [okBtn()]); return; }
  const theirs = new Map(Object.entries(r.file.keys));
  // what the file holds, counted by the same code as ours
  const fileKv = { get length() { return theirs.size; }, key: (i: number) => [...theirs.keys()][i] ?? null, getItem: (k: string) => theirs.get(k) ?? null, setItem: () => {}, removeItem: () => {} };
  const held = summarize(fileKv);
  const preview = mergeBackup(r.file, kv);
  const changes = delta(preview.before, preview.after);
  const notes = [...preview.notes, ...(r.dropped.length ? [`${r.dropped.length} entr${r.dropped.length === 1 ? 'y' : 'ies'} in the file are not this site’s data and were ignored.`] : [])];
  const when = r.file.created ? ` · saved ${r.file.created.slice(0, 10)}${r.file.site ? ` by version ${r.file.site}` : ''}` : '';
  modal('Import progress', [
    h('p', { class: 'bk-sub' }, `${name}${when}`),
    h('h4', null, 'The file holds'), list(describe(held)),
    h('h4', null, 'Merging it adds'), changes.length ? list(changes) : h('p', null, 'Nothing: everything in the file is already here.'),
    h('p', { class: 'bk-sub' }, 'Nothing you have is replaced or removed: progress joins, the better result is kept, chips that clash arrive under a new name.'),
    ...(notes.length ? [h('h4', null, 'Left out'), list(notes)] : []),
  ], [cancelBtn(), okBtn('Merge and reload', () => void apply(text))]);
}

/** Leave the editor (its closing saves what it holds), merge from what storage then holds, write, reload. */
async function apply(text: string): Promise<void> {
  const kv = storage();
  const r = readBackup(text);
  if (!kv || 'error' in r) return;
  // A sandbox or level editor autosaves on its own and would write its copy over the merge: leave it first.
  if (/^#\/(sandbox|campaign\/play)/.test(location.hash)) {
    location.hash = '#/';
    await new Promise((res) => setTimeout(res, 150));
  }
  const merged: MergeResult = mergeBackup(r.file, kv);
  const w = applyMerge(merged, kv);
  if (!w.ok) { modal('Import progress', [h('p', null, w.reason)], [okBtn()]); return; }
  // Settings, the campaign and the editors hold their data in memory: a reload is what makes them read the merge.
  location.reload();
}

/**
 * Reset progress: says what goes (chapter steps seen and checks solved, campaign and puzzle progress, in counts) and what stays
 * (sandbox chips, notes, preferences), and offers the backup first. The native confirm named nothing.
 */
export function resetProgressDialog(reset: () => void): void {
  const kv = storage();
  const s = kv ? summarize(kv) : null;
  const goes = s ? [`${s.steps} chapter step${s.steps === 1 ? '' : 's'} seen`, `${s.checks} check${s.checks === 1 ? '' : 's'} solved`,
    `${s.campaignSolved} campaign level${s.campaignSolved === 1 ? '' : 's'} solved, with stars and tips`, `${s.puzzles} puzzle${s.puzzles === 1 ? '' : 's'} solved`] : ['chapter steps seen, checks solved, campaign and puzzle progress'];
  modal('Reset your progress?', [
    h('h4', null, 'This clears'), list(goes),
    h('h4', null, 'This keeps'), list(['Sandbox projects and chips', 'Notes and bookmarks', 'Settings and look']),
    h('p', { class: 'bk-sub' }, 'It cannot be undone. Export first to keep a copy you can merge back in later.'),
  ], [cancelBtn(), h('button', { class: 'btn sm ghost', onclick: () => exportBackup() }, 'Export all progress first'),
    h('button', { class: 'btn sm primary', onclick: (e: Event) => { (e.target as HTMLElement).closest('dialog')?.close(); reset(); } }, 'Reset progress')]);
}
