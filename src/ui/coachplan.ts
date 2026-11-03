// The first-run coach marks as data (DOM-free): the beats of each tour, which of them a page can show (a beat whose
// control is not on this page is skipped), and the keys' moves through them. ui/coachmarks.ts draws it.

export type CoachKind = 'stage' | 'sandbox';

export interface CoachBeat {
  id: string;
  /** CSS selector of the control it points at. */
  target: string;
  title: string;
  text: string;
  /** What a touch screen reads instead (each gesture confirmed with touch emulation: ui/wording.ts, tests/touchwording.test.ts). */
  touch?: { title?: string; text: string };
}

export const STAGE_BEATS: readonly CoachBeat[] = [
  { id: 'drill', target: '.stage .crumbs', title: 'Open any box',
    text: 'Double-click a part to look inside it, all the way down to the MOSFETs: every level is built from the one below. This path shows where you are; click a name to climb back, or press Esc.',
    touch: { text: 'Double-tap a part to look inside it, all the way down to the MOSFETs: every level is built from the one below. This path shows where you are; tap a name to climb back, or use the up-arrow button.' } },
  { id: 'walk', target: '.tour-go', title: 'Walk me through it',
    text: 'Plays this step as a narrated tour on the live circuit: inputs set, cycles run, parts lit. Next and Back move through it, and every value shown is the simulation\'s.' },
  { id: 'probe', target: '.stage .probe-btn', title: 'Probe a wire (P)',
    text: 'Press Probe, then click any wire. It gets a coloured flag and a lane in the Timing panel, so you can see when it changes and how many gate delays it took.',
    touch: { title: 'Probe a wire', text: 'Tap Probe, then tap any wire. It gets a coloured flag and a lane in the Timing panel, so you can see when it changes and how many gate delays it took.' } },
  { id: 'why', target: '.stage .why-btn', title: 'Why? (W)',
    text: 'Click a wire and Why? traces its value back through the gates to the inputs that decide it. Click a part instead to see what it is for.',
    touch: { title: 'Why?', text: 'Tap Why?, then tap a wire to trace its value back through the gates to the inputs that decide it.' } },
  { id: 'run', target: '.stage .controls .ctl-acts', title: 'Back, Step, Slow',
    text: 'Back undoes a step, a clock cycle or an input change. Step advances one gate delay. Slow motion in the top bar draws each change as a front over one gate.',
    touch: { text: 'Back undoes a step, a clock cycle or an input change. Step advances one gate delay.' } },
  { id: 'share', target: '.stage .share-btn', title: 'Share this view',
    text: 'Export this level as an SVG or PNG, or Copy link to this view: the step, the opened part, the inputs, probes and clock cycles, so whoever opens it sees what you see.' },
  { id: 'remix', target: '.stage .remix-btn', title: 'Open in Sandbox',
    text: 'Copies the circuit on screen into the sandbox as a chip of your own: rewire it, change it, run it with your own inputs.' },
];

export const SANDBOX_BEATS: readonly CoachBeat[] = [
  { id: 'parts', target: '.sandbox .sb-parts-btn', title: 'Parts',
    text: 'Open Parts, pick a part, then click the canvas to place it. The search box finds any library part or chip of yours.',
    touch: { text: 'Tap Parts, tap a part, then tap the canvas to place it. The search box finds any library part or chip of yours.' } },
  { id: 'palette', target: '.sandbox .sb-palette', title: 'Parts',
    text: 'Pick a part and click the canvas to place it; 1 to 9 arm your favourites. The search box finds any library part or chip of yours.',
    touch: { text: 'Tap a part, then tap the canvas to place it. The search box finds any library part or chip of yours.' } },
  { id: 'wire', target: '.sandbox .sb-canvas', title: 'Wiring',
    text: 'Drag from a pin to another pin to wire them. L adds a named pointer: the same name is the same net. Space and drag pans, the wheel zooms, M shows a minimap of a big chip.',
    touch: { text: 'Drag from a pin to another pin to wire them. The Pointer part (in Parts) is a named wire: the same name is the same net. Two fingers pan, pinch zooms; a minimap of a big chip appears in the corner, and dragging in it moves the view.' } },
  { id: 'inside', target: '.sandbox .sb-canvas', title: 'Look inside',
    text: 'Double-click a library part to look inside it, down to the transistors. Double-click a chip of your own to edit it; the tab breadcrumb brings you back.',
    touch: { text: 'Double-tap a library part to look inside it, down to the transistors. Double-tap a chip of your own to edit it; the tab breadcrumb brings you back.' } },
  { id: 'run', target: '.sandbox .sb-run', title: 'Run',
    text: 'Run starts the clock (Ctrl+Enter), Step advances it. Click an input pin to flip it; probe mode (P) records wires in the Timing panel.',
    touch: { text: 'Run starts the clock, Step advances it. Probe mode (in the Timing menu) records wires in the Timing panel.' } },
  { id: 'file', target: '.sandbox [data-action="file"]', title: 'File menu',
    text: 'Export and import chips, share a link, save images, export Verilog for a Yosys or FPGA flow, and keep several projects apart.' },
];

/** The beat as this screen reads it: its touch wording (title and text) when touch is the main pointer. */
export const beatText = (b: CoachBeat, coarse: boolean): { title: string; text: string } =>
  coarse && b.touch ? { title: b.touch.title ?? b.title, text: b.touch.text } : { title: b.title, text: b.text };

export function beatsOf(kind: CoachKind, coarse = false): readonly CoachBeat[] {
  const beats = kind === 'stage' ? STAGE_BEATS : SANDBOX_BEATS;
  return coarse ? beats.map((b) => ({ ...b, ...beatText(b, true) })) : beats;
}

/** The beats this page can show: those whose control `present` says is on screen. */
export function pickBeats(beats: readonly CoachBeat[], present: (target: string) => boolean): CoachBeat[] {
  return beats.filter((b) => present(b.target));
}

/** The state of a tour: which of its picked beats is showing. */
export interface CoachState { index: number; count: number }

export type CoachMove = 'next' | 'back';

/** The beat after a move; null when Next goes past the last (the tour is done). Back stops at the first. */
export function move(s: CoachState, m: CoachMove): number | null {
  if (m === 'back') return Math.max(0, s.index - 1);
  return s.index + 1 >= s.count ? null : s.index + 1;
}

/** Should a tour start by itself: not seen before, nothing else on screen asking for attention. */
export function mayAutoStart(o: { done: boolean; otherTour: boolean; dialogOpen: boolean }): boolean {
  return !o.done && !o.otherTour && !o.dialogOpen;
}

/** Does a tour of this kind belong on the page at `hash`? The sandbox's tour on a chapter (a route change while it
 *  waited or played) is a card about controls that are not there. */
export function coachFits(kind: CoachKind, hash: string): boolean {
  if (kind === 'sandbox') return /^#\/sandbox(\/|$)/.test(hash);
  return /^#\/(c|workbench)(\/|$)/.test(hash);
}
