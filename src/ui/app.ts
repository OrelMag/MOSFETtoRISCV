// App shell: top bar, theme, global settings and hash routing.

import { chapterById, chapters } from '../chapters';
import { h, icon } from './dom';
import { ChapterPage, type Page } from './pages/chapter';
import { homePage } from './pages/home';
import { WorkbenchPage } from './pages/workbench';
import { applyTheme, settings, type Theme } from './settings';
import type { Radix } from '../sim/values';

export function startApp(root: HTMLElement): void {
  applyTheme();
  const view = h('main', { id: 'view' });
  const nav = h('nav', { class: 'nav' });
  const navLink = (href: string, ic: string, label: string, key: string) =>
    h('a', { href, 'data-key': key }, icon(ic, 16), h('span', null, label));
  nav.append(navLink('#/', 'layers', 'Journey', 'home'), navLink('#/c/map/0', 'book', 'Chapters', 'c'), navLink('#/workbench/rca4', 'bench', 'Workbench', 'workbench'));

  const radix = h('div', { class: 'seg', title: 'How buses show their value' });
  const radixes: [Radix, string][] = [['hex', 'HEX'], ['bin', 'BIN'], ['dec', 'DEC']];
  for (const [r, label] of radixes) radix.append(h('button', { 'data-r': r, onclick: () => settings.set('radix', r) }, label));

  const animate = h('button', { class: 'btn sm toggle', title: 'Animate signal propagation one gate delay at a time' }, icon('play', 14), h('span', { class: 'lbl' }, 'Slow motion'));
  animate.addEventListener('click', () => settings.set('animate', !settings.animate));

  const themeBtn = h('button', { class: 'btn ghost icon-only', 'aria-label': 'Theme' });
  const themes: Theme[] = ['auto', 'light', 'dark'];
  themeBtn.addEventListener('click', () => {
    settings.set('theme', themes[(themes.indexOf(settings.theme) + 1) % themes.length]);
    applyTheme();
  });

  const syncTools = () => {
    for (const b of radix.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.r === settings.radix);
    animate.classList.toggle('on', settings.animate);
    themeBtn.replaceChildren(icon(settings.theme === 'light' ? 'sun' : settings.theme === 'dark' ? 'moon' : 'auto', 18));
    themeBtn.title = `Theme: ${settings.theme} (click to change)`;
  };
  settings.onChange(syncTools);
  syncTools();

  const topbar = h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, icon('chip', 18)), 'MOSFET → RISC-V', h('small', null, 'a journey through abstraction')),
    nav, h('div', { class: 'spacer' }), h('div', { class: 'tools' }, radix, animate, themeBtn));
  root.append(topbar, view);

  let page: Page | null = null;
  const route = () => {
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
