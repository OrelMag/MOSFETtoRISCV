// App shell: top bar, theme, global settings and hash routing.

import { chapterById, chapters } from '../chapters';
import { h, icon, s } from './dom';
import { installErrorReporting, loadFailed } from './errors';
import { ChapterPage, type Page } from './pages/chapter';
import { homePage } from './pages/home';
import { WorkbenchPage } from './pages/workbench';
import { focusStage, installQuickNav, openQuickNav, QUICK_KEY, toggleChapterMenu } from './quicknav';
import { applyTheme, PALETTES, settings, type Theme } from './settings';
import type { Radix } from '../sim/values';

/**
 * Which of the top bar's circuit settings a route uses: the bus radix wherever a circuit is drawn
 * (Stage: chapters and the workbench; the editor: sandbox and campaign levels), Slow motion only on
 * a Stage (the editor has its own gate-delay mode). Elsewhere they would do nothing.
 */
function stageTools(parts: string[]): { radix: boolean; slow: boolean } {
  const [key, sub] = parts;
  const stage = key === 'c' || (key === 'workbench' && sub !== 'stats' && sub !== 'bench');
  return { radix: stage || key === 'sandbox' || (key === 'campaign' && sub === 'play'), slow: stage };
}

export function startApp(root: HTMLElement): void {
  installErrorReporting();
  applyTheme();
  const view = h('main', { id: 'view' });
  const nav = h('nav', { class: 'nav' });
  const navLink = (href: string, ic: string, label: string, key: string) =>
    h('a', { href, 'data-key': key, title: label, 'aria-label': label }, icon(ic, 16), h('span', null, label));
  // "Chapters" opens the chapter menu rather than the first chapter (still a link: new tab works).
  const chLink = navLink('#/c/map/0', 'book', 'Chapters', 'c');
  chLink.append(icon('chevD', 14));
  chLink.setAttribute('aria-haspopup', 'menu');
  chLink.setAttribute('aria-expanded', 'false');
  chLink.title = `All chapters (${QUICK_KEY} to search)`;
  chLink.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    toggleChapterMenu(chLink);
  });
  nav.append(navLink('#/', 'layers', 'Journey', 'home'), chLink, navLink('#/campaign', 'flag', 'Campaign', 'campaign'),
    navLink('#/workbench/rca4', 'bench', 'Workbench', 'workbench'), navLink('#/sandbox', 'chip', 'Sandbox', 'sandbox'));
  installQuickNav();
  const searchBtn = h('button', { class: 'btn ghost icon-only', title: `Search chapters, components, levels, codex and actions (${QUICK_KEY}, /)`, 'aria-label': 'Search', 'aria-keyshortcuts': 'Control+K /', onclick: () => openQuickNav() }, icon('search', 18));
  // The first Tab stop: straight to the circuit where a page has one (S does the same), else to the page.
  const skip = h('button', { class: 'skip-link' }, 'Skip to the circuit');
  skip.addEventListener('focus', () => { skip.textContent = document.querySelector('#view section.stage') ? 'Skip to the circuit' : 'Skip to the content'; });
  skip.addEventListener('click', () => {
    if (!focusStage()) view.focus();
  });

  const radix = h('div', { class: 'seg', role: 'group', title: 'How buses show their value', 'aria-label': 'How buses show their value' });
  const radixes: [Radix, string, string][] = [['hex', 'HEX', 'hexadecimal'], ['bin', 'BIN', 'binary'], ['dec', 'DEC', 'decimal']];
  for (const [r, label, long] of radixes) radix.append(h('button', { 'data-r': r, title: `Bus values in ${long}`, onclick: () => settings.set('radix', r) }, label));

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
  const palMenu = h('div', { class: 'pal-menu', role: 'menu' });
  for (const p of PALETTES) {
    const item = h('button', { role: 'menuitemradio', 'data-p': p.id, onclick: () => {
      settings.set('palette', p.id);
      applyTheme();
      palOpen(false);
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
  palMenu.append(h('div', { class: 'pal-sep', role: 'separator' }), vividItem, boardItem, cartoonItem, modItem, flowItem, netItem, simpleItem, glossItem, clockItem);
  const palBtn = h('button', { class: 'btn ghost icon-only pal-btn', title: 'View options: wire and module colours, vivid look, cartoon parts, flowing bits, colour per net, simple connections, automatic clock', 'aria-label': 'View options (colours and look)', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, swatch());
  const palOpen = (on: boolean) => {
    palMenu.classList.toggle('open', on);
    palBtn.setAttribute('aria-expanded', String(on));
  };
  palBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    palOpen(!palMenu.classList.contains('open'));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!palMenu.contains(e.target as Node) && !palBtn.contains(e.target as Node)) palOpen(false);
  });
  const palWrap = h('div', { class: 'pal-wrap' }, palBtn, palMenu);

  const syncTools = () => {
    for (const b of palMenu.querySelectorAll<HTMLButtonElement>('button[data-p]')) b.setAttribute('aria-checked', String(b.dataset.p === settings.palette));
    vividItem.setAttribute('aria-checked', String(settings.vivid));
    boardItem.setAttribute('aria-checked', String(settings.board));
    boardItem.disabled = !settings.vivid;
    cartoonItem.setAttribute('aria-checked', String(settings.cartoon));
    cartoonItem.disabled = !settings.vivid;
    modItem.setAttribute('aria-checked', String(settings.modules));
    flowItem.setAttribute('aria-checked', String(settings.wireFlow));
    netItem.setAttribute('aria-checked', String(settings.netColors));
    simpleItem.setAttribute('aria-checked', String(settings.simpleWires));
    glossItem.setAttribute('aria-checked', String(settings.glossary));
    clockItem.setAttribute('aria-checked', String(settings.autoClock));
    for (const b of radix.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.r === settings.radix);
    animate.classList.toggle('on', settings.animate);
    animate.setAttribute('aria-pressed', String(settings.animate));
    themeBtn.replaceChildren(icon(settings.theme === 'light' ? 'sun' : settings.theme === 'dark' ? 'moon' : 'auto', 18));
    themeBtn.title = `Theme: ${settings.theme} (click to change)`;
  };
  settings.onChange(syncTools);
  syncTools();

  const topbar = h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/', 'aria-label': 'MOSFET → RISC-V: home' }, h('span', { class: 'brand-mark' }, icon('chip', 18)), h('span', { class: 'brand-name' }, 'MOSFET → RISC-V'), h('small', null, 'a journey through abstraction')),
    nav, h('div', { class: 'spacer' }), h('div', { class: 'tools' }, searchBtn, radix, animate, palWrap, themeBtn));
  view.tabIndex = -1;
  root.append(skip, topbar, view);

  let page: Page | null = null;
  // A route that loads its page asynchronously must not mount it if another route came since.
  let routeSeq = 0;
  const route = () => {
    const seq = ++routeSeq;
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const key = parts[0] ?? 'home';
    for (const a of nav.querySelectorAll<HTMLAnchorElement>('a')) a.classList.toggle('active', a.dataset.key === key || (key === '' && a.dataset.key === 'home'));
    const shows = stageTools(parts);
    radix.hidden = !shows.radix;
    animate.hidden = !shows.slow;
    if (key === 'c') {
      const ch = chapterById(parts[1] ?? '') ?? chapters[0];
      const step = Number(parts[2] ?? 0) || 0;
      if (page instanceof ChapterPage && page.chapter === ch) {
        page.goStep(step);
        return;
      }
      mount(new ChapterPage(ch, step));
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
    } else if (key === 'workbench') {
      if (page instanceof WorkbenchPage) {
        page.open(parts[1] ?? 'rca4');
        return;
      }
      mount(new WorkbenchPage(parts[1] ?? 'rca4'));
    } else if (key === 'campaign' && parts[1] === 'play') {
      // A level on its own screen: the editor's chunk, like the sandbox.
      const lv = page as (Page & { kind?: string; nodeId?: string }) | null;
      if (lv?.kind === 'level' && lv.nodeId === parts[2]) return;
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
    } else {
      mount(homePage());
    }
  };
  const mount = (p: Page) => {
    page?.destroy();
    page = p;
    view.replaceChildren(p.el);
  };
  window.addEventListener('hashchange', route);
  route();
}
