// The key table (ui/keys.ts): layout-safe matching (a Hebrew layout still triggers the letter
// shortcuts by position), the single-key switch (WCAG 2.1.4), the dispatcher's layers.

import { afterEach, describe, expect, it } from 'vitest';
import { bindKeys, dispatch, GROUP_TITLES, isSingleKey, KEYS, matches, matchSpec, shortcutAllowed, typing } from '../src/ui/keys';
import { singleDef } from '../src/ui/keyhelp';
import { settings } from '../src/ui/settings';

const ev = (key: string, code: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) =>
  ({ key, code, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt });

describe('key table', () => {
  it('has unique ids, known groups, and caps on every listed binding', () => {
    expect(new Set(KEYS.map((d) => d.id)).size).toBe(KEYS.length);
    for (const d of KEYS) {
      expect(GROUP_TITLES[d.group]).toBeTruthy();
      if (d.caps.length) expect(d.does.length).toBeGreaterThan(3);
      else expect(d.match?.length, `${d.id}: an unlisted binding must at least match`).toBeGreaterThan(0);
    }
  });

  it('lists only Ctrl K in the capture phase', () => {
    expect(KEYS.filter((d) => d.capture).map((d) => d.id)).toEqual(['search']);
  });

  it('marks the single character keys the switch turns off', () => {
    const single = (id: string) => singleDef(KEYS.find((d) => d.id === id)!);
    expect(['help', 'step.next', 'stage.focus', 'sb.flip', 'sb.fav', 'sb.probe'].every(single)).toBe(true);
    expect(['search', 'esc', 'sb.undo', 'sb.run', 'stage.up'].some(single)).toBe(false);
  });
});

describe('layout-independent matching', () => {
  it('matches letters by key on a Latin layout, by position on a Hebrew one', () => {
    expect(matches(ev('f', 'KeyF'), 'sb.flip')).toBe(true);
    expect(matches(ev('F', 'KeyF', { shift: true }), 'sb.flip')).toBe(true);
    // Hebrew: the F key types כ, the P key פ, the S key ד, the L key ך, the T key א
    expect(matches(ev('כ', 'KeyF'), 'sb.flip')).toBe(true);
    expect(matches(ev('פ', 'KeyP'), 'sb.probe')).toBe(true);
    expect(matches(ev('פ', 'KeyP'), 'stage.probe')).toBe(true);
    expect(matches(ev('ד', 'KeyS'), 'stage.focus')).toBe(true);
    expect(matches(ev('ך', 'KeyL'), 'sb.pointer')).toBe(true);
    expect(matches(ev('א', 'KeyT'), 'sb.comment')).toBe(true);
    expect(matches(ev('ל', 'KeyK', { ctrl: true }), 'search')).toBe(true);
  });

  it('follows the printed letter on another Latin layout (AZERTY, Dvorak): the position is only a fallback', () => {
    // Dvorak: the key in QWERTY's F position types u
    expect(matches(ev('u', 'KeyF'), 'sb.flip')).toBe(false);
    expect(matches(ev('f', 'KeyY'), 'sb.flip')).toBe(true);
  });

  it('matches the brackets by position (a Hebrew layout swaps them), Shift for the braces', () => {
    expect(matches(ev(']', 'BracketRight'), 'step.next')).toBe(true);
    expect(matches(ev('[', 'BracketLeft'), 'step.prev')).toBe(true);
    // Hebrew: the ] key types [ and the [ key types ]
    expect(matches(ev('[', 'BracketRight'), 'step.next')).toBe(true);
    expect(matches(ev(']', 'BracketLeft'), 'step.prev')).toBe(true);
    expect(matches(ev('}', 'BracketRight', { shift: true }), 'chapter.next')).toBe(true);
    expect(matches(ev('{', 'BracketLeft', { shift: true }), 'chapter.prev')).toBe(true);
    expect(matches(ev('}', 'BracketRight', { shift: true }), 'step.next')).toBe(false);
  });

  it('keeps modifiers apart: Ctrl F is not F, plain K is not Ctrl K, AltGr combinations are nothing', () => {
    expect(matches(ev('f', 'KeyF', { ctrl: true }), 'sb.flip')).toBe(false);
    expect(matches(ev('k', 'KeyK'), 'search')).toBe(false);
    expect(matches(ev('k', 'KeyK', { meta: true }), 'search')).toBe(true);
    expect(matches(ev('K', 'KeyK', { ctrl: true, shift: true }), 'search')).toBe(false);
    expect(matches(ev('[', 'BracketLeft', { ctrl: true, alt: true }), 'step.prev')).toBe(false);
    expect(matchSpec(ev('/', 'Slash'), { key: '/' })).toBe(true);
  });
});

describe('the single-key switch', () => {
  afterEach(() => settings.set('singleKeys', true));

  it('tells single character keys from the rest', () => {
    expect(['f', '/', '?', ']', '1', 'כ'].every((k) => isSingleKey(ev(k, '')))).toBe(true);
    expect(['Escape', 'ArrowUp', 'Delete', 'F2', 'Enter', ' '].some((k) => isSingleKey(ev(k, '')))).toBe(false);
    expect(isSingleKey(ev('k', 'KeyK', { ctrl: true }))).toBe(false);
  });

  it('is on by default, and off it lets only non-character keys and combinations through', () => {
    expect(settings.singleKeys).toBe(true);
    expect(shortcutAllowed(ev('f', 'KeyF'))).toBe(true);
    settings.set('singleKeys', false);
    expect(shortcutAllowed(ev('f', 'KeyF'))).toBe(false);
    expect(shortcutAllowed(ev(']', 'BracketRight'))).toBe(false);
    expect(shortcutAllowed(ev('k', 'KeyK', { ctrl: true }))).toBe(true);
    expect(shortcutAllowed(ev('Escape', 'Escape'))).toBe(true);
    expect(shortcutAllowed(ev('Delete', 'Delete'))).toBe(true);
  });
});

describe('dispatcher', () => {
  it('asks the latest layer first and drops a layer when unbound', () => {
    const a = () => true, b = () => true, k = () => true;
    const offA = bindKeys({ 'step.next': a, search: k });
    const offB = bindKeys({ 'step.next': b });
    expect(dispatch(ev(']', 'BracketRight'), 'bubble')).toBe(b);
    offB();
    expect(dispatch(ev(']', 'BracketRight'), 'bubble')).toBe(a);
    // Ctrl K only in the capture phase
    expect(dispatch(ev('k', 'KeyK', { ctrl: true }), 'bubble')).toBe(null);
    expect(dispatch(ev('k', 'KeyK', { ctrl: true }), 'capture')).toBe(k);
    offA();
    expect(dispatch(ev(']', 'BracketRight'), 'bubble')).toBe(null);
  });

  it('knows a field from the rest', () => {
    expect(typing({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(typing({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(typing({ tagName: 'BUTTON', isContentEditable: false } as unknown as EventTarget)).toBe(false);
    expect(typing({ tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget)).toBe(false);
    expect(typing({ tagName: 'INPUT', type: 'search' } as unknown as EventTarget)).toBe(true);
    expect(typing(null)).toBe(false);
  });
});
