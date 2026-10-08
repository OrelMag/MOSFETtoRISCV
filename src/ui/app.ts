// App shell: top bar, theme, global settings and hash routing.

import { chapterById, chapters } from '../chapters';
import { h, icon, s } from './dom';
import { ChapterPage, type Page } from './pages/chapter';
import { homePage } from './pages/home';
import { WorkbenchPage } from './pages/workbench';
import { installQuickNav, openQuickNav, QUICK_KEY, toggleChapterMenu } from './quicknav';
import { applyTheme, PALETTES, settings, type Theme } from './settings';
import type { Radix } from '../sim/values';

export function startApp(root: HTMLElement): void {
  applyTheme();
  const view = h('main', { id: 'view' });
  const nav = h('nav', { class: 'nav' });
  const navLink = (href: string, ic: string, label: string, key: string) =>
    h('a', { href, 'data-key': key }, icon(ic, 16), h('span', null, label));
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
  const searchBtn = h('button', { class: 'btn ghost icon-only', title: `Jump to a chapter or step (${QUICK_KEY})`, 'aria-label': 'Jump to a chapter or step', onclick: () => openQuickNav() }, icon('search', 18));

  const radix = h('div', { class: 'seg', title: 'How buses show their value' });
  const radixes: [Radix, string][] = [['hex', 'HEX'], ['bin', 'BIN'], ['dec', 'DEC']];
  for (const [r, label] of radixes) radix.append(h('button', { 'data-r': r, onclick: () => settings.set('radix', r) }, label));

  const animate = h('button', { class: 'btn sm toggle', title: 'Slow motion: one gate delay at a time, each change travelling along its wires' }, icon('play', 14), h('span', { class: 'lbl' }, 'Slow motion'));
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
      palMenu.classList.remove('open');
    } }, h('span', { class: 'pal-sw', 'data-palette': p.id }, h('i', { class: 's0' }), h('i', { class: 's1' }), h('i', { class: 'sx' }), h('i', { class: 'sb' })),
    h('span', null, h('b', null, p.name), h('small', null, p.blurb)));
    palMenu.append(item);
  }
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
  palMenu.append(h('div', { class: 'pal-sep', role: 'separator' }), modItem, flowItem, netItem, simpleItem);
  const palBtn = h('button', { class: 'btn ghost icon-only pal-btn', title: 'Wire and module colours, flowing bits, colour per net, simple connections', 'aria-label': 'Wire and module colours, flowing bits, colour per net, simple connections', 'aria-haspopup': 'menu' }, swatch());
  palBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    palMenu.classList.toggle('open');
  });
  document.addEventListener('pointerdown', (e) => {
    if (!palMenu.contains(e.target as Node) && !palBtn.contains(e.target as Node)) palMenu.classList.remove('open');
  });
  const palWrap = h('div', { class: 'pal-wrap' }, palBtn, palMenu);

  const syncTools = () => {
    for (const b of palMenu.querySelectorAll<HTMLButtonElement>('button[data-p]')) b.setAttribute('aria-checked', String(b.dataset.p === settings.palette));
    modItem.setAttribute('aria-checked', String(settings.modules));
    flowItem.setAttribute('aria-checked', String(settings.wireFlow));
    netItem.setAttribute('aria-checked', String(settings.netColors));
    simpleItem.setAttribute('aria-checked', String(settings.simpleWires));
    for (const b of radix.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.r === settings.radix);
    animate.classList.toggle('on', settings.animate);
    themeBtn.replaceChildren(icon(settings.theme === 'light' ? 'sun' : settings.theme === 'dark' ? 'moon' : 'auto', 18));
    themeBtn.title = `Theme: ${settings.theme} (click to change)`;
  };
  settings.onChange(syncTools);
  syncTools();

  const topbar = h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, icon('chip', 18)), 'MOSFET → RISC-V', h('small', null, 'a journey through abstraction')),
    nav, h('div', { class: 'spacer' }), h('div', { class: 'tools' }, searchBtn, radix, animate, palWrap, themeBtn));
  root.append(topbar, view);

  let page: Page | null = null;
  // A route that loads its page asynchronously must not mount it if another route came since.
  let routeSeq = 0;
  const route = () => {
    const seq = ++routeSeq;
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const key = parts[0] ?? 'home';
    for (const a of nav.querySelectorAll<HTMLAnchorElement>('a')) a.classList.toggle('active', a.dataset.key === key || (key === '' && a.dataset.key === 'home'));
    if (key === 'c') {
      const ch = chapterById(parts[1] ?? '') ?? chapters[0];
      const step = Number(parts[2] ?? 0) || 0;
      if (page instanceof ChapterPage && page.chapter === ch) {
        page.goStep(step);
        return;
      }
      mount(new ChapterPage(ch, step));
    } else if (key === 'workbench') {
      if (page instanceof WorkbenchPage) {
        page.open(parts[1] ?? 'rca4');
        return;
      }
      mount(new WorkbenchPage(parts[1] ?? 'rca4'));
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
        if (seq === routeSeq) view.replaceChildren(h('div', { class: 'widget' }, h('div', { class: 'panel' }, h('h3', null, 'The campaign could not load'), h('p', { class: 'sub' }, String(e)))));
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
        if (seq === routeSeq) view.replaceChildren(h('div', { class: 'widget' }, h('div', { class: 'panel' }, h('h3', null, 'The sandbox could not load'), h('p', { class: 'sub' }, String(e)))));
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
