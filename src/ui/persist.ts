// Ask the browser to keep this site's data (navigator.storage.persist) once there is progress worth keeping, and where it
// will not (Safari deletes a site's storage after 7 days without a visit), say so once and point at the backup file.

import { h } from './dom';

const NOTE_KEY = 'mosfet2riscv:persist-note';
let asked = false;

/** Safari and the iOS browsers (all WebKit): the ones whose storage is evicted after a week unvisited. */
export function evictsStorage(ua = navigator.userAgent): boolean {
  const ios = /iPad|iPhone|iPod/.test(ua);
  return ios || (/Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android/.test(ua));
}

const standalone = (): boolean => {
  try {
    return matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  } catch { return false; }
};

/**
 * Called when progress is first recorded (and at load when there already is some). At most once per page load. Firefox
 * shows its own permission prompt for persist(), which is why this waits for progress instead of asking on a first visit.
 */
export async function keepProgress(): Promise<void> {
  if (asked) return;
  asked = true;
  try {
    const sm = navigator.storage;
    if (!sm?.persist) return;
    if (await sm.persisted?.()) return;
    if (await sm.persist()) return;
    // An installed app is not subject to the 7-day rule; everything else on WebKit is.
    if (!evictsStorage() || standalone() || localStorage.getItem(NOTE_KEY)) return;
    showNote();
  } catch { /* storage API or localStorage blocked: nothing to do */ }
}

function showNote(): void {
  const dismiss = () => {
    try { localStorage.setItem(NOTE_KEY, '1'); } catch { /* shown again next visit */ }
    note.remove();
  };
  const note = h('div', { class: 'persist-note', role: 'status' },
    h('span', null, 'Safari deletes a site’s data after 7 days without a visit, and this site keeps your progress in the browser. Export it to a file now and then.'),
    h('button', { class: 'btn sm primary', onclick: () => { dismiss(); void import('./backupui').then((m) => m.exportBackup()); } }, 'Export progress'),
    h('button', { class: 'btn sm ghost', onclick: dismiss }, 'Dismiss'));
  document.body.append(note);
}
