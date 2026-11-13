// A 3D model's picture for paper and for Save image: the stage registers how to draw itself (the canvas with its names,
// leaders and scale bar composed on it, or the flat SVG without WebGL2), and the print view finds it under a mounted
// widget. Tiny and DOM-light: the stage, the frame and the print page all import it.

export interface ModelShot {
  /** Resolves once the model has drawn (its first 3D frame, or the flat drawing); never rejects. */
  ready(): Promise<void>;
  /** The model as it stands, in paper's look when `paper` (light, whatever the learner's theme); null when nothing is drawn. */
  snapshot(paper: boolean): HTMLCanvasElement | SVGSVGElement | null;
}

const shots = new WeakMap<Element, ModelShot>();

/** The stage (`.r3-stage`) can be drawn by `s`. */
export function registerShot(stage: Element, s: ModelShot): void { shots.set(stage, s); }

/** The first registered stage under `root`. */
export function shotIn(root: Element): ModelShot | null {
  for (const e of root.querySelectorAll('.r3-stage')) { const s = shots.get(e); if (s) return s; }
  return null;
}

/** While the print view builds its figures: a stage made now shows its names whatever the setting, and turns nothing by itself. */
export const printing = { on: false };

/** The reader asked the browser to save data (Data Saver): a model waits for a click before its chunks load (the print view never waits). */
export const askFirst = (): boolean => !printing.on && !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;

/** Start `go` now, or with Data Saver on once the reader asks: `el` (the model's placeholder) then holds a note and a button. */
export function whenAsked(el: HTMLElement, what: string, go: () => void): void {
  if (!askFirst()) { go(); return; }
  const height = el.style.minHeight;
  el.style.minHeight = '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.textContent = `Show ${what}`;
  const note = document.createElement('p');
  note.className = 'm3-ask';
  // inline: the placeholder shows before the model's stylesheet arrives with its chunk
  note.style.cssText = 'margin:0 0 10px;color:var(--text-2);font-size:13.5px';
  note.textContent = 'Data Saver is on, so the 3D model loads only when you ask.';
  btn.addEventListener('click', () => { el.style.minHeight = height; el.textContent = `Loading ${what}…`; go(); });
  el.replaceChildren(note, btn);
}
