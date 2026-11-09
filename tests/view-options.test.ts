import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyTheme, PRESETS, settings } from '../src/ui/settings';
import { legibleOptions } from '../src/ui/legibleopts';
import { evalOnce, simulate } from '../src/sim/harness';
import { PREVIEW_DEF } from '../src/ui/viewpreview';

const css = (f: string) => readFileSync(new URL(`../src/styles/${f}`, import.meta.url), 'utf8');

describe('view options', () => {
  afterEach(() => settings.resetView());

  it('reset puts every option back, and only those', () => {
    settings.visit('c1', 3);
    settings.solve('c1:3');
    const theme = settings.theme;
    settings.setVivid(false);
    settings.set('palette', 'print');
    settings.set('wireScale', 'thick');
    settings.set('grid', 'off');
    settings.set('reduceMotion', true);
    settings.set('singleKeys', false);
    settings.set('textSize', 130);
    settings.resetView();
    expect([settings.vivid, settings.netColors, settings.palette, settings.wireScale, settings.grid, settings.reduceMotion, settings.singleKeys, settings.textSize])
      .toEqual([true, true, 'default', 'normal', 'dots', false, true, 100]);
    expect(settings.visited('c1')).toContain(3);
    expect(settings.isSolved('c1:3')).toBe(true);
    expect(settings.theme).toBe(theme);
  });

  it('after a reset the vivid look owns colour per net again', () => {
    settings.set('netColors', true); // by hand: the vivid look no longer owns it
    settings.resetView();
    settings.setVivid(false);
    expect(settings.netColors).toBe(false);
  });

  it('a snapshot gives back what a reset took', () => {
    settings.set('grid', 'lines');
    settings.setVivid(false);
    const before = settings.view();
    settings.resetView();
    expect(settings.grid).toBe('dots');
    settings.setView(before);
    expect([settings.grid, settings.vivid, settings.netColors]).toEqual(['lines', false, false]);
  });

  it('setView tells its listeners once', () => {
    let told = 0;
    const off = settings.onChange(() => told++);
    settings.setView({ grid: 'off', wireScale: 'thin', reduceMotion: true });
    off();
    expect(told).toBe(1);
  });

  it('the thickness scales the vivid look too, not over it', () => {
    expect(css('app.css')).toMatch(/--wire-k: var\(--wire-user\)/);
    expect(css('vivid.css')).toMatch(/--wire-k: calc\(1\.6 \* var\(--wire-user\)\)/);
    // no other rule sets the scale: thickness would stop working under it
    expect(`${css('palettes.css')}${css('theme.css')}${css('editor.css')}`).not.toMatch(/--wire-k\s*:/);
  });

  it('a hidden grid keeps the rect that takes the canvas\'s clicks', () => {
    const app = css('app.css');
    expect(app).toMatch(/:root\[data-grid\] \.grid-dot \{ display: none; \}/);
    expect(app).not.toMatch(/\[data-grid[^\]]*\][^{]*\.grid-bg/);
  });

  it('labels can go, but the reset brings them back', () => {
    for (const k of ['portNames', 'partNames', 'busValues', 'tapRanges'] as const) settings.set(k, false);
    expect([settings.portNames, settings.partNames, settings.busValues, settings.tapRanges]).toEqual([false, false, false, false]);
    settings.resetView();
    expect([settings.portNames, settings.partNames, settings.busValues, settings.tapRanges]).toEqual([true, true, true, true]);
  });

  it('a hidden name still shows under the pointer, and paper never loses one', () => {
    const app = css('app.css');
    expect(app).toMatch(/data-hide~='ports'\] svg\.schematic \.inst:not\(:hover\) \.sym-port/);
    expect(app).toMatch(/data-hide~='parts'\] svg\.schematic \.inst:not\(:hover\) :is\(\.sym-label, \.inst-name\)/);
    // the fixed-size names set an inline display (view/legible.ts)
    expect(app).toMatch(/data-hide~='parts'\] svg\.schematic \.lg-name \{ display: none !important; \}/);
    expect(app).toMatch(/\.tap-label:not\(\.net-hover, \.net-sel, \.fld\)/);
    const paper = readFileSync(new URL('../src/ui/pages/printfig.ts', import.meta.url), 'utf8');
    expect(paper).toContain("['data-hide', null]");
    expect(paper).toContain("['data-wires', null]");
  });

  it('a preset decides the look and is recognized, by hand it stops being one', () => {
    settings.set('theme', 'auto');
    settings.resetView();
    expect(settings.preset()).toBe('standard');
    for (const p of PRESETS) {
      settings.applyPreset(p.id);
      expect(settings.preset()).toBe(p.id);
    }
    settings.applyPreset('classroom');
    expect([settings.palette, settings.wireScale, settings.textSize, settings.reduceMotion]).toEqual(['contrast', 'thick', 120, true]);
    settings.set('grid', 'lines');
    expect(settings.preset()).toBeNull();
    settings.set('theme', 'auto');
  });

  it('a preset leaves the behaviour alone, and every preset can be left again', () => {
    settings.set('singleKeys', false);
    settings.set('simpleWires', true);
    settings.set('autoClock', false);
    settings.applyPreset('plain');
    expect([settings.singleKeys, settings.simpleWires, settings.autoClock]).toEqual([false, true, false]);
    settings.applyPreset('standard');
    expect([settings.vivid, settings.netColors, settings.cartoon, settings.palette]).toEqual([true, true, true, 'default']);
    expect(settings.singleKeys).toBe(false);
    // Standard hands colour per net back to the vivid look
    settings.setVivid(false);
    expect(settings.netColors).toBe(false);
    settings.set('theme', 'auto');
  });

  it('the Paper preset turns the theme light; an undo snapshot plus the theme brings all back', () => {
    settings.set('theme', 'dark');
    const before = { view: settings.view(), theme: settings.theme };
    settings.applyPreset('print');
    expect([settings.theme, settings.palette, settings.vivid]).toEqual(['light', 'print', false]);
    settings.set('theme', before.theme);
    settings.setView(before.view);
    expect([settings.theme, settings.palette, settings.vivid, settings.netColors]).toEqual(['dark', 'default', true, true]);
    settings.set('theme', 'auto');
  });

  it('the preview never draws the fixed-size names over its own labels (they set an inline display)', () => {
    expect(css('app.css')).toMatch(/\.pal-preview \.lg-name \{ display: none !important; \}/);
  });

  it('zoomed-out names and small text follow the options, and the reset brings them back', () => {
    // applyTheme hands them to view/legible.ts first, then sets the page's attributes (no document here)
    const apply = () => { try { applyTheme(); } catch { /* node */ } };
    settings.set('zoomNames', 'large'); settings.set('hideSmall', false); apply();
    expect(legibleOptions).toEqual({ names: 4 / 3, hideSmall: false });
    settings.set('zoomNames', 'off'); apply();
    expect(legibleOptions.names).toBe(0);
    settings.resetView(); apply();
    expect([settings.zoomNames, settings.hideSmall]).toEqual(['normal', true]);
    expect(legibleOptions).toEqual({ names: 1, hideSmall: true });
  });

  it('the preview is a working circuit: a ^ b, the low bit inverted', () => {
    expect(evalOnce(simulate(PREVIEW_DEF), [0b0101, 0b0011])).toEqual([1, 0b011]);
  });

  it('the switch does what the system preference does', () => {
    const app = css('app.css');
    expect(app).toMatch(/:root\[data-reduce-motion\] \*, [^{]*\{ animation: none !important; transition: none !important; \}/);
    expect(app).toMatch(/:root\[data-reduce-motion\] :is\(\.wire-flow, \.flow-tokens\) \{ display: none; \}/);
    // the bus values the tokens carried stay on the wires
    expect(app).toMatch(/:not\(\[data-reduce-motion\]\) \.bus-label\.riding \{ display: none; \}/);
  });
});
