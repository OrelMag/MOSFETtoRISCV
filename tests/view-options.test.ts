import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { settings } from '../src/ui/settings';

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

  it('the switch does what the system preference does', () => {
    const app = css('app.css');
    expect(app).toMatch(/:root\[data-reduce-motion\] \*, [^{]*\{ animation: none !important; transition: none !important; \}/);
    expect(app).toMatch(/:root\[data-reduce-motion\] :is\(\.wire-flow, \.flow-tokens\) \{ display: none; \}/);
    // the bus values the tokens carried stay on the wires
    expect(app).toMatch(/:not\(\[data-reduce-motion\]\) \.bus-label\.riding \{ display: none; \}/);
  });
});
