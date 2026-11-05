// The right-click menu's wire and part rows, shared by the stage and look inside (view/schematic.ts) and the sandbox
// (editor/ctxmenu.ts): the header with a wire's live value, and Trace, Measure and Explain as far as a surface has them.

import { h } from '../ui/dom';
import { closeMenu, type MenuEntry } from '../ui/menu';
import { copyText } from '../ui/viewlink';
import { groupDigits } from '../sim/numfmt';
import { readersOf } from '../sim/netcap';
import type { FlatDesign } from '../sim/flatten';
import { stats } from '../sim/stats';
import type { Bit, ComponentDef } from '../sim/types';
import { crossings, fanText, type NetEnd, type NetFacts, valueRows } from './netfacts';

/** How often the header reads the value while the clock runs (D5: live, at most ten times a second). */
const LIVE_MS = 100;

/** A value row: a click copies what it holds. Marked so the menu does not start its focus here. */
function valueButton(): { el: HTMLElement; set(k: string, text: string, copy: string, unknown: boolean, hidden?: boolean): void } {
  const key = h('i', null), num = h('span', { class: 'ctx-num' }), mark = h('span', { class: 'ctx-copy' }, 'copy');
  let copy = '', k = '';
  const el = h('button', { class: 'ctx-val', role: 'menuitem', onclick: () => {
    void copyText(copy).then((done) => {
      mark.textContent = done ? 'copied' : 'no clipboard';
      setTimeout(() => closeMenu(), 450);
    });
  } }, key, num, mark);
  return { el, set: (kk, text, c, unknown, hidden) => {
    el.hidden = !!hidden;
    if (kk !== k) key.textContent = k = kk;
    if (num.textContent !== text) num.textContent = text;
    num.classList.toggle('unknown', unknown);
    copy = c;
    el.setAttribute('aria-label', `Copy ${kk}: ${text}`);
  } };
}

/** The header of a wire's menu: name, width, driver, and the value, kept live while the menu is open. */
export function wireHeader(into: HTMLElement, f: NetFacts, bits: () => readonly Bit[], note?: () => string): void {
  const now = bits();
  const w = now.length;
  const drv = f.drivers.length === 1 ? `driven by ${f.drivers[0].label}` : f.drivers.length ? `${f.drivers.length} drivers` : f.both.length ? 'two-way' : 'no driver';
  const sub = h('span', null, `${w === 1 ? '1 bit' : `${w} bits`} · ${drv}`);
  const name = w > 1 && !/\[/.test(f.name) ? `${f.name}[${w - 1}:0]` : f.name;
  into.append(h('div', { class: 'ctx-head' }, h('b', null, name), sub));
  const rows = valueRows(now).map((r) => {
    const b = valueButton();
    b.set(r.k, r.text, r.copy, r.unknown, r.hidden);
    into.append(b.el);
    return b;
  });
  const extra = note ? h('p', { class: 'ctx-note' }, note()) : null;
  if (extra && !extra.textContent) extra.hidden = true;
  if (extra) into.append(extra);
  into.append(h('hr'));
  if (!rows.length) return;
  const t = setInterval(() => {
    if (!into.isConnected) return void clearInterval(t);
    valueRows(bits()).forEach((r, i) => rows[i]?.set(r.k, r.text, r.copy, r.unknown, r.hidden));
    if (extra && note) {
      const s = note();
      if (s !== extra.textContent) extra.textContent = s;
      extra.hidden = !s;
    }
  }, LIVE_MS);
}

/** The header of a part's menu: its name, its kind, what it costs. */
export function partHeader(into: HTMLElement, name: string, def: ComponentDef): void {
  const st = stats(def);
  const cost = st.nands ? `${groupDigits(st.nands)} NAND${st.nands === 1 ? '' : 's'} · ${groupDigits(st.transistors)} transistors`
    : st.transistors ? `${groupDigits(st.transistors)} transistor${st.transistors === 1 ? '' : 's'}` : '';
  into.append(h('div', { class: 'ctx-head' }, h('b', null, name), h('span', null, [def.name, cost].filter(Boolean).join(' · '))), h('hr'));
}

export interface TraceHost {
  /** Light the net: every wire, label and tag of it. */
  highlight(): void;
  jump(e: NetEnd): void;
  /** Is this end up a level (a port of a level that is not the top)? The row says so. */
  upLevel?(e: NetEnd): boolean;
  /** The Why? card on this wire (absent: `whyOff` says why not). */
  why?(): void;
  whyOff?: string;
  design(): FlatDesign | null;
  /** The net's flat nets in that design. */
  flat(): readonly number[];
  transistors: boolean;
}

/** Trace's rows, then the groups: the same order on every surface. */
export function wireRows(f: NetFacts, host: TraceHost): MenuEntry[] {
  const go = (verb: string, e: NetEnd): NonNullable<MenuEntry> => ({ label: `${verb}: ${e.label}`, ...(host.upLevel?.(e) ? { hint: 'A port of this level: goes up one level' } : {}), run: () => host.jump(e) });
  const list = (verb: string, group: string, ends: NetEnd[], none: string): NonNullable<MenuEntry> => {
    if (ends.length === 1) return go(verb, ends[0]);
    if (!ends.length) return { label: verb, why: none };
    return { label: group, sub: ends.map((e) => ({ label: e.label, ...(host.upLevel?.(e) ? { hint: 'Goes up one level' } : {}), run: () => host.jump(e) })) };
  };
  const on = crossings(f);
  const out: MenuEntry[] = [
    { label: 'Highlight the whole net', ...(on.length ? { hint: `Continues into ${on.slice(0, 3).join(', ')}${on.length > 3 ? ` and ${on.length - 3} more` : ''}` } : {}), run: () => host.highlight() },
  ];
  // Switch level: a source or drain is neither until the solver says, so they are listed as connections.
  if (f.drivers.length || !f.both.length) out.push(list('Jump to the driver', 'Jump to a driver', f.drivers, 'Nothing at this level drives this net.'));
  if (f.both.length) out.push(list('Jump to the connection', 'Jump to a connection', [...f.both, ...f.sinks], ''));
  else out.push(list('Jump to the sink', 'Jump to a sink', f.sinks, 'Nothing at this level reads this net.'));
  out.push(null,
    { label: 'Measure', sub: () => {
      const d = host.design();
      if (!d) return [{ label: 'Fan-out', why: 'Not in the simulation yet: wire it in first.' }];
      const readers = readersOf(d);
      let n = 0;
      for (const net of host.flat()) n += readers[net] ?? 0;
      return [{ label: `Fan-out: ${fanText(f, n, host.transistors)}`, hint: 'What this wire has to drive' }];
    } },
    { label: 'Explain', sub: [host.why ? { label: 'Why this value?', key: 'W', run: () => host.why!() } : { label: 'Why this value?', why: host.whyOff ?? 'Not available here.' }] });
  return out;
}
