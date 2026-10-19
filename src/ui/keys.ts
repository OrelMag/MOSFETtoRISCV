// Keyboard: one table of every key the site answers (the help sheets are drawn from it), matching that
// survives a non-Latin layout, the single-key switch (WCAG 2.1.4) and the global dispatcher. DOM-free
// apart from installKeys, so the table and the matching are tested in Node.
//
// Order of the listeners: Ctrl/⌘ K runs in the window's capture phase, so a drawer or dialog that stops
// keydown in the bubble phase can't swallow it. Every other global key runs in the window's bubble phase,
// after the page's own document listeners: a key they took (preventDefault: the sandbox flipping a wire
// with `/`, a Key part holding its letter, a code editor) never reaches it.

import { settings } from './settings';

export const MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.userAgent);
/** The command modifier as shown: ⌘ on a Mac, else Ctrl. */
export const MOD = MAC ? '⌘' : 'Ctrl';

/** The parts of a KeyboardEvent matching reads (tests pass plain objects). */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * One way to press a binding. `key` is compared with event.key (lower-cased), and when the layout
 * typed a non-Latin character (Hebrew כ for F) with event.code instead. `codeOnly` compares event.code
 * alone: the brackets, which a Hebrew layout swaps. `shift` undefined: either.
 */
export interface KeySpec {
  key?: string;
  code?: string;
  codeOnly?: boolean;
  shift?: boolean;
  /** Ctrl or ⌘ held. */
  mod?: boolean;
}

export type KeyGroup = 'anywhere' | 'chapter' | 'stage' | 'place' | 'wire' | 'select' | 'edit' | 'view' | 'panels';

export const GROUP_TITLES: Record<KeyGroup, string> = {
  anywhere: 'Anywhere', chapter: 'This chapter', stage: 'Circuit (when focused)',
  place: 'Place', wire: 'Wire', select: 'Select and move', edit: 'Edit', view: 'View and run', panels: 'Panels and search',
};

export interface KeyDef {
  id: string;
  group: KeyGroup;
  /** Key caps as shown; '…' and '·' are drawn as plain text between them. */
  caps: string[];
  does: string;
  /** How it is matched by the dispatcher (none: listed only, handled by its own listener). */
  match?: KeySpec[];
  /** Matched in the capture phase, before any page listener (Ctrl K). */
  capture?: boolean;
  /** Single keys a Key part could take from this binding (the sandbox sheet strikes them through). */
  taken?: string[];
}

const letter = (l: string): KeySpec => ({ key: l, code: `Key${l.toUpperCase()}` });

/** Every key the site answers. Only implemented keys belong here: the help sheets list all of them. */
export const KEYS: readonly KeyDef[] = [
  // ---- anywhere
  { id: 'search', group: 'anywhere', caps: [`${MOD} K`, '/'], does: 'search chapters, components, levels, the codex and actions (> for actions)',
    match: [{ ...letter('k'), mod: true, shift: false }], capture: true },
  { id: 'search.slash', group: 'anywhere', caps: [], does: '', match: [{ key: '/', code: 'Slash' }] },
  { id: 'help', group: 'anywhere', caps: ['?'], does: 'the keys on this page', match: [{ key: '?' }] },
  { id: 'esc', group: 'anywhere', caps: ['Esc'], does: 'close the top dialog or menu (in search: clear the query first)' },
  { id: 'code.leave', group: 'anywhere', caps: ['Esc', 'Tab'], does: 'leave a code editor (there Tab indents)' },
  { id: 'skip', group: 'anywhere', caps: ['Tab'], does: 'the first stop is "Skip to the circuit" (on pages with one)' },
  // ---- chapter pages
  { id: 'step.next', group: 'chapter', caps: [']'], does: 'next step (at the end: the next chapter)', match: [{ code: 'BracketRight', codeOnly: true, shift: false }] },
  { id: 'step.prev', group: 'chapter', caps: ['['], does: 'previous step', match: [{ code: 'BracketLeft', codeOnly: true, shift: false }] },
  { id: 'chapter.next', group: 'chapter', caps: ['}'], does: 'next chapter', match: [{ code: 'BracketRight', codeOnly: true, shift: true }] },
  { id: 'chapter.prev', group: 'chapter', caps: ['{'], does: 'previous chapter', match: [{ code: 'BracketLeft', codeOnly: true, shift: true }] },
  // ---- the stage (chapters and the workbench)
  { id: 'stage.focus', group: 'stage', caps: ['S'], does: 'focus the circuit (Tab from it goes on to its controls)', match: [letter('s')] },
  { id: 'stage.probe', group: 'stage', caps: ['P'], does: 'probe mode: click wires to record them', match: [letter('p')] },
  { id: 'stage.up', group: 'stage', caps: ['Esc', '·', 'Backspace'], does: 'leave probe mode, else up one level' },
  { id: 'stage.undo', group: 'stage', caps: [`${MOD} Z`, '·', `${MOD} Y`], does: 'undo · redo moving parts' },
  // ---- the sandbox (and campaign levels)
  { id: 'sb.fav', group: 'place', caps: ['1', '…', '9'], does: 'arm favourite n; a click places it (Shift-click: several)', taken: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] },
  { id: 'sb.pointer', group: 'place', caps: ['L', '·', 'T'], does: 'arm a pointer · a comment (same pointer name = same net)', match: [letter('l')], taken: ['l', 't'] },
  { id: 'sb.comment', group: 'place', caps: [], does: '', match: [letter('t')] },
  { id: 'sb.disarm', group: 'place', caps: ['Esc'], does: 'disarm · leave Type' },
  { id: 'sb.flipL', group: 'wire', caps: ['Space', '·', '/'], does: 'flip the wire\'s L while drawing', taken: ['/'] },
  { id: 'sb.corner', group: 'wire', caps: ['Backspace'], does: 'remove the last corner' },
  { id: 'sb.wireEsc', group: 'wire', caps: ['Esc'], does: 'cancel the wire' },
  { id: 'sb.nudge', group: 'select', caps: ['←↑↓→'], does: 'nudge the selection (Shift: ×5)' },
  { id: 'sb.all', group: 'select', caps: [`${MOD} A`], does: 'select all' },
  { id: 'sb.clear', group: 'select', caps: ['Esc'], does: 'clear the selection' },
  { id: 'sb.rename', group: 'edit', caps: ['F2'], does: 'rename the selected part, pin or pointer (a comment: edit its text)' },
  { id: 'sb.flip', group: 'edit', caps: ['F'], does: 'flip the selection left–right', match: [letter('f')], taken: ['f'] },
  { id: 'sb.del', group: 'edit', caps: ['Del', '·', 'Backspace'], does: 'delete the selection' },
  { id: 'sb.clip', group: 'edit', caps: [`${MOD} C`, 'X', 'V', 'D'], does: 'copy · cut · paste at the cursor · duplicate' },
  { id: 'sb.undo', group: 'edit', caps: [`${MOD} Z`, '·', `${MOD} Y`], does: `undo · redo (also ${MOD} Shift Z)` },
  { id: 'sb.run', group: 'view', caps: [`${MOD} ↵`], does: 'run / pause the simulation' },
  { id: 'sb.probe', group: 'view', caps: ['P'], does: 'probe mode: click wires to record them', match: [letter('p')], taken: ['p'] },
  { id: 'sb.space', group: 'view', caps: ['Space'], does: 'held: pan with a drag' },
  { id: 'sb.search', group: 'panels', caps: [`${MOD} K`, '·', '/'], does: 'search; > lists every toolbar action (Type, Package, Export…)', taken: ['/'] },
  { id: 'sb.help', group: 'panels', caps: ['?'], does: 'this sheet', match: [{ key: '?' }], taken: ['?'] },
  { id: 'sb.panelEsc', group: 'panels', caps: ['Esc'], does: 'close a panel when focus is in it' },
];

const byId = new Map(KEYS.map((d) => [d.id, d]));
export const keyDef = (id: string): KeyDef | undefined => byId.get(id);

/** A character from a non-Latin layout (Hebrew, Cyrillic, Greek …): then the key's position decides. */
const foreign = (k: string) => [...k].length === 1 && k.codePointAt(0)! > 0x7f;

/** Does the event press `s`? */
export function matchSpec(e: KeyLike, s: KeySpec): boolean {
  if (e.altKey || !!s.mod !== !!(e.ctrlKey || e.metaKey)) return false;
  if (s.shift !== undefined && s.shift !== !!e.shiftKey) return false;
  if (s.codeOnly) return e.code === s.code;
  if (s.key !== undefined && e.key.toLowerCase() === s.key) return true;
  return s.code !== undefined && foreign(e.key) && e.code === s.code;
}

/** Does the event press the binding `id` (any of its ways)? */
export function matches(e: KeyLike, id: string): boolean {
  return !!byId.get(id)?.match?.some((s) => matchSpec(e, s));
}

/**
 * A single character-key shortcut (letters, digits, punctuation, no Ctrl / ⌘ / Alt): the kind WCAG 2.1.4
 * wants a way to turn off. Space, Esc, arrows, Delete, F-keys and Enter are not.
 */
export function isSingleKey(e: KeyLike): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey && [...e.key].length === 1 && e.key !== ' ';
}

/** May this key act as a shortcut? Not a single character key while single-key shortcuts are off. */
export function shortcutAllowed(e: KeyLike, on = settings.singleKeys): boolean {
  return on || !isSingleKey(e);
}

const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);

/** The focus is in a field that takes typing. */
export function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  // a checkbox, radio or button input takes no typing: shortcuts still work there
  if (el.tagName === 'INPUT') return !NOT_TEXT.has((el as HTMLInputElement).type);
  return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.isContentEditable;
}

/**
 * The focus is in something that owns its keys: a field, a canvas (3D views, DOOM), an application
 * region, a dialog or menu (which have their own keys). Global single keys stay out of those.
 */
export function ownsKeys(t: EventTarget | null): boolean {
  if (typing(t)) return true;
  const el = t as Element | null;
  return !!el?.closest?.('canvas, [role=application], [role=dialog], [role=menu], [role=listbox], [data-own-keys]');
}

// ---- the dispatcher ---------------------------------------------------------------------------

export type KeyHandler = (e: KeyboardEvent) => boolean | void;
type Layer = Partial<Record<string, KeyHandler>>;
const layers: Layer[] = [];

/**
 * Handle bindings of the table (by id) while bound: returns the unbind. Later layers are asked first;
 * a handler that returns false passes the key on. A handled key is preventDefault-ed.
 */
export function bindKeys(map: Layer): () => void {
  layers.push(map);
  return () => {
    const i = layers.indexOf(map);
    if (i >= 0) layers.splice(i, 1);
  };
}

/** The handler a key goes to, if any (exported for tests). */
export function dispatch(e: KeyLike, phase: 'capture' | 'bubble'): KeyHandler | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    for (const [id, f] of Object.entries(layers[i])) {
      const d = byId.get(id);
      if (!f || !d || !!d.capture !== (phase === 'capture')) continue;
      if (matches(e, id)) return f;
    }
  }
  return null;
}

let installed = false;

/** The two window listeners (once, at start-up), and the root's data-singlekeys for CSS key hints. */
export function installKeys(): void {
  if (installed) return;
  installed = true;
  const run = (e: KeyboardEvent, phase: 'capture' | 'bubble') => {
    const f = dispatch(e, phase);
    if (f && f(e) !== false) e.preventDefault();
  };
  window.addEventListener('keydown', (e) => {
    if (!e.altKey) run(e, 'capture');
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || ownsKeys(e.target) || !shortcutAllowed(e)) return;
    run(e, 'bubble');
  });
  const sync = () => document.documentElement.toggleAttribute('data-nosinglekeys', !settings.singleKeys);
  settings.onChange(sync);
  sync();
}
