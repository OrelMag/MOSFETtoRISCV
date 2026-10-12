// Uncaught errors: a quiet banner (what went wrong, Report this problem, Reload) instead of a silently frozen
// panel. Reporting opens a prefilled GitHub issue in a new tab; nothing is sent unless the learner submits it.

import { h, icon } from './dom';
import { errorParts, isNoise, REPO_URL, issueUrl, oneLine, safeRoute, siteVersion, trimStack, type ReportInfo } from './report';
import { settings } from './settings';

function themeName(): string {
  let t: string = settings.theme;
  try {
    if (t === 'auto') t = `${matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'} (auto)`;
  } catch { /* no matchMedia: keep 'auto' */ }
  const look = [settings.vivid && 'vivid', settings.vivid && settings.cartoon && 'cartoon', settings.palette !== 'default' && `palette ${settings.palette}`].filter(Boolean);
  return look.length ? `${t}, ${look.join(', ')}` : t;
}

/** The environment part of a report, as it is now. */
function env(): Omit<ReportInfo, 'message' | 'stack'> {
  return { route: safeRoute(location.hash), version: siteVersion(), userAgent: navigator.userAgent, theme: themeName(), time: new Date().toISOString() };
}

/** The issue URL for an error (or none: a plain report), with the route and time of now. */
export function reportUrl(err?: unknown): string {
  if (err === undefined) return issueUrl(env());
  const p = errorParts(err);
  return issueUrl({ ...env(), message: p.message, stack: p.stack && trimStack(p.stack, location.origin) });
}

const ISSUES = `${REPO_URL}/issues/new`;
const LINK_TITLE = 'Opens a prefilled GitHub issue in a new tab: nothing is sent until you submit it';

/** A link to a report whose URL is made when it is used, so the route and time are current. */
function liveLink(cls: string | undefined, label: string, make: () => string): HTMLAnchorElement {
  const a = h('a', { target: '_blank', rel: 'noopener noreferrer', class: cls, title: LINK_TITLE }, label);
  const refresh = () => {
    try {
      a.href = make();
    } catch {
      a.href = ISSUES;
    }
  };
  for (const ev of ['pointerdown', 'focus', 'click']) a.addEventListener(ev, refresh);
  refresh();
  return a;
}

/** A "Report this problem" link (no error: a plain report with the version and route). */
export function reportLink(err?: unknown, label = 'Report this problem', cls?: string): HTMLAnchorElement {
  return liveLink(cls, label, () => reportUrl(err));
}

/** The panel a page shows when its chunk could not load (the route loaders in app.ts). */
export function loadFailed(what: string, e: unknown): HTMLElement {
  return h('div', { class: 'widget' }, h('div', { class: 'panel' },
    h('h3', null, `The ${what} could not load`), h('p', { class: 'sub' }, String(e)),
    h('div', { class: 'err-actions' }, h('button', { class: 'btn sm', onclick: () => location.reload() }, icon('reset', 14), 'Reload'), reportLink(e, 'Report this problem', 'btn sm ghost'))));
}

let installed = false;

/** Install once, at startup: window `error` and `unhandledrejection` show the banner. */
export function installErrorReporting(): void {
  if (installed) return;
  installed = true;
  const seen = new Map<string, number>();
  const dismissed = new Set<string>();
  let total = 0;
  let banner: { el: HTMLElement; count: HTMLElement } | null = null;
  let busy = false;

  const show = (err: unknown, filename?: string) => {
    if (busy) return;
    busy = true;
    try {
      const p = errorParts(err);
      if (isNoise({ ...p, filename }, location.origin)) return;
      // One key per error site: the message and the top frame.
      const key = `${p.message}\n${(p.stack ?? '').split('\n').find((l) => /:\d+:\d+/.test(l)) ?? ''}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      total++;
      if (banner) {
        // One banner: later errors only raise its count.
        banner.count.textContent = `(${total} errors)`;
        banner.count.hidden = false;
        return;
      }
      if (dismissed.has(key)) return;
      open(err, p.message);
    } catch {
      // Reporting must never add an error of its own.
    } finally {
      busy = false;
    }
  };

  const open = (err: unknown, message: string) => {
    total = 1;
    const count = h('span', { class: 'err-count', hidden: true });
    // Where and when it happened, not where the learner went before clicking Report.
    const { route, time } = env();
    const link = liveLink('btn sm primary', 'Report this problem', () => {
      const p = errorParts(err);
      return issueUrl({ ...env(), route, time, message: p.message, stack: p.stack && trimStack(p.stack, location.origin), count: total, distinct: seen.size });
    });
    const close = () => {
      for (const k of seen.keys()) dismissed.add(k);
      banner?.el.remove();
      banner = null;
    };
    const el = h('div', { class: 'err-banner', role: 'alert' },
      h('span', { class: 'err-icon', 'aria-hidden': 'true' }, '!'),
      h('div', { class: 'err-text' },
        h('b', null, 'Something went wrong'), ' ', count,
        h('span', { class: 'err-msg', title: message }, oneLine(message, 160) || 'Unknown error'),
        h('span', { class: 'err-note' }, 'This part of the page may have stopped working.')),
      h('div', { class: 'err-btns' }, h('button', { class: 'btn sm', onclick: () => location.reload() }, 'Reload'), link),
      h('button', { class: 'btn sm ghost icon-only err-close', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: close }, icon('close', 14)));
    banner = { el, count };
    document.body.append(el);
  };

  window.addEventListener('error', (e) => {
    // A failed <img> / <script> load reaches capture listeners only; this one listens in bubble phase.
    show(e.error ?? e.message, e.filename);
  });
  window.addEventListener('unhandledrejection', (e) => show(e.reason));
}
