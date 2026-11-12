// A link to a view: the route already names the chapter step and the part opened on the stage (drillpath.ts); this adds
// what the learner did to the circuit, as an optional suffix after a '?':
//
//   #/c/adders/3/fa0?i=a~5,b~ff&p=dp/alu~7&n=12
//     i  input values (hex) that differ from the scene's own          n  clock cycles run since the scene loaded
//     p  probed nets: the instance path (/ between names) ~ net index in that level
//     f  what the link is about, at the route's level: i~<instance> or n~<net index>; it is selected and flashed on load
//
// A link without the suffix opens exactly as before. DOM-free apart from the clipboard helper; the stage reads and applies it.

/** The public site, for a link made from the desktop program's app:// page (same as editor/files.ts SITE_URL; a test holds them equal). */
export const SITE_URL = 'https://switchtocpu.com/';

export interface ProbeRef {
  /** Instance names from the root to the level the net is in. */
  path: string[];
  /** Index into that level's netlist nets. */
  net: number;
}

export interface ViewState {
  /** Port name → value (BigInt: a bus may be wider than 53 bits). */
  inputs: Record<string, bigint>;
  probes: ProbeRef[];
  /** Clock cycles run since the scene loaded. */
  cycles: number;
  /** The part or wire the link points at, at the level the route opens. */
  focus?: ViewFocus;
}

export type ViewFocus = { inst: string } | { net: number };

export const emptyView = (): ViewState => ({ inputs: {}, probes: [], cycles: 0 });
export const isEmptyView = (v: ViewState): boolean => !Object.keys(v.inputs).length && !v.probes.length && !v.cycles && !v.focus;

/** Limits on what a link may ask for (a link is untrusted input). */
export const MAX_INPUTS = 64;
export const MAX_PROBES = 16;
export const MAX_CYCLES = 1_000_000;

// encodeURIComponent leaves '~' alone, which is the separator here
const enc = (s: string) => encodeURIComponent(s).replace(/~/g, '%7E');
const dec = (s: string): string | null => {
  try { return decodeURIComponent(s); } catch { return null; }
};

/** The suffix for a view ('' when it is the scene as loaded). */
export function encodeView(v: ViewState): string {
  const parts: string[] = [];
  const inputs = Object.entries(v.inputs);
  if (inputs.length) parts.push(`i=${inputs.map(([k, x]) => `${enc(k)}~${x.toString(16)}`).join(',')}`);
  if (v.probes.length) parts.push(`p=${v.probes.map((p) => `${p.path.map(enc).join('/')}~${p.net}`).join(',')}`);
  if (v.cycles > 0) parts.push(`n=${Math.floor(v.cycles)}`);
  if (v.focus) parts.push(`f=${'inst' in v.focus ? `i~${enc(v.focus.inst)}` : `n~${v.focus.net}`}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Split a hash into the route and its view suffix ('' when there is none). */
export function splitView(hash: string): { route: string; query: string } {
  const i = hash.indexOf('?');
  return i < 0 ? { route: hash, query: '' } : { route: hash.slice(0, i), query: hash.slice(i) };
}

/** A view from a suffix; whatever is malformed is left out (null: nothing usable). */
export function decodeView(query: string): ViewState | null {
  if (!query.startsWith('?')) return null;
  const v = emptyView();
  for (const part of query.slice(1).split('&')) {
    const eq = part.indexOf('=');
    const key = part.slice(0, eq), val = part.slice(eq + 1);
    if (eq < 0) continue;
    if (key === 'i') {
      for (const item of val.split(',').slice(0, MAX_INPUTS)) {
        const [name, hex] = item.split('~');
        const n = name === undefined ? null : dec(name);
        if (!n || !hex || !/^[0-9a-f]{1,260}$/.test(hex)) continue;
        v.inputs[n] = BigInt(`0x${hex}`);
      }
    } else if (key === 'p') {
      for (const item of val.split(',').slice(0, MAX_PROBES)) {
        const t = item.lastIndexOf('~');
        const net = Number(item.slice(t + 1));
        if (t < 0 || !Number.isInteger(net) || net < 0 || net > 1_000_000) continue;
        const raw = item.slice(0, t);
        const path = raw ? raw.split('/').map(dec) : [];
        if (path.some((s) => s === null || s === '')) continue;
        v.probes.push({ path: path as string[], net });
      }
    } else if (key === 'n') {
      const n = Number(val);
      if (Number.isInteger(n) && n > 0) v.cycles = Math.min(n, MAX_CYCLES);
    } else if (key === 'f') {
      const [kind, what] = val.split('~');
      if (kind === 'i' && what) {
        const inst = dec(what);
        if (inst) v.focus = { inst };
      } else if (kind === 'n' && /^\d{1,7}$/.test(what ?? '')) v.focus = { net: Number(what) };
    }
  }
  return isEmptyView(v) ? null : v;
}

/** The address of a hash on the public site's page (a web page's own address; the public site for the desktop program). */
export function linkTo(hash: string, href: string = typeof location === 'undefined' ? '' : location.href): string {
  return (/^https?:/i.test(href) ? href.replace(/#.*$/s, '') : SITE_URL) + hash;
}

// ---- hand-over from the router to the stage ------------------------------------------------------

/** What the view may do to the stage that is showing a scene. */
export interface ViewTarget {
  restoreView(v: ViewState): void;
  viewHash(): string;
  isLive(): boolean;
}

let pending: { view: ViewState; at: number } | null = null;
let active: ViewTarget | null = null;

/** The router: the suffix of the route just opened (null: none). One-shot, and stale after a few seconds. */
export function setPendingView(v: ViewState | null): void {
  pending = v ? { view: v, at: Date.now() } : null;
}

/** The stage that built a scene takes the view the route asked for (once). */
export function takePendingView(): ViewState | null {
  const p = pending;
  pending = null;
  return p && Date.now() - p.at < 8000 ? p.view : null;
}

export function setViewTarget(t: ViewTarget): void {
  active = t;
}

/** A stage going away lets go (else the last destroyed stage, its simulator and DOM, stayed until the next one took over). */
export function releaseViewTarget(t: ViewTarget): void {
  if (active === t) active = null;
}

/** A route to the step already on screen: the stage is not rebuilt, so apply the view to it now. */
export function applyPendingView(): void {
  if (pending && active?.isLive()) active.restoreView(takePendingView() ?? emptyView());
}

/** The link to what is on the stage now (null: no stage). */
export function currentViewLink(): string | null {
  if (!active?.isLive()) return null;
  return linkTo(active.viewHash());
}

/** The address of what is on the stage now, view suffix included (null: no stage). */
export function currentViewHash(): string | null {
  return active?.isLive() ? active.viewHash() : null;
}

/** Put text on the clipboard; false when the browser will not (insecure page, no permission). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
