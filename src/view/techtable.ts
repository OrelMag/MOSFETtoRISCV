// The technology table: one design priced in CMOS, relays and tubes side by side (lib/tech.ts), for the inspector's
// info, a sandbox chip's properties and chapter 3. Each column follows from the design's counts and its worst path;
// the simulation is the same in all three. In a side panel the technologies stack, one small table each.

import { type Priced, RELAY_CONTACTS, TECH, TECHS, TECH_NOTE, type TechId, cabinets, fmtArea, fmtJoules, fmtMass, fmtRate, fmtTime, fmtVolume, fmtWatts, price } from '../lib/tech';
import { type DesignSteps, designSteps } from '../lib/techsteps';
import type { ComponentDef } from '../sim/types';
import { h } from '../ui/dom';

const thin = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, w: string) => `${thin(n)} ${w}${n === 1 ? '' : 's'}`;

export interface TechTableOptions {
  /** Steps on the worst path, if the caller knows them (else measured: depth, period or relay steps). */
  steps?: DesignSteps;
  /** What one operation is called in the energy row ("add", "instruction"); default "operation" or "cycle". */
  op?: string;
  /** Show the note on where the numbers come from (default true). */
  note?: boolean;
  /** One small table per technology, stacked (a side panel), instead of the technologies side by side. */
  narrow?: boolean;
  /** Another design for some technologies (a native relay adder against the NAND-mapped one), measured by itself, or
   *  with the steps given (a tube circuit drawn from the same NANDs: the switch-level solver has no tube time). */
  per?: Partial<Record<TechId, ComponentDef | { def: ComponentDef; steps: number | null }>>;
}

type Row = [label: string, f: (p: Priced, t: TechId) => Node | string | null, title?: string];

/** The table, or a sentence saying why the design has no technology to price (wiring, a primitive). */
export function techTable(def: ComponentDef, opts: TechTableOptions = {}): HTMLElement {
  const st = opts.steps ?? designSteps(def);
  const cols: Partial<Record<TechId, Priced>> = {};
  for (const t of TECHS) {
    const d = opts.per?.[t];
    const p = !d ? price(def, t, st.steps) : 'ports' in d ? price(d, t, designSteps(d).steps) : price(d.def, t, d.steps);
    if (p) cols[t] = p;
  }
  const techs = TECHS.filter((t) => cols[t]);
  if (!techs.length) return h('p', { class: 'tech-none' }, 'Nothing to price: no transistors, relays or tubes inside.');
  const op = opts.op ?? (st.clocked ? 'cycle' : 'operation');
  const c = (t: TechId) => cols[t]!;
  const cell = (t: TechId, f: Row[1]) => h('td', null, f(c(t), t) ?? h('span', { class: 'tech-na' }, '—'));
  const devices = (p: Priced, t: TechId): Node | string => {
    if (t === 'cmos') return plural(p.devices, 'transistor');
    if (t === 'relay') return h('span', null, plural(p.devices, 'relay'), p.fanout ? h('small', { title: `Nets read by more than ${RELAY_CONTACTS} contacts need another coil per ${RELAY_CONTACTS} more` }, ` (${thin(p.fanout)} for fan-out)`) : null);
    return h('span', { title: `${thin(p.triodes ?? 0)} triode and ${thin(p.diodes ?? 0)} diode sections` }, plural(p.devices, 'tube'),
      p.fanout ? h('small', { title: 'Cathode followers where a plate would drive too many dividers' }, ` (${thin(p.fanout)} followers)`) : null);
  };
  const stepWord = (t: TechId, n: number) => `${thin(n)} ${t === 'cmos' ? 'NAND delay' : TECH[t].stepName}${n === 1 ? '' : 's'}`;
  const rows: Row[] = [
    ['Built from', (p, t) => (p.native ? (t === 'cmos' ? 'transistors as drawn' : `${TECH[t].name.toLowerCase()} as drawn`) : `${TECH[t].brick} per NAND`)],
    ['Devices', devices],
    [st.clocked ? 'Clock period' : 'Worst path', (p, t) => (p.steps === null || p.time === null ? null
      : h('span', null, fmtTime(p.time), h('small', null, ` · ${stepWord(t, p.steps)}`)))],
    ...(st.clocked ? [['Clock rate', (p: Priced) => (p.time ? fmtRate(p.time) : null)] as Row] : []),
    ['Power', (p, t) => (t === 'cmos' ? h('span', { class: 'tech-na', title: 'Switching power is measured by simulation: see Power (estimate)' }, 'see Power') : p.power === null ? null : fmtWatts(p.power)),
      'Average: relay coils on half the time; tube heaters always'],
    [`Energy per ${op}`, (p) => (p.energy === null ? null : fmtJoules(p.energy))],
    ['Size', (p, t) => (t === 'cmos' ? (p.area === null ? null : `${fmtArea(p.area)} of silicon`) : p.volume === null ? null
      : h('span', null, fmtVolume(p.volume), cabinets(p) ? h('small', null, ` · ${plural(cabinets(p), t === 'relay' ? 'rack' : 'panel')}`) : null))],
    ['Mass', (p, t) => (t === 'cmos' ? '< 1 g' : p.mass === null ? null : fmtMass(p.mass))],
  ];
  const head = (t: TechId) => [TECH[t].name, c(t).native ? h('small', null, ' native') : null];
  const label = ([text, , title]: Row) => h('th', { scope: 'row', title: title ?? null }, text);
  const box = h('div', { class: `tech-box${opts.narrow ? ' narrow' : ''}` });
  if (opts.narrow) {
    for (const t of techs) {
      box.append(h('table', { class: 'tech-table' }, h('caption', null, ...head(t)),
        h('tbody', null, rows.map((r) => h('tr', null, label(r), cell(t, r[1]))))));
    }
  } else {
    box.append(h('div', { class: 'tech-scroll' }, h('table', { class: 'tech-table' },
      h('thead', null, h('tr', null, h('th', null), ...techs.map((t) => h('th', { scope: 'col' }, ...head(t))))),
      h('tbody', null, rows.map((r) => h('tr', null, label(r), ...techs.map((t) => cell(t, r[1]))))))));
  }
  if (opts.note !== false) {
    box.append(opts.narrow
      ? h('details', { class: 'tech-note' }, h('summary', null, 'Where the numbers come from'), TECH_NOTE)
      : h('p', { class: 'tech-note' }, TECH_NOTE));
  }
  return box;
}
