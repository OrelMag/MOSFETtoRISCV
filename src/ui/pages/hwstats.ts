// The workbench's Statistics tab (#/workbench/stats, its own chunk): every library component and
// the chapters' CPUs in one sortable table, measured from their netlists (lib/hwstats.ts). The
// build ships the rows as hwstats.json; without it (the dev server) they are computed here.

import { type HwRow, hwStatsLive } from '../../lib/hwstats';
import { RELAY_MASS, RELAY_VOLUME, TECH, TECH_NOTE, TUBE_MASS, TUBE_VOLUME, type TechId, fmtMass, fmtRate, fmtTime, fmtVolume, fmtWatts } from '../../lib/tech';
import { PS_NOTE, PS_PER_NAND } from '../../sim/timing';
import type { Category } from '../../sim/types';
import { CATEGORY_LABEL } from '../../view/inspector';
import { CATEGORY_HUE } from '../../view/symbols';
import { benchTabs } from '../benchtabs';
import { h } from '../dom';
import type { Page } from './chapter';

type Key = 'name' | 'cat' | 'transistors' | 'nands' | 'depth' | 'period' | 'levels' | 'parts' | 'devices' | 'watts' | 'mass';
interface Col { k: Key; label: string; sub?: string }
/** The columns in CMOS, and in relays or tubes: devices, the same steps as time, power and mass instead of the boxes. */
function columns(t: TechId): Col[] {
  if (t === 'cmos') {
    return [
      { k: 'name', label: 'Component' },
      { k: 'cat', label: 'Category' },
      { k: 'transistors', label: 'Transistors' },
      { k: 'nands', label: 'NAND gates', sub: 'log scale' },
      { k: 'depth', label: 'Depth', sub: 'gate delays' },
      { k: 'period', label: 'Clock period', sub: 'NAND delays · MHz' },
      { k: 'levels', label: 'Levels', sub: 'boxes deep' },
      { k: 'parts', label: 'Boxes inside', sub: 'all levels' },
    ];
  }
  const step = TECH[t].stepName;
  return [
    { k: 'name', label: 'Component' },
    { k: 'cat', label: 'Category' },
    { k: 'devices', label: t === 'relay' ? 'Relays' : 'Tubes', sub: t === 'relay' ? 'with fan-out' : 'with followers' },
    { k: 'nands', label: 'NAND gates', sub: 'log scale' },
    { k: 'depth', label: 'Depth', sub: `${step}s · time` },
    { k: 'period', label: 'Clock period', sub: `${step}s · rate` },
    { k: 'watts', label: 'Power', sub: 'average' },
    { k: 'mass', label: 'Mass', sub: 'volume' },
  ];
}
const TECH_LABEL: Record<TechId, string> = { cmos: 'CMOS', relay: 'Relays', tube: 'Tubes' };
const ORDER: Category[] = ['transistor', 'cell', 'gate', 'arithmetic', 'routing', 'sequential', 'memory', 'cpu'];

/** A family's sizes on one row: the largest value of each column (ranges are drawn from members). */
interface Group { family: { id: string; name: string }; cat: Category; members: HwRow[]; values: Record<Key, number | string | null> }
type Item = HwRow | Group;
const isGroup = (x: Item): x is Group => 'members' in x;

// One rows load per visit to the site: the file (or the live computation) is shared by later visits.
let loaded: Promise<HwRow[]> | null = null;

const num = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US'));
const mhz = (p: number) => Math.round(1e6 / (p * PS_PER_NAND));

export class HwStatsPage implements Page {
  readonly kind = 'hwstats';
  readonly el: HTMLElement;
  private rows: HwRow[] = [];
  private q = '';
  private cats = new Set<Category>(ORDER);
  private wiring = false;
  private group = true;
  private sort: Key = 'nands';
  private dir = -1;
  private tech: TechId = 'cmos';
  private techBtns = h('div', { class: 'hw-tech', role: 'group', 'aria-label': 'Technology' });
  private techNote = h('p', { class: 'hw-note hw-tech-note' });
  private open = new Set<string>();
  private alive = true;
  private tiles = h('div', { class: 'hw-tiles' });
  private chips = h('div', { class: 'hw-chips' });
  private count = h('p', { class: 'hw-count' });
  private head = h('tr');
  private body = h('tbody');
  private status = h('p', { class: 'hw-status' }, 'Loading…');

  constructor() {
    const search = h('input', { type: 'search', class: 'hw-search', placeholder: 'Search name or id…', 'aria-label': 'Search components' }) as HTMLInputElement;
    search.addEventListener('input', () => { this.q = search.value.toLowerCase(); this.render(); });
    const check = (label: string, on: boolean, set: (v: boolean) => void) => {
      const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
      box.checked = on;
      box.addEventListener('change', () => { set(box.checked); this.render(); });
      return h('label', null, box, label);
    };
    this.el = h('div', { class: 'hw-page' }, h('div', { class: 'hw-inner' },
      benchTabs('stats'),
      h('h1', null, 'Hardware statistics'),
      h('p', { class: 'hw-sub' }, 'Every library component and the chapters’ CPUs, measured from their own netlists: what each costs ',
        '(transistors, NAND gates), how slow its combinational logic is (gate delays on the worst path) and, for a clocked part, ',
        'the clock period its slowest register-to-register path needs. Click a name to open it on the workbench.'),
      this.tiles,
      h('div', { class: 'hw-controls' }, search, this.techBtns, this.chips,
        h('div', { class: 'hw-switches' }, check('Group sizes', true, (v) => { this.group = v; }), check('Show wiring parts', false, (v) => { this.wiring = v; }))),
      this.count, this.status,
      h('div', { class: 'hw-table-wrap' }, h('table', { class: 'hw-table' }, h('thead', null, this.head), this.body)),
      h('p', { class: 'hw-note' }, `${PS_NOTE} Depth is given for combinational parts, the period for clocked ones; switch-level parts (transistor circuits, SRAM cells) have neither.`),
      this.techNote));
    this.renderTech();
    this.renderHead();
    loaded ??= fetch('hwstats.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { rows: HwRow[] }) => j.rows)
      .catch(() => hwStatsLive((done, total) => {
        if (this.alive) this.status.textContent = `Measuring every component… ${done} of ${total}`;
      }));
    loaded.then((rows) => {
      if (!this.alive) return;
      this.rows = rows;
      this.status.remove();
      this.renderTiles();
      this.renderChips();
      this.render();
    }, (e) => { this.status.textContent = `The statistics could not be computed: ${String(e)}`; });
  }

  destroy(): void {
    this.alive = false;
  }

  /** A row's value in a column, in the chosen technology (null: a dash). */
  private get(r: HwRow, k: Key): number | string | null {
    const t = this.tech;
    const cell = t === 'cmos' ? null : r[t];
    if (k === 'devices') return cell?.n ?? null;
    if (k === 'watts') return cell?.watts ?? null;
    if (k === 'mass') return cell ? cell.n * (t === 'relay' ? RELAY_MASS : TUBE_MASS) : null;
    // a native relay or tube part has no NAND steps; a NAND part cannot be priced in another native technology
    if ((k === 'depth' || k === 'period') && t !== 'cmos' && (!cell || cell.native)) return null;
    return r[k];
  }

  private renderTech(): void {
    this.techBtns.replaceChildren(...(['cmos', 'relay', 'tube'] as TechId[]).map((t) => {
      const b = h('button', { class: `hw-chip${this.tech === t ? ' on' : ''}`, 'aria-pressed': String(this.tech === t),
        title: t === 'cmos' ? 'Transistors, NAND delays at an illustrative 25 ps' : `Every NAND as ${TECH[t].brick}: priced in ${TECH[t].name.toLowerCase()}` }, TECH_LABEL[t]);
      b.addEventListener('click', () => {
        if (this.tech === t) return;
        const cols = columns(t).map((c) => c.k);
        if (!cols.includes(this.sort)) {
          this.sort = this.sort === 'transistors' ? 'devices' : this.sort === 'devices' ? 'transistors' : 'nands';
        }
        this.tech = t;
        this.renderTech();
        this.renderHead();
        this.render();
      });
      return b;
    }));
    this.techNote.textContent = this.tech === 'cmos' ? '' : `Priced in ${TECH[this.tech].name.toLowerCase()}: ${TECH_NOTE} Native relay and tube parts count their own devices and have no NAND steps.`;
  }

  private renderTiles(): void {
    const lib = this.rows.filter((r) => r.cat !== 'plumbing');
    const top = (k: 'nands' | 'depth' | 'period') => lib.filter((r) => r[k] !== null).sort((a, b) => (b[k] as number) - (a[k] as number))[0];
    const link = (r: HwRow) => (r.route ? h('a', { href: r.route }, r.name) : r.name);
    const fams = new Set(this.rows.map((r) => r.family?.id).filter(Boolean)).size;
    const tile = (big: string, ...small: (Node | string)[]) => h('div', { class: 'hw-tile' }, h('b', null, big), h('span', null, ...small));
    const [b, d, p] = [top('nands'), top('depth'), top('period')];
    this.tiles.replaceChildren(
      tile(lib.length.toLocaleString('en-US'), `components (${fams} families of sizes), ${this.rows.length - lib.length} wiring parts`),
      tile(`${num(b.nands)} NANDs`, 'largest: ', link(b)),
      tile(`${d.depth} delays`, 'deepest combinational: ', link(d)),
      tile(`${p.period} delays`, 'slowest clock: ', link(p), ` (${mhz(p.period!)} MHz)`));
  }

  private renderChips(): void {
    const n = new Map<Category, number>();
    for (const r of this.rows) n.set(r.cat, (n.get(r.cat) ?? 0) + 1);
    this.chips.replaceChildren(...ORDER.filter((c) => n.get(c)).map((c) => {
      const b = h('button', { class: `hw-chip${this.cats.has(c) ? ' on' : ''}`, 'aria-pressed': String(this.cats.has(c)) },
        dot(c), CATEGORY_LABEL[c], h('small', null, String(n.get(c))));
      b.addEventListener('click', () => {
        if (this.cats.has(c)) this.cats.delete(c);
        else this.cats.add(c);
        this.renderChips();
        this.render();
      });
      return b;
    }));
  }

  private renderHead(): void {
    this.head.replaceChildren(...columns(this.tech).map((c) => {
      const th = h('th', { scope: 'col', 'aria-sort': this.sort === c.k ? (this.dir > 0 ? 'ascending' : 'descending') : null },
        h('button', null, c.label, this.sort === c.k ? h('span', { class: 'hw-arrow' }, this.dir > 0 ? ' ▲' : ' ▼') : null, c.sub ? h('small', null, c.sub) : null));
      th.addEventListener('click', () => {
        this.dir = this.sort === c.k ? -this.dir : c.k === 'name' || c.k === 'cat' ? 1 : -1;
        this.sort = c.k;
        this.renderHead();
        this.render();
      });
      return th;
    }));
  }

  private render(): void {
    if (!this.rows.length) return;
    const q = this.q;
    const rows = this.rows.filter((r) => (r.cat === 'plumbing' ? this.wiring : this.cats.has(r.cat))
      && (!q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)));
    let items: Item[] = rows;
    if (this.group) {
      items = [];
      const fams = new Map<string, HwRow[]>();
      for (const r of rows) {
        if (!r.family) items.push(r);
        else fams.get(r.family.id)?.push(r) ?? fams.set(r.family.id, [r]);
      }
      for (const ms of fams.values()) {
        if (ms.length === 1) {
          items.push(ms[0]);
          continue;
        }
        ms.sort((a, b) => a.nands - b.nands);
        const values = {} as Group['values'];
        for (const c of columns(this.tech)) {
          const v = ms.map((m) => this.get(m, c.k)).filter((x): x is number => typeof x === 'number');
          values[c.k] = v.length ? Math.max(...v) : null;
        }
        values.name = ms[0].family!.name;
        values.cat = ms[0].cat;
        items.push({ family: ms[0].family!, cat: ms[0].cat, members: ms, values });
      }
    }
    const val = (x: Item, k: Key) => (isGroup(x) ? x.values[k] ?? null : this.get(x, k));
    items.sort((a, b) => {
      const x = val(a, this.sort), y = val(b, this.sort);
      // Missing values (a dash) sort last either way.
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
      return c * this.dir || String(val(a, 'name')).localeCompare(String(val(b, 'name')));
    });
    const max = Math.max(...this.rows.map((r) => r.nands));
    const out: HTMLElement[] = [];
    for (const it of items) {
      if (!isGroup(it)) {
        out.push(this.row(it, max));
        continue;
      }
      const open = this.open.has(it.family.id);
      const chev = h('button', { class: 'hw-chev', 'aria-expanded': String(open), 'aria-label': `${open ? 'Hide' : 'Show'} the sizes` }, open ? '▾' : '▸');
      chev.addEventListener('click', () => {
        if (open) this.open.delete(it.family.id);
        else this.open.add(it.family.id);
        this.render();
      });
      const range = (k: Key) => {
        const v = it.members.map((m) => this.get(m, k)).filter((x): x is number => typeof x === 'number');
        if (!v.length) return '—';
        const lo = Math.min(...v), hi = Math.max(...v);
        const f = (x: number) => this.fmt(k, x);
        return lo === hi ? f(lo) : `${f(lo)}–${f(hi)}`;
      };
      out.push(h('tr', { class: 'hw-fam' },
        h('td', { class: 'hw-name' }, chev, it.family.name, h('span', { class: 'hw-tag' }, `${it.members.length} sizes`)),
        h('td', { class: 'hw-cat' }, dot(it.cat), CATEGORY_LABEL[it.cat]),
        ...columns(this.tech).slice(2).map((c) => (c.k === 'nands'
          ? h('td', { class: 'hw-nands' }, bar(it.values.nands as number, max), range('nands')) : h('td', null, range(c.k))))));
      if (open) for (const m of it.members) out.push(this.row(m, max, true));
    }
    this.body.replaceChildren(...out);
    this.count.textContent = `${rows.length.toLocaleString('en-US')} components shown${this.group ? `, ${items.length.toLocaleString('en-US')} rows` : ''}`;
  }

  /** A family row's range end, formatted for its column. */
  private fmt(k: Key, x: number): string {
    if (this.tech === 'cmos' || (k !== 'watts' && k !== 'mass')) return num(x);
    return k === 'watts' ? fmtWatts(x) : fmtMass(x);
  }

  private row(r: HwRow, max: number, member = false): HTMLElement {
    const name = r.route ? h('a', { href: r.route }, r.name) : r.name;
    const t = this.tech;
    const cell = t === 'cmos' ? null : r[t];
    const steps = (n: number | null, rate: boolean): (Node | string)[] => {
      if (n === null || this.get(r, rate ? 'period' : 'depth') === null) return ['—'];
      const s = n * TECH[t].step;
      return [num(n), h('span', { class: 'hw-mhz hw-tval' }, `${fmtTime(s)}${rate ? ` · ${fmtRate(s)}` : ''}`)];
    };
    const tail = t === 'cmos'
      ? [h('td', null, num(r.transistors)), h('td', { class: 'hw-nands' }, bar(r.nands, max), num(r.nands)),
        h('td', null, r.switchLevel ? h('span', { class: 'hw-na' }, 'switch level') : num(r.depth)),
        h('td', null, r.period === null ? '—' : num(r.period), r.period === null ? null : h('span', { class: 'hw-mhz' }, ` ${mhz(r.period).toLocaleString('en-US')}`)),
        h('td', null, num(r.levels)), h('td', null, num(r.parts))]
      : [h('td', null, cell ? num(cell.n) : h('span', { class: 'hw-na' }, r.switchLevel ? 'transistors' : '—'),
          cell?.native ? h('span', { class: 'hw-tag' }, 'native') : null),
        h('td', { class: 'hw-nands' }, bar(r.nands, max), num(r.nands)),
        h('td', null, ...steps(r.depth, false)),
        h('td', null, ...steps(r.period, true)),
        h('td', null, cell ? fmtWatts(cell.watts) : '—'),
        h('td', null, cell ? fmtMass(cell.n * (t === 'relay' ? RELAY_MASS : TUBE_MASS)) : '—',
          cell ? h('span', { class: 'hw-mhz hw-tval' }, `${fmtVolume(cell.n * (t === 'relay' ? RELAY_VOLUME : TUBE_VOLUME))}`) : null)];
    return h('tr', { class: member ? 'hw-member' : null },
      h('td', { class: 'hw-name' }, member ? null : h('span', { class: 'hw-chev-space' }), name,
        r.cpu ? h('span', { class: 'hw-tag' }, 'chapter CPU') : h('code', null, r.id)),
      h('td', { class: 'hw-cat' }, dot(r.cat), CATEGORY_LABEL[r.cat]),
      ...tail);
  }
}

function dot(c: Category): HTMLElement {
  const hue = CATEGORY_HUE[c];
  return h('i', { class: `hw-dot${hue === undefined ? ' none' : ''}`, style: hue === undefined ? null : `--h:${hue}` });
}

/** A short bar on a log scale: sizes from a NAND to a CPU differ by five orders of magnitude. */
function bar(n: number, max: number): HTMLElement {
  const w = n > 0 ? Math.max(2, (70 * Math.log10(n + 1)) / Math.log10(max + 1)) : 0;
  return h('span', { class: 'hw-bar', style: `width:${w.toFixed(1)}px` });
}
