// One notice for an address that names nothing (a stale link, a typo): what was asked for, a way back, and a report link.
// Every route that can miss uses it, so the pages answer alike (app.ts, the campaign page, the level screen).

import { h } from './dom';
import { reportLink } from './errors';

/** [label, href] pairs; the first is the primary button. */
export type Way = [string, string];

export function notFound(title: string, text: string, ways: Way[]): HTMLElement {
  return h('div', { class: 'widget missing-chapter', role: 'status' }, h('div', { class: 'panel' },
    h('h3', null, title),
    h('p', { class: 'sub' }, text),
    h('div', { class: 'suggest' },
      ...ways.map(([label, href], i) => h('a', { class: `btn${i ? '' : ' primary'}`, href }, label)),
      reportLink(undefined, 'Report a problem', 'btn ghost'))));
}
