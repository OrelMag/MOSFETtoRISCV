// App shell: top bar, theme, global settings and hash routing.

import { outline, outlineOf } from '../chapters/outline';
import { loadChapter } from '../chapters/load';
import { movedAddress } from '../chapters/stepmoves';
import { h, icon, s } from './dom';
import { installErrorReporting, loadFailed } from './errors';
import type { ChapterPage, Page } from './pages/chapter';
import { homePage } from './pages/home';
import type { WorkbenchPage } from './pages/workbench';
import { notes, NOTES_KEY } from './notes';
import { focusStage, installQuickNav, openQuickNav, QUICK_KEY, toggleChapterMenu } from './quicknav';
import { applyTheme, PALETTES, PRESETS, settings, TEXT_SIZES, type GridStyle, type Theme, type ViewState, type WireScale, type ZoomNames } from './settings';
import { systemReducedMotion } from './motion';
import { parseDrill } from './drillpath';
import { applyPendingView, decodeView, setPendingView, splitView } from './viewlink';
import type { Radix } from '../sim/values';
import { isTwinKey } from '../campaign/twinids';
import { menuKeys } from './menukeys';
import { installNavFit } from './navfit';
import { installReturn, type ReturnLabelled } from './returnto';
import { routeTitle, setPageTitle } from './pagetitle';
import { notFound } from './notfound';

/**
 * Which of the top bar's circuit settings a route uses: the bus radix wherever a circuit is drawn
 * (Stage: chapters and the workbench; the editor: sandbox and campaign levels), Slow motion only on
 * a Stage (the editor has its own gate-delay mode). Elsewhere they would do nothing.
 */
function stageTools(parts: string[]): { radix: boolean; slow: boolean } {
  const [key, sub] = parts;
  const stage = key === 'c' || (key === 'workbench' && sub !== 'stats' && sub !== 'bench' && sub !== 'lab');
  return { radix: stage || key === 'sandbox' || (key === 'campaign' && sub === 'play'), slow: stage };
}

export function startApp(root: HTMLElement): void {
  installErrorReporting();
  applyTheme();
  const view = h('main', { id: 'view' });
  const nav = h('nav', { class: 'nav' });
  const navLink = (href: string, ic: string, label: string, key: string, short?: string) =>
    h('a', { href, 'data-key': key, title: label, 'aria-label': label }, icon(ic, 16), h('span', null, label), ...(short ? [h('span', { class: 'cap', 'aria-hidden': 'true' }, short)] : []));
  // "Chapters" opens the chapter menu rather than the first chapter (still a link: new tab works).
  const chLink = navLink('#/c/map/0', 'book', 'Chapters', 'c', 'Chapters');
  chLink.append(icon('chevD', 14));
  chLink.setAttribute('aria-haspopup', 'menu');
  chLink.setAttribute('aria-expanded', 'false');
  chLink.title = `All chapters (${QUICK_KEY} to search)`;
  chLink.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    toggleChapterMenu(chLink);
  });
  // "My path" (the tiers, what next) in place of "Journey": the logo still goes home.
  nav.append(navLink('#/path', 'layers', 'My path', 'path', 'Path'), chLink, navLink('#/campaign', 'flag', 'Campaign', 'campaign', 'Campaign'),
    navLink('#/workbench/rca4', 'bench', 'Workbench', 'workbench', 'Bench'), navLink('#/sandbox', 'chip', 'Sandbox', 'sandbox', 'Sandbox'));
  // "My notes · n" shows once there is a note or a bookmark (ui/notes.ts)
  const notesLink = navLink('#/notes', 'note', 'My notes', 'notes');
  const syncNotes = () => {
    const n = notes().count;
    notesLink.hidden = !n;
    notesLink.querySelector('span')!.replaceChildren(h('span', { class: 'nl' }, 'My notes · '), String(n));
    notesLink.setAttribute('aria-label', `My notes, ${n}`);
    notesLink.title = `${n} note${n === 1 ? '' : 's'} and bookmarks, and the review queue`;
  };
  notes().onChange(syncNotes);
  window.addEventListener('storage', (e) => { if (e.key === NOTES_KEY) { notes().reload(); } });
  syncNotes();
  nav.append(notesLink);
  installQuickNav();
  const searchBtn = h('button', { class: 'btn ghost icon-only', title: `Search chapters, components, levels, codex and actions (${QUICK_KEY}, /)`, 'aria-label': 'Search', 'aria-keyshortcuts': 'Control+K /', onclick: () => openQuickNav() }, icon('search', 18));
  // The first Tab stop: straight to the circuit where a page has one (S does the same), else to the page.
  const skip = h('button', { class: 'skip-link' }, 'Skip to the content');
  skip.addEventListener('focus', () => { skip.textContent = document.querySelector('#view section.stage, #view svg.ed-svg') ? 'Skip to the circuit' : 'Skip to the content'; });
  skip.addEventListener('click', () => {
    // the sandbox and a level have no stage section: the editor's canvas is the circuit (a Tab stop of its own)
    if (focusStage()) return;
    const canvas = view.querySelector<SVGElement>('svg.ed-svg');
    if (canvas) canvas.focus();
    else view.focus();
  });

  // one radio group: one tab stop, the arrows move the choice (three plain buttons were three stops with no checked state)
  const radix = h('div', { class: 'seg', role: 'radiogroup', title: 'How buses show their value', 'aria-label': 'How buses show their value' });
  const radixes: [Radix, string, string][] = [['hex', 'HEX', 'hexadecimal'], ['bin', 'BIN', 'binary'], ['dec', 'DEC', 'decimal']];
  for (const [r, label, long] of radixes) radix.append(h('button', { 'data-r': r, role: 'radio', title: `Bus values in ${long}`, onclick: () => settings.set('radix', r) }, label));
  radix.addEventListener('keydown', (e) => {
    const k = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!k) return;
    e.preventDefault();
    const i = radixes.findIndex(([r]) => r === settings.radix), next = radixes[(i + k + radixes.length) % radixes.length][0];
    settings.set('radix', next);
    radix.querySelector<HTMLButtonElement>(`[data-r="${next}"]`)?.focus();
  });

  // A snail, not a play triangle: on a phone the label is hidden and ▶ read as "Run".
  const animate = h('button', { class: 'btn sm toggle slow-btn', title: 'Slow motion: one gate delay at a time, each change travelling along its wires', 'aria-label': 'Slow motion' },
    icon('slow', 16), h('span', { class: 'lbl' }, 'Slow motion'));
  animate.addEventListener('click', () => settings.set('animate', !settings.animate));

  const themeBtn = h('button', { class: 'btn ghost icon-only', 'aria-label': 'Theme' });
  const themes: Theme[] = ['auto', 'light', 'dark'];
  themeBtn.addEventListener('click', () => {
    settings.set('theme', themes[(themes.indexOf(settings.theme) + 1) % themes.length]);
    applyTheme();
  });

  // Palette menu: a swatch button opening a small list (0, 1, X and bus colours per entry).
  const swatch = () => h('span', { class: 'pal-sw' }, h('i', { class: 's0' }), h('i', { class: 's1' }), h('i', { class: 'sx' }), h('i', { class: 'sb' }));
  const palMenu = h('div', { class: 'pal-menu', role: 'menu', 'aria-label': 'View options' });
  // Sections, so the long list reads as four short ones (the backup lives on the home page, the search's actions and the storage note).
  const palHead = (t: string) => h('div', { class: 'pal-head', role: 'presentation' }, t);
  // Presets first: the short way through a long list. Each offers its undo until the menu closes.
  const previewHost = h('div', { class: 'pal-preview', 'aria-hidden': 'true' });
  let undoView: { view: ViewState; theme: Theme } | null = null;
  const remember = () => { undoView ??= { view: settings.view(), theme: settings.theme }; };
  const presetBtns = PRESETS.map((p) => h('button', { class: 'btn sm toggle', 'data-preset': p.id, title: p.blurb, onclick: () => {
    remember();
    settings.applyPreset(p.id);
    applyTheme();
    syncTools();
  } }, p.name));
  const undoItem = h('button', { class: 'pal-reset', hidden: true, onclick: () => {
    if (undoView) {
      settings.set('theme', undoView.theme);
      settings.setView(undoView.view);
    }
    undoView = null;
    applyTheme();
    syncTools();
  } }, 'Undo: back to what you had');
  palMenu.append(previewHost, palHead('Presets'), h('div', { class: 'pal-presets', role: 'group', 'aria-label': 'Presets' }, presetBtns), undoItem);
  palMenu.append(palHead('Wire colours'));
  for (const p of PALETTES) {
    const item = h('button', { role: 'menuitemradio', 'data-p': p.id, onclick: () => {
      settings.set('palette', p.id);
      applyTheme();
    } }, h('span', { class: 'pal-sw', 'data-palette': p.id }, h('i', { class: 's0' }), h('i', { class: 's1' }), h('i', { class: 'sx' }), h('i', { class: 'sb' })),
    h('span', null, h('b', null, p.name), h('small', null, p.blurb)));
    palMenu.append(item);
  }
  // Vivid look (styles/vivid.css): bright filled parts and thick wires, by default on a dark board; turns colour per net on.
  const vividItem = h('button', { role: 'menuitemcheckbox', class: 'pal-vivid', onclick: () => {
    settings.setVivid(!settings.vivid);
    applyTheme();
  } }, h('span', { class: 'pal-sw pal-vivid-sw' }, h('i', { class: 'm0' }), h('i', { class: 'm1' }), h('i', { class: 'm2' }), h('i', { class: 'm3' })),
  h('span', null, h('b', null, 'Vivid look'), h('small', null, 'Bright filled parts, thick wires, a colour per net (Turing Complete style)')));
  const boardItem = h('button', { role: 'menuitemcheckbox', class: 'pal-board', onclick: () => {
    settings.set('board', !settings.board);
    applyTheme();
  } }, h('span', { class: 'pal-board-sw' }, h('i')),
  h('span', null, h('b', null, 'Dark board'), h('small', null, 'Vivid look: the circuit on a dark board in the light theme too')));
  const cartoonItem = h('button', { role: 'menuitemcheckbox', class: 'pal-cartoon', onclick: () => {
    settings.set('cartoon', !settings.cartoon);
    applyTheme();
  } }, h('span', { class: 'pal-cartoon-sw' }, s('svg', { viewBox: '0 0 46 18', 'aria-hidden': 'true' },
    s('path', { class: 'sh', d: 'M15,3 H24 A7,7 0 0 1 24,17 H15 Z' }), s('path', { class: 'bd', d: 'M13,1.5 H22 A7,7 0 0 1 22,15.5 H13 Z' }), s('path', { class: 'gl', d: 'M15.5,4.5 H21' }))),
  h('span', null, h('b', null, 'Cartoon parts'), h('small', null, 'Vivid look: chunky parts with shadows, gloss and small icons')));
  // Working gates: each gate drawn as what works inside it (view/cmosdraw.ts); needs cartoon parts.
  const gatesItem = h('button', { role: 'menuitemcheckbox', class: 'pal-gates', onclick: () => {
    settings.set('workingGates', !settings.workingGates);
    applyTheme();
  } }, h('span', { class: 'pal-gates-sw' }, s('svg', { viewBox: '0 0 46 18', 'aria-hidden': 'true' },
    s('path', { class: 'bd', d: 'M12,1.5 H22 A7.5,7.5 0 0 1 22,16.5 H12 Z' }), s('path', { class: 'rl', d: 'M16,4 H26' }), s('path', { class: 'ch', d: 'M18,5.5 V9.5 M24,5.5 V9.5' }), s('path', { class: 'ch off', d: 'M21,10.5 V14' }))),
  h('span', null, h('b', null, 'Working gates'), h('small', null, 'Cartoon parts: each gate shows its transistors, live, when zoomed in')));
  // Module colours: library boxes tinted by kind (view/symbols.ts CATEGORY_HUE).
  const modItem = h('button', { role: 'menuitemcheckbox', class: 'pal-mod', onclick: () => {
    settings.set('modules', !settings.modules);
    applyTheme();
  } }, h('span', { class: 'pal-sw pal-mods' }, h('i', { class: 'm0' }), h('i', { class: 'm1' }), h('i', { class: 'm2' }), h('i', { class: 'm3' })),
  h('span', null, h('b', null, 'Coloured modules'), h('small', null, 'Boxes tinted by kind: green arithmetic, amber memory, blue control')));
  // Flowing bits: on top of any palette, so a switch under the list rather than another palette.
  const flowItem = h('button', { role: 'menuitemcheckbox', class: 'pal-flow', onclick: () => {
    settings.set('wireFlow', !settings.wireFlow);
    applyTheme();
  } }, h('span', { class: 'pal-flow-sw' }, h('i')),
  h('span', null, h('b', null, 'Flowing bits'), h('small', null, '1s march along wires, buses carry their values')));
  // Colour per net: on top of any palette (colour = which net, brightness = its value).
  const netItem = h('button', { role: 'menuitemcheckbox', class: 'pal-nets', onclick: () => {
    settings.set('netColors', !settings.netColors);
    applyTheme();
  } }, h('span', { class: 'pal-nets-sw' }, h('i', { class: 'n0' }), h('i', { class: 'n1' }), h('i', { class: 'n2' })),
  h('span', null, h('b', null, 'Colour per net'), h('small', null, 'Each net in a hue of its own, to follow a path; bright = 1, dim = 0')));
  // Simple connections: how the sandbox draws new wires (Turing Complete style), not a colour, so a switch too.
  const simpleItem = h('button', { role: 'menuitemcheckbox', class: 'pal-simple', onclick: () => settings.set('simpleWires', !settings.simpleWires) },
    h('span', { class: 'pal-simple-sw' }, s('svg', { viewBox: '0 0 46 14', 'aria-hidden': 'true' },
      s('path', { class: 'sq', d: 'M2,12 H16 V2 H30 V12 H44' }), s('path', { class: 'st', d: 'M2,12 L16,2 L30,12 L44,2' }))),
    h('span', null, h('b', null, 'Simple connections'), h('small', null, 'Sandbox: new wires run straight between the points you click, at any angle')));
  // Hover definitions in the chapters (campaign/glossary.ts).
  const glossItem = h('button', { role: 'menuitemcheckbox', class: 'pal-flow', onclick: () => settings.set('glossary', !settings.glossary) },
    h('span', { class: 'pal-flow-sw' }, h('i')),
    h('span', null, h('b', null, 'Hover definitions'), h('small', null, 'Chapters: codex terms underlined, their summary on hover (from the next step on)')));
  // Automatic clock: chapter scenes, sandbox chips and campaign levels with a clock start running when opened.
  const clockItem = h('button', { role: 'menuitemcheckbox', class: 'pal-flow', onclick: () => settings.set('autoClock', !settings.autoClock) },
    h('span', { class: 'pal-flow-sw' }, h('i')),
    h('span', null, h('b', null, 'Automatic clock'), h('small', null, 'A circuit with a clock starts running (2 Hz) when opened; Pulse, Step or Back pauses it')));
  // Load-dependent delay: which side the Timing panels and the inspector open on (sim/delay.ts).
  const delayItem = h('button', { role: 'menuitemcheckbox', class: 'pal-flow', onclick: () => settings.set('loadDelay', !settings.loadDelay) },
    h('span', { class: 'pal-flow-sw' }, h('i')),
    h('span', null, h('b', null, 'Load-dependent delay'), h('small', null, 'Timing panels and the inspector open on each NAND timed by what it drives; the chapters quote unit delay')));
  // Reading: prose size in the chapter pane (never the circuits) and a held line length.
  const sizeStep = (d: number) => {
    const i = Math.max(0, Math.min(TEXT_SIZES.length - 1, TEXT_SIZES.indexOf(settings.textSize as 100) + d));
    settings.set('textSize', TEXT_SIZES[i]);
    applyTheme();
  };
  const sizeVal = h('span', { class: 'pal-size-v', 'aria-live': 'polite' });
  const sizeMinus = h('button', { class: 'btn sm', title: 'Smaller text', 'aria-label': 'Smaller text', onclick: () => sizeStep(-1) }, 'A−');
  const sizePlus = h('button', { class: 'btn sm', title: 'Larger text', 'aria-label': 'Larger text', onclick: () => sizeStep(1) }, 'A+');
  const sizeRow = h('div', { class: 'pal-size', role: 'group', 'aria-label': 'Text size' },
    h('span', null, h('b', null, 'Text size'), h('small', null, 'Chapter prose only; circuits keep their size')), sizeMinus, sizeVal, sizePlus);
  const narrowItem = h('button', { role: 'menuitemcheckbox', class: 'pal-flow', onclick: () => { settings.set('narrowText', !settings.narrowText); applyTheme(); } },
    h('span', { class: 'pal-flow-sw' }, h('i')),
    h('span', null, h('b', null, 'Narrow reading column'), h('small', null, 'Chapter text held to about 62 characters a line')));
  // Thickness and grid: a word each, one row (the same shape as Text size).
  const choiceRow = <T extends string>(label: string, of: () => T, set: (v: T) => void, opts: [T, string][]) => {
    const btns = opts.map(([v, t]) => h('button', { class: 'btn sm toggle', 'data-v': v, onclick: () => { set(v); applyTheme(); } }, t));
    const sync = () => { for (const b of btns) { const on = b.dataset.v === of(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); } };
    return { row: h('div', { class: 'pal-choice', role: 'group', 'aria-label': label }, h('span', null, h('b', null, label)), btns), sync };
  };
  const wiresRow = choiceRow<WireScale>('Wire thickness', () => settings.wireScale, (v) => settings.set('wireScale', v), [['thin', 'Thin'], ['normal', 'Normal'], ['thick', 'Thick']]);
  const gridRow = choiceRow<GridStyle>('Grid', () => settings.grid, (v) => settings.set('grid', v), [['dots', 'Dots'], ['lines', 'Lines'], ['off', 'None']]);
  // Less motion: flowing bits, pulses and smooth scrolling, with or without the system's setting (which then holds it on).
  const motionWhy = h('small', null);
  const motionItem = h('button', { role: 'menuitemcheckbox', class: 'pal-flow', onclick: () => { settings.set('reduceMotion', !settings.reduceMotion); applyTheme(); } },
    h('span', { class: 'pal-flow-sw' }, h('i')),
    h('span', null, h('b', null, 'Reduce motion'), motionWhy));
  // Text on the schematics: fewer words on a dense level; names come back under the pointer.
  const labelItem = (key: 'portNames' | 'partNames' | 'busValues' | 'tapRanges' | 'hideSmall', title: string, about: string) =>
    h('button', { role: 'menuitemcheckbox', class: 'pal-flow', 'data-label': key, onclick: () => { settings.set(key, !settings[key]); applyTheme(); } },
      h('span', { class: 'pal-flow-sw' }, h('i')),
      h('span', null, h('b', null, title), h('small', null, about)));
  const labelItems = [
    labelItem('portNames', 'Port names', 'The names inside a part; off, shown when you point at it'),
    labelItem('partNames', 'Part names', 'Block and instance names; off, pointing at a part shows them once it is large enough to read'),
    labelItem('busValues', 'Bus values', 'Live values on the buses, standing or riding along'),
    labelItem('tapRanges', 'Bit ranges', 'Where a bus is tapped ([7:0]); off, shown on a net you point at or select'),
    labelItem('hideSmall', 'Hide unreadable text', 'Zoomed out, text under 7 px on screen is left out; off, every label stays however small'),
  ];
  // Zoomed out, a block's name is drawn at a fixed size over it (view/legible.ts): how large, or not at all.
  const namesRow = choiceRow<ZoomNames>('Names when zoomed out', () => settings.zoomNames, (v) => settings.set('zoomNames', v), [['off', 'Off'], ['normal', 'Normal'], ['large', 'Large']]);
  // Both live elsewhere too: M and the minimap's own button, the switch on the key sheet.
  const minimapItem = h('button', { role: 'menuitemcheckbox', class: 'pal-flow', onclick: () => settings.set('minimap', !settings.minimap) },
    h('span', { class: 'pal-flow-sw' }, h('i')),
    h('span', null, h('b', null, 'Minimap'), h('small', null, 'Sandbox: a map at the canvas corner while part of the chip is out of view (M)')));
  const singleItem = h('button', { role: 'menuitemcheckbox', class: 'pal-flow', onclick: () => settings.set('singleKeys', !settings.singleKeys) },
    h('span', { class: 'pal-flow-sw' }, h('i')),
    h('span', null, h('b', null, 'Single-key shortcuts'), h('small', null, 'F, /, [, ? and the like; off, only Ctrl / ⌘ combinations and Esc')));
  // Reset: every option here, behaviour included, never progress or the theme.
  const resetItem = h('button', { class: 'pal-reset', onclick: () => {
    remember();
    settings.resetView();
    applyTheme();
    syncTools();
    undoItem.focus();
  } }, 'Reset view options to defaults');
  palMenu.append(palHead('Reading'), sizeRow, narrowItem, glossItem, palHead('Look'), vividItem, boardItem, cartoonItem, gatesItem, modItem, netItem, flowItem, wiresRow.row, gridRow.row, motionItem, palHead('Labels'), ...labelItems, namesRow.row, palHead('Behaviour'), simpleItem, clockItem, delayItem, minimapItem, singleItem, resetItem);
  const palBtn = h('button', { class: 'btn ghost icon-only pal-btn', title: 'View options: presets, text size, wire colours and thickness, the look of parts, grid, motion, labels, and how the circuits behave', 'aria-label': 'View options (colours and look)', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, swatch());
  const palOpen = (on: boolean) => {
    palMenu.classList.toggle('open', on);
    palBtn.setAttribute('aria-expanded', String(on));
    if (on) void import('./viewpreview').then((m) => { if (palMenu.classList.contains('open')) m.showPreview(previewHost); }).catch(() => { /* offline: the menu works without it */ });
    else {
      void import('./viewpreview').then((m) => { if (!palMenu.classList.contains('open')) m.hidePreview(); }).catch(() => {});
      if (undoView) { undoView = null; syncTools(); }
    }
  };
  palBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    palOpen(!palMenu.classList.contains('open'));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!palMenu.contains(e.target as Node) && !palBtn.contains(e.target as Node)) palOpen(false);
  });
  const palWrap = h('div', { class: 'pal-wrap' }, palBtn, palMenu);
  menuKeys(palWrap, palMenu, palBtn, () => palOpen(false));
  // Tab past the last option (or back before the first) leaves the menu: it closes, rather than staying open behind the focus
  palMenu.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...palMenu.querySelectorAll<HTMLElement>('button, [role^=menuitem], input, select')].filter((x) => x.offsetParent);
    const i = items.indexOf(document.activeElement as HTMLElement);
    // the focus moves on first (the browser's own Tab), then the menu closes behind it
    if ((!e.shiftKey && i === items.length - 1) || (e.shiftKey && i === 0)) setTimeout(() => palOpen(false), 0);
  });

  const syncTools = () => {
    for (const b of palMenu.querySelectorAll<HTMLButtonElement>('button[data-p]')) b.setAttribute('aria-checked', String(b.dataset.p === settings.palette));
    vividItem.setAttribute('aria-checked', String(settings.vivid));
    boardItem.setAttribute('aria-checked', String(settings.board));
    boardItem.disabled = !settings.vivid;
    cartoonItem.setAttribute('aria-checked', String(settings.cartoon));
    cartoonItem.disabled = !settings.vivid;
    gatesItem.setAttribute('aria-checked', String(settings.workingGates));
    gatesItem.disabled = !settings.vivid || !settings.cartoon;
    modItem.setAttribute('aria-checked', String(settings.modules));
    flowItem.setAttribute('aria-checked', String(settings.wireFlow));
    netItem.setAttribute('aria-checked', String(settings.netColors));
    simpleItem.setAttribute('aria-checked', String(settings.simpleWires));
    glossItem.setAttribute('aria-checked', String(settings.glossary));
    clockItem.setAttribute('aria-checked', String(settings.autoClock));
    delayItem.setAttribute('aria-checked', String(settings.loadDelay));
    narrowItem.setAttribute('aria-checked', String(settings.narrowText));
    for (const b of labelItems) b.setAttribute('aria-checked', String(settings[b.dataset.label as 'portNames']));
    wiresRow.sync();
    gridRow.sync();
    namesRow.sync();
    const sysMotion = systemReducedMotion();
    motionItem.setAttribute('aria-checked', String(sysMotion || settings.reduceMotion));
    motionItem.disabled = sysMotion;
    motionWhy.textContent = sysMotion ? 'On: your system asks for it' : 'No flowing bits, pulses or smooth scrolling; Slow motion still plays when you ask';
    minimapItem.setAttribute('aria-checked', String(settings.minimap));
    singleItem.setAttribute('aria-checked', String(settings.singleKeys));
    const preset = settings.preset();
    for (const b of presetBtns) { const on = b.dataset.preset === preset; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    undoItem.hidden = !undoView;
    sizeVal.textContent = `${settings.textSize}%`;
    sizeMinus.disabled = settings.textSize <= TEXT_SIZES[0];
    sizePlus.disabled = settings.textSize >= TEXT_SIZES[TEXT_SIZES.length - 1];
    for (const b of radix.querySelectorAll<HTMLButtonElement>('button')) {
      const on = b.dataset.r === settings.radix;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    animate.classList.toggle('on', settings.animate);
    animate.setAttribute('aria-pressed', String(settings.animate));
    themeBtn.replaceChildren(icon(settings.theme === 'light' ? 'sun' : settings.theme === 'dark' ? 'moon' : 'auto', 18));
    themeBtn.title = `Theme: ${settings.theme} (click to change)`;
  };
  settings.onChange(syncTools);
  syncTools();

  // The way back after a jump into another section (returnto.ts): installed before the router's hashchange listener.
  const ret = installReturn(view);
  const topbar = h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/', 'aria-label': 'From Switch to CPU: home' }, h('span', { class: 'brand-mark' }, icon('chip', 18)), h('span', { class: 'brand-name' }, h('span', { class: 'brand-long' }, 'From '), 'Switch to CPU'), h('small', null, 'a RISC-V processor and beyond')),
    nav, ret.el, h('div', { class: 'spacer' }), h('div', { class: 'tools' }, searchBtn, radix, animate, palWrap, themeBtn));
  view.tabIndex = -1;
  // replaces index.html's loading shell in one step (same classes, same bar height)
  root.replaceChildren(skip, topbar, view);
  installNavFit(topbar, nav);

  let page: Page | null = null;
  // A route that loads its page asynchronously must not mount it if another route came since.
  let routeSeq = 0;
  // A lazy route with nothing on screen yet (the first load): a placeholder rather than an empty page.
  // With a page already shown it stays until the new one is ready, and a thin bar on the top edge says something is coming (styles/app.css).
  const busy = (on: boolean) => document.documentElement.toggleAttribute('data-busy', on);
  const pending = () => { busy(true); if (!page) view.replaceChildren(loadingPanel()); };
  const route = () => {
    const seq = ++routeSeq;
    busy(false);
    ret.route(page as ReturnLabelled | null);
    // A chapter's or the workbench's address may end in a view suffix (?i=…&p=…&n=…, viewlink.ts): taken off here and handed to the
    // stage that builds the scene, so the rest of the routing sees the plain address it always did.
    const { route: base, query } = splitView(location.hash);
    const onStage = /^#\/?(c|workbench)\//.test(base);
    setPendingView(onStage ? decodeView(query) : null);
    const parts = (onStage ? base : location.hash).replace(/^#\/?/, '').split('/').filter(Boolean);
    const key = parts[0] ?? 'home';
    setPageTitle(...routeTitle(parts, key === 'c' ? outlineOf(parts[1] ?? outline[0].id) : undefined));
    for (const a of nav.querySelectorAll<HTMLAnchorElement>('a')) a.classList.toggle('active', a.dataset.key === key || (key === '' && a.dataset.key === 'home'));
    const shows = stageTools(parts);
    radix.hidden = !shows.radix;
    animate.hidden = !shows.slow;
    if (key === 'c' && parts[1] && !outlineOf(parts[1])) {
      // a stale or mistyped link: say so rather than quietly showing another chapter under the wrong address
      const bad = parts[1];
      radix.hidden = animate.hidden = true; // no circuit on an error card
      mount({ el: notFound('No such chapter', `There is no chapter called "${bad}". It may have been renamed or removed.`,
        [['Open the chapter list', '#/c/map/0'], ['Start at the first chapter', `#/c/${outline[0].id}/0`]]), destroy() {} });
    } else if (key === 'c' && parts[2] === 'print') {
      // Print this chapter (#/c/<id>/print[/<step it was asked from>]): a page of its own, loaded with the chapter
      radix.hidden = animate.hidden = true;
      const ch = outlineOf(parts[1] ?? '')!;
      pending();
      Promise.all([import('./pages/print'), loadChapter(ch.id)]).then(([m, chapter]) => {
        if (seq === routeSeq) mount(new m.PrintPage(chapter, Number(parts[3]) || 0));
      }, (e) => {
        if (seq === routeSeq) { busy(false); view.replaceChildren(loadFailed('the print view', e)); }
      });
    } else if (key === 'c') {
      const ch = outlineOf(parts[1] ?? '') ?? outline[0];
      const step = Number(parts[2] ?? 0) || 0;
      // an address kept from before a step moved to another chapter
      const moved = movedAddress(ch.id, step, ch.steps.length - (ch.recap ? 0 : 1));
      if (moved) { location.replace(`#/c/${moved.chapter}/${moved.step}`); return; }
      // after the step, the part opened on its stage (ui/drillpath.ts)
      const path = parseDrill(parts.slice(3));
      const cp = page as ChapterPage | null;
      if (cp?.kind === 'chapter' && cp.chapter.id === ch.id) {
        cp.route(step, path);
        applyPendingView();
        return;
      }
      // The chapter page and this chapter's module (steps, scenes, the library parts only it uses) are chunks of their own.
      pending();
      Promise.all([import('./pages/chapter'), loadChapter(ch.id)]).then(([m, chapter]) => {
        if (seq === routeSeq) mount(new m.ChapterPage(chapter, step, path));
      }, (e) => {
        if (seq === routeSeq) { busy(false); view.replaceChildren(loadFailed('chapter', e)); }
      });
    } else if (key === 'workbench' && parts[1] === 'stats') {
      // The Statistics tab: a chunk of its own (its rows come from hwstats.json).
      if ((page as { kind?: string } | null)?.kind === 'hwstats') return;
      import('./pages/hwstats').then((m) => {
        if (seq === routeSeq) mount(new m.HwStatsPage());
      }, (e) => {
        if (seq === routeSeq) view.replaceChildren(loadFailed('statistics', e));
      });
    } else if (key === 'workbench' && parts[1] === 'bench') {
      // The Benchmarks tab: a chunk of its own (with the saved results).
      if ((page as { kind?: string } | null)?.kind === 'benchmarks') return;
      import('./pages/benchmarks').then((m) => {
        if (seq === routeSeq) mount(new m.BenchmarksPage());
      }, (e) => {
        if (seq === routeSeq) view.replaceChildren(loadFailed('benchmarks', e));
      });
    } else if (key === 'workbench' && parts[1] === 'lab') {
      // The out-of-order lab: a chunk of its own (the model and its widget).
      if ((page as { kind?: string } | null)?.kind === 'ooolab') return;
      import('./pages/ooolab').then((m) => {
        if (seq === routeSeq) mount(new m.OooLabPage());
      }, (e) => {
        if (seq === routeSeq) view.replaceChildren(loadFailed('the out-of-order lab', e));
      });
    } else if (key === 'workbench') {
      const path = parseDrill(parts.slice(2));
      const wb = page as WorkbenchPage | null;
      if (wb?.kind === 'workbench') {
        wb.route(parts[1] ?? 'rca4', path);
        applyPendingView();
        return;
      }
      // The workbench is a chunk of its own (it needs the component library).
      pending();
      import('./pages/workbench').then((m) => {
        if (seq === routeSeq) mount(new m.WorkbenchPage(parts[1] ?? 'rca4', path));
      }, (e) => {
        if (seq === routeSeq) { busy(false); view.replaceChildren(loadFailed('workbench', e)); }
      });
    } else if (key === 'path' || key === 'start') {
      // My path and Where are you starting?: a chunk of their own (the skill map reads the codex and the campaign).
      if ((page as { kind?: string } | null)?.kind === key) return;
      (key === 'path' ? import('./pages/path').then((m) => new m.PathPage()) : import('./pages/start').then((m) => new m.StartPage())).then((p) => {
        if (seq === routeSeq) mount(p);
      }, (e) => {
        if (seq === routeSeq) view.replaceChildren(loadFailed(key === 'path' ? 'My path' : 'Where are you starting?', e));
      });
    } else if (key === 'notes') {
      if ((page as { kind?: string } | null)?.kind === 'notes') return;
      import('./pages/notes').then((m) => {
        if (seq === routeSeq) mount(new m.NotesPage());
      }, (e) => {
        if (seq === routeSeq) view.replaceChildren(loadFailed('My notes', e));
      });
    } else if (key === 'campaign' && parts[1] === 'play') {
      // A level on its own screen: the editor's chunk, like the sandbox.
      const lv = page as (Page & { kind?: string; nodeId?: string }) | null;
      if ((lv?.kind === 'level' || lv?.kind === 'capstone' || lv?.kind === 'verilog') && lv.nodeId === parts[2]) return;
      // A tier capstone (learn/capstones.ts) has the level screen's layout and a page of its own
      // The communication capstones made of choices have a page of their own, without the editor
      if (parts[2] === 'cap_fault' || parts[2] === 'cap_link') {
        import('./pages/commcap').then((m) => {
          if (seq === routeSeq) mount(new m.CommCapstonePage(parts[2]));
        }, (e) => {
          if (seq === routeSeq) view.replaceChildren(loadFailed('capstone', e));
        });
        return;
      }
      if (parts[2] === 'cap_echo') {
        import('./pages/dspcap').then((m) => {
          if (seq === routeSeq) mount(new m.DspCapstonePage(parts[2]));
        }, (e) => {
          if (seq === routeSeq) view.replaceChildren(loadFailed('capstone', e));
        });
        return;
      }
      if (parts[2] === 'cap_tune') {
        import('./pages/tunecap').then((m) => {
          if (seq === routeSeq) mount(new m.TuneCapstonePage(parts[2]));
        }, (e) => {
          if (seq === routeSeq) view.replaceChildren(loadFailed('capstone', e));
        });
        return;
      }
      if (parts[2]?.startsWith('cap_')) {
        import('./pages/capstone').then((m) => {
          if (seq === routeSeq) mount(new m.CapstonePage(parts[2]));
        }, (e) => {
          if (seq === routeSeq) view.replaceChildren(loadFailed('capstone', e));
        });
        return;
      }
      // A Verilog twin of a build level (campaign/twinids.ts): the same layout, the source beside the check
      if (isTwinKey(parts[2] ?? '')) {
        import('./pages/verilog').then((m) => {
          if (seq === routeSeq) mount(new m.VerilogPage(parts[2]));
        }, (e) => {
          if (seq === routeSeq) view.replaceChildren(loadFailed('Verilog challenge', e));
        });
        return;
      }
      import('./pages/level').then((m) => {
        if (seq === routeSeq) mount(new m.LevelPage(parts[2] ?? ''));
      }, (e) => {
        if (seq === routeSeq) view.replaceChildren(loadFailed('level', e));
      });
    } else if (key === 'campaign') {
      const cp = page as (Page & { kind?: string; open?(parts: string[]): void }) | null;
      if (cp?.kind === 'campaign') {
        cp.open?.(parts.slice(1));
        return;
      }
      // A chunk of its own, like the sandbox.
      import('./pages/campaign').then((m) => {
        if (seq === routeSeq) mount(new m.CampaignPage(parts.slice(1)));
      }, (e) => {
        if (seq === routeSeq) view.replaceChildren(loadFailed('campaign', e));
      });
    } else if (key === 'sandbox') {
      const sb = page as (Page & { kind?: string; open?(id?: string): void }) | null;
      if (sb?.kind === 'sandbox') {
        sb.open?.(parts[1]);
        return;
      }
      // The editor is a separate chunk: most visitors never open it.
      import('./pages/sandbox').then((m) => {
        if (seq === routeSeq) mount(new m.SandboxPage(parts[1]));
      }, (e) => {
        if (seq === routeSeq) view.replaceChildren(loadFailed('sandbox', e));
      });
    } else if (key !== 'home' && parts.length) {
      // a mistyped or stale address: say so rather than quietly showing the home page under it
      radix.hidden = animate.hidden = true;
      mount({ el: notFound('Nothing at this address', `There is no page called "${parts.join('/')}".`, [['Go to the home page', '#/'], ['Open the chapter list', '#/c/map/0']]), destroy() {} });
    } else {
      mount(homePage());
    }
  };
  const mount = (p: Page) => {
    busy(false);
    page?.destroy();
    page = p;
    // a page with no circuit (an error card on a route that has them) hides the circuit tools
    if ((p as { noTools?: boolean }).noTools) radix.hidden = animate.hidden = true;
    view.replaceChildren(p.el);
  };
  window.addEventListener('hashchange', route);
  route();
}

/** What the page area shows while a route's chunks load with nothing on screen yet (the same markup as index.html's shell). */
function loadingPanel(): HTMLElement {
  return h('div', { class: 'route-loading', role: 'status', 'aria-label': 'Loading' },
    h('div', { class: 'rl-line rl-title' }), h('div', { class: 'rl-line' }), h('div', { class: 'rl-line' }), h('div', { class: 'rl-line rl-short' }));
}
