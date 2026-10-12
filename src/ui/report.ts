// Problem reports: a prefilled GitHub "new issue" URL (DOM-free, tested in Node). Nothing is sent: the
// learner opens the URL and submits it themselves. Never put stored data or circuits in it.

export const REPO_URL = 'https://github.com/OrelMag/MOSFETtoRISCV';
/** GitHub and browsers cut very long URLs (GitHub answers 414 past ~8 KB): stay under this. */
export const MAX_URL = 7000;
const MAX_FRAMES = 25;
const MAX_ROUTE = 160;

export interface ReportInfo {
  /** The error's one-line message (absent: a report with no error, from the footer). */
  message?: string;
  stack?: string;
  /** Errors seen in total and distinct ones, when more than one. */
  count?: number;
  distinct?: number;
  route: string;
  version: string;
  userAgent: string;
  theme: string;
  /** ISO time. */
  time: string;
}

/** The site version as the footer shows it, with the commit and build date. */
export function siteVersion(): string {
  return `${__APP_VERSION__} (${__APP_COMMIT__}, ${__APP_DATE__})`;
}

/** The route without anything the learner made: a share link carries a whole circuit in its hash. */
export function safeRoute(hash: string): string {
  let r = hash || '#/';
  r = r.replace(/^(#\/sandbox\/s\/).*$/, '$1(share link)');
  return r.length > MAX_ROUTE ? r.slice(0, MAX_ROUTE) + '…' : r;
}

/** Message and stack of anything thrown or rejected (an Error, a string, an event, undefined). */
export function errorParts(err: unknown): { message: string; stack?: string; name?: string } {
  if (err instanceof Error || (err && typeof err === 'object' && 'message' in err)) {
    const e = err as { message?: unknown; stack?: unknown; name?: unknown };
    const name = typeof e.name === 'string' ? e.name : undefined;
    const msg = String(e.message ?? '') || name || 'Unknown error';
    return { message: name && name !== 'Error' && !msg.startsWith(name) ? `${name}: ${msg}` : msg, stack: typeof e.stack === 'string' ? e.stack : undefined, name };
  }
  try {
    return { message: err === undefined ? 'Unknown error (undefined)' : String(err) };
  } catch {
    return { message: 'Unknown error' };
  }
}

/** First line, collapsed spaces, at most n characters. */
export function oneLine(message: string, n = 200): string {
  const line = (message.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
}

const EXTENSION = /\b(?:chrome|moz|safari(?:-web)?|ms-browser)-extension:\/\/|webkit-masked-url:\/\//;
const URL_IN_STACK = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi;

/**
 * Errors not worth a banner: benign browser warnings, cross-origin "Script error." with nothing to report,
 * and errors raised by browser extensions (the stack or file is theirs, not our origin's).
 */
export function isNoise(e: { message: string; stack?: string; name?: string; filename?: string }, origin: string): boolean {
  const m = e.message;
  if (/ResizeObserver loop/i.test(m)) return true;
  if (e.name === 'AbortError' || /play\(\) request was interrupted/i.test(m)) return true;
  if (/^Script error\.?$/i.test(m.trim()) && !e.stack) return true;
  if (e.filename && (EXTENSION.test(e.filename) || (/^[a-z][a-z0-9+.-]*:\/\//i.test(e.filename) && !e.filename.startsWith(origin)))) return true;
  // Frames with URLs: the top one an extension's (thrown there, even if called from ours), or none of ours.
  const urls = e.stack?.match(URL_IN_STACK) ?? [];
  const top = urls[0];
  return top !== undefined && (EXTENSION.test(top) || !urls.some((u) => u.startsWith(origin)));
}

const FRAME = /^\s*at\s|@|:\d+:\d+\)?$/;

/**
 * The stack shortened: V8's leading copy of the message dropped (the report has it), the origin dropped from
 * every frame (it is the site itself), at most `frames` lines.
 */
export function trimStack(stack: string, origin: string, frames = MAX_FRAMES): string {
  let lines = stack.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  const first = lines.findIndex((l) => FRAME.test(l));
  if (first > 0) lines = lines.slice(first);
  const cut = origin ? lines.map((l) => l.split(origin).join('')) : lines;
  return cut.length > frames ? [...cut.slice(0, frames), `… ${cut.length - frames} more frames`].join('\n') : cut.join('\n');
}

function body(info: ReportInfo, stack: string | undefined): string {
  const out = ['**What were you doing when it happened?**', '', '', ''];
  if (info.message !== undefined) {
    out.push('**Error**', '```', info.message.replace(/```/g, "'''"), '```');
    if (info.count && info.count > 1) out.push(`(${info.count} errors in this session${info.distinct && info.distinct > 1 ? `, ${info.distinct} different` : ''}; this is the first)`);
    if (stack) out.push('', '<details><summary>Stack</summary>', '', '```', stack.replace(/```/g, "'''"), '```', '</details>');
    out.push('');
  }
  out.push('**Environment**',
    `- Route: \`${info.route}\``,
    `- Version: ${info.version}`,
    `- Browser: ${info.userAgent}`,
    `- Theme: ${info.theme}`,
    `- Time: ${info.time}`);
  return out.join('\n');
}

function url(title: string, b: string): string {
  return `${REPO_URL}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(b)}`;
}

/** The "new issue" URL, under `max` characters: stack frames go first, then the message is cut. */
export function issueUrl(info: ReportInfo, max = MAX_URL): string {
  const title = info.message !== undefined ? `Error: ${oneLine(info.message, 100)}` : 'Problem report';
  let lines = info.stack ? info.stack.split('\n') : [];
  let u = url(title, body(info, lines.join('\n') || undefined));
  while (u.length > max && lines.length > 0) {
    // Drop frames from the end, many at a time while far over.
    const over = u.length - max;
    lines = lines.slice(0, Math.max(0, lines.length - Math.max(1, Math.floor(over / 200))));
    const st = lines.length ? [...lines, '… (trimmed)'].join('\n') : undefined;
    u = url(title, body(info, st));
  }
  if (u.length > max && info.message !== undefined) {
    // Still too long: an enormous message. Cut it to what fits (encoding can triple a character).
    let n = Math.max(0, info.message.length - Math.ceil((u.length - max) / 3) - 20);
    do {
      u = url(title, body({ ...info, message: info.message.slice(0, n) + '… (trimmed)' }, undefined));
      n = Math.floor(n * 0.8);
    } while (u.length > max && n > 0);
  }
  if (u.length > max) u = url(title, body({ ...info, userAgent: oneLine(info.userAgent, 120), message: info.message && oneLine(info.message, 100) }, undefined));
  return u;
}
