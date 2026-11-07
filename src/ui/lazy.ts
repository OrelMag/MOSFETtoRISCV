// Heavy figures that fill in after a step has drawn. A step's prose and stage appear at once; a number or a widget that needs seconds of arithmetic
// (a second of the band through the receiver) is a placeholder (aria-busy) that a queue of small tasks replaces, one unit of work per macrotask, so no task
// holds the page for long. Outside a browser (tests, Node) every value is computed on the spot and the text is the same.

type Task = { run: () => void; alive: () => boolean };
const queue: Task[] = [];
let pumping = false;

const pump = (): void => {
  const t = queue.shift();
  if (!t) { pumping = false; return; }
  try { if (t.alive()) t.run(); } catch (e) { console.error(e); }
  setTimeout(pump, 0);
};
/** Run `run` in a task of its own, after the ones queued before it; skipped when `alive` says the page it belongs to is gone. */
export function enqueue(run: () => void, alive: () => boolean = () => true): void {
  queue.push({ run, alive });
  if (pumping) return;
  pumping = true;
  // the first task waits for a frame, so what is already built is painted before the arithmetic starts
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(pump, 0)); else setTimeout(pump, 0);
}

const inBrowser = typeof document !== 'undefined';
let seq = 0;
const fills = new Map<string, () => string>();

/** Text for a number that costs real time: a placeholder in the page, filled in later (see `settleLazy`); the value itself outside a browser. */
export function lz(f: () => string): string {
  if (!inBrowser) return f();
  const id = String(++seq);
  if (fills.size > 400) fills.clear();
  fills.set(id, f);
  return `<span class="lz" data-lz="${id}" aria-busy="true">…</span>`;
}

/** Fill the placeholders `lz` left in `root`, in reading order, one per task. */
export function settleLazy(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-lz]'))) {
    const f = fills.get(el.dataset.lz!);
    fills.delete(el.dataset.lz!);
    if (!f) continue;
    enqueue(() => { el.textContent = f(); el.removeAttribute('aria-busy'); el.classList.add('lz-done'); }, () => el.isConnected);
  }
}

/** A widget that draws a placeholder now and builds itself later. `warm` are the heavy pieces the build will ask for (each memoized by whoever computes it), run one per task first. */
export function deferred<W extends { el: HTMLElement; update?(): void; destroy?(): void }>(make: () => W, ...warm: Array<() => unknown>): () => W {
  return () => {
    if (!inBrowser) return make();
    let real: W | null = null, gone = false;
    const host = document.createElement('div');
    host.className = 'widget mos sr-w sdr-w';
    host.setAttribute('aria-busy', 'true');
    const p = document.createElement('div');
    p.className = 'panel';
    const note = document.createElement('p');
    note.className = 'sub lz-note';
    note.textContent = 'Computing…';
    p.append(note);
    host.append(p);
    const alive = () => !gone && host.isConnected;
    for (const w of warm) enqueue(() => { w(); }, alive);
    enqueue(() => {
      real = make();
      host.className = real.el.className;
      host.replaceChildren(...Array.from(real.el.childNodes));
      host.removeAttribute('aria-busy');
    }, alive);
    return { el: host, update: () => real?.update?.(), destroy: () => { gone = true; real?.destroy?.(); } } as unknown as W;
  };
}

/** An object whose fields are computed on first read, each once. */
export function lazyProps<T extends object>(spec: { [K in keyof T]: () => T[K] }): T {
  const out = {} as T;
  for (const k of Object.keys(spec) as Array<keyof T>) {
    let done = false, v: T[keyof T];
    Object.defineProperty(out, k, { enumerable: true, get: () => { if (!done) { v = spec[k](); done = true; } return v; } });
  }
  return out;
}
