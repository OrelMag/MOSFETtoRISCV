import { describe, expect, it } from 'vitest';
import { beatsOf, beatText, SANDBOX_BEATS, STAGE_BEATS } from '../src/ui/coachplan';
import { byPointer } from '../src/ui/dom';
import { NAV_STAGES, navStage } from '../src/ui/navfit';
import { placeMode } from '../src/ui/wording';

// What a touch screen must never be told: a mouse button, a wheel, a key, hovering. (Plain "click" is not listed: it
// reads as "tap" on a phone; the beats say "tap" anyway.)
const MOUSE_ONLY = /double-click|right-click|shift-click|wheel|\bSpace\b|\bEsc\b|\bCtrl|hover|\bpress [A-Z]\b|\([A-Z]\)|\bL adds\b|\bM shows\b/i;

describe('wording by input device', () => {
  it('byPointer picks the touch wording only when touch is the main pointer', () => {
    expect(byPointer(false, 'click', 'tap')).toBe('click');
    expect(byPointer(true, 'click', 'tap')).toBe('tap');
  });

  it('the sandbox places parts by dragging, from a drawer with a mouse in a narrow window, by taps on touch', () => {
    expect(placeMode(false, false)).toBe('drag');
    expect(placeMode(false, true)).toBe('drawer');
    expect(placeMode(true, true)).toBe('tap');
    expect(placeMode(true, false)).toBe('tap'); // a tablet: the palette is beside the canvas but a finger taps
  });

  it('a beat reads its touch wording on touch, its own on a mouse', () => {
    for (const b of [...STAGE_BEATS, ...SANDBOX_BEATS]) {
      expect(beatText(b, false)).toEqual({ title: b.title, text: b.text });
      const t = beatText(b, true);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.text.length).toBeGreaterThan(40);
      if (!b.touch) expect(t).toEqual({ title: b.title, text: b.text });
    }
    expect(beatsOf('stage', false)).toBe(STAGE_BEATS);
  });

  it('no touch wording mentions a mouse button, the wheel, hover or a key', () => {
    for (const b of beatsOf('stage', true, true)) expect(`${b.title} ${b.text}`).not.toMatch(MOUSE_ONLY);
    for (const b of [...STAGE_BEATS, ...SANDBOX_BEATS]) {
      if (!b.touch) continue;
      expect(`${b.touch.title ?? ''} ${b.touch.text}`).not.toMatch(MOUSE_ONLY);
    }
    // and the beats whose mouse wording is a mouse or key instruction all have a touch one
    for (const b of [...STAGE_BEATS, ...SANDBOX_BEATS]) {
      if (MOUSE_ONLY.test(`${b.title} ${b.text}`)) expect(b.touch, b.id).toBeTruthy();
    }
  });

  it('the phone top bar sheds captions in steps until none is cut', () => {
    expect(NAV_STAGES[0]).toBe('');
    expect(navStage(() => false)).toBe('');
    expect(navStage((s) => s === '')).toBe('tight');
    expect(navStage((s) => s === '' || s === 'tight')).toBe('icons');
    expect(navStage(() => true)).toBe('icons'); // the last resort
  });
});
