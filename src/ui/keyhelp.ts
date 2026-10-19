// The key sheets (`?`): "Keys on this page" anywhere, and the sandbox's sheet (editor.ts showHelp). Both are
// drawn from the key table (keys.ts KEYS), so a key listed is a key that works; the switch for single-key
// shortcuts sits at the bottom of each.

import { h, icon } from './dom';
import { GROUP_TITLES, KEYS, type KeyDef, type KeyGroup } from './keys';
import { settings } from './settings';

export interface SheetOptions {
  title: string;
  sub?: string;
  groups: KeyGroup[];
  /** Single keys a Key part on the open chip takes (struck through). */
  taken?: ReadonlySet<string>;
  /** Mouse gestures, folded under the keys. */
  mouse?: readonly [string, string][];
  /** Class on the overlay (the sandbox marks its sheet so its own keys stay out of it). */
  cls?: string;
}

/** A binding made of single character keys (the ones the switch turns off). */
export const singleDef = (d: KeyDef): boolean => !!d.taken?.length || !!d.match?.some((m) => !m.mod);

function caps(d: KeyDef): HTMLElement {
  return h('span', { class: 'k' }, d.caps.map((c) => (c === '…' || c === '·' ? h('span', { class: 'sep' }, c) : h('kbd', null, c))));
}

let open: (() => void) | null = null;

/** Opens a key sheet (one at a time); returns its close. */
export function showKeySheet(o: SheetOptions): () => void {
  open?.();
  const back = document.activeElement as HTMLElement | null;
  const takenBy = (d: KeyDef) => !!o.taken && !!d.taken?.some((k) => o.taken!.has(k));
  const rows = (g: KeyGroup) => KEYS.filter((d) => d.group === g && d.caps.length);
  const grid = h('div', { class: 'kh-grid' }, o.groups.map((g) => h('section', { class: 'kh-grp', 'aria-label': GROUP_TITLES[g] },
    h('h4', null, GROUP_TITLES[g]),
    rows(g).map((d) => h('div', { class: `kh-row${singleDef(d) ? ' single' : ''}${takenBy(d) ? ' taken' : ''}`, title: takenBy(d) ? 'A Key part on this chip takes this key' : null },
      caps(d), h('span', { class: 'd' }, d.does))))));
  const sw = h('button', { class: 'kh-switch', role: 'switch', 'aria-checked': String(settings.singleKeys) }, h('i'), 'Single-key shortcuts');
  const note = h('span', { class: 'kh-note' });
  const sync = () => {
    sw.setAttribute('aria-checked', String(settings.singleKeys));
    note.textContent = settings.singleKeys
      ? 'Letters follow the key\'s position on other layouts (Hebrew כ = F).'
      : 'Off: only Ctrl/⌘ combinations, Esc, arrows and the like stay (WCAG 2.1.4, for voice control).';
    grid.classList.toggle('nosingle', !settings.singleKeys);
  };
  sw.addEventListener('click', () => settings.set('singleKeys', !settings.singleKeys));
  const unsub = settings.onChange(sync);
  sync();
  const takenKeys = o.taken ? [...o.taken].filter((k) => KEYS.some((d) => d.taken?.includes(k))) : [];
  const closeBtn = h('button', { class: 'btn ghost sm kh-close', 'aria-label': 'Close' }, h('kbd', null, 'Esc'), 'close');
  const box = h('div', { class: 'kh', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title },
    h('div', { class: 'kh-head' }, icon('keyboard', 18), h('h3', null, o.title), o.sub ? h('span', { class: 'kh-sub' }, o.sub) : null, closeBtn),
    grid,
    o.mouse?.length ? h('details', { class: 'kh-mouse' }, h('summary', null, 'Mouse and touch gestures'),
      h('dl', null, o.mouse.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))) : null,
    h('div', { class: 'kh-foot' },
      takenKeys.length ? h('span', { class: 'kh-taken' }, 'A Key part on this chip takes ', takenKeys.map((k) => h('kbd', null, k.toUpperCase())), ' (struck through)') : null,
      h('span', { class: 'sp' }), sw, note));
  const ov = h('div', { class: `kh-back key-help${o.cls ? ` ${o.cls}` : ''}` }, box);
  const close = () => {
    if (open !== close) return;
    open = null;
    unsub();
    ov.remove();
    if (back?.isConnected) back.focus({ preventScroll: true });
  };
  closeBtn.addEventListener('click', close);
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      // keep Tab inside the sheet
      const f = [...box.querySelectorAll<HTMLElement>('button, summary')];
      const i = f.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length]?.focus();
    }
  });
  document.body.append(ov);
  open = close;
  closeBtn.focus();
  return close;
}

/** `?` outside the sandbox: the keys that work on this page. */
export function showPageKeys(): void {
  const chapter = location.hash.startsWith('#/c/');
  const stage = !!document.querySelector('#view section.stage');
  const groups: KeyGroup[] = ['anywhere'];
  if (chapter) groups.push('chapter');
  if (stage) groups.push('stage');
  showKeySheet({ title: 'Keys on this page', groups });
}
