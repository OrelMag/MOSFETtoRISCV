// The workbench's Statistics tab (#/workbench/stats, its own chunk): every library component and
// the chapters' CPUs in one sortable table, measured from their netlists (lib/hwstats.ts). The
// build ships the rows as hwstats.json; without it (the dev server) they are computed here.

import { groupDigits } from '../../sim/numfmt';
import type { HwRow } from '../../lib/hwstats';
import { RELAY_MASS, RELAY_VOLUME, TECH, TECH_NOTE, TUBE_MASS, TUBE_VOLUME, type TechId, fmtMass, fmtRate, fmtTime, fmtVolume, fmtWatts } from '../../lib/tech';
import { PS_NOTE, PS_PER_NAND } from '../../sim/timing';
import type { Category } from '../../sim/types';
import { CATEGORY_LABEL } from '../../view/inspector';
import { CATEGORY_HUE } from '../../view/symbols';
import { benchTabs } from '../benchtabs';
import { h } from '../dom';
import { virtualRows } from '../../editor/vlist';
import type { Page } from './chapter';

type Key = 'name' | 'cat' | 'transistors' | 'nands' | 'depth' | 'period' | 'levels' | 'parts' | 'devices' | 'watts' | 'mass';
interface Col { k: Key; label: string; sub?: string; title?: string }
/** The columns in CMOS, and in relays or tubes: devices, the same steps as time, power and mass instead of the boxes. */
function columns(t: TechId): Col[] {
  if (t === 'cmos') {
    return [
      { k: 'name', label: 'Component' },
      { k: 'cat', label: 'Category' },
      { k: 'transistors', label: 'Transistors' },
      { k: 'nands', label: 'NAND gates', sub: 'log scale' },
      { k: 'depth', label: 'Depth', sub: 'NAND delays' },
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
    { k: 'watts', label: 'Power', sub: 'average', title: 'Under the conditions in the note below the table' },
    { k: 'mass', label: 'Mass', sub: 'volume', title: 'Under the conditions in the note below the table' },
  ];
}
const TECH_LABEL: Record<TechId, string> = { cmos: 'CMOS', relay: 'Relays', tube: 'Tubes' };
const ORDER: Category[] = ['transistor', 'cell', 'gate', 'arithmetic', 'routing', 'sequential', 'memory', 'cpu'];

/** A family's sizes on one row: the largest value of each column (ranges are drawn from members). */
interface Group { family: { id: string; name: string }; cat: Category; members: HwRow[]; values: Record<Key, number | string | null> }
type Item = HwRow | Group;
/** A line of the table or a card: a part (a family's size when `member`), or a family's own row. */
type Entry = { r: HwRow; member?: boolean } | { g: Group; open: boolean };
const isGroup = (x: Item): x is Group => 'members' in x;

// One rows load per visit to the site: the file (or the live computation) is shared by later visits.
let loaded: Promise<HwRow[]> | null = null;

const num = (n: number | null) => (n === null ? '—' : groupDigits(n));
/** Counts from 100 000 up as 3.44 M / 765 k (the exact figure on hover): a 3 438 100-NAND SoC is read at a glance, not by counting digits. */
const compact = (n: number): string => (n >= 1e6 ? `${+(n / 1e6).toPrecision(3)} M` : n >= 1e5 ? `${Math.round(n / 1e3)} k` : num(n));
const count = (n: number): Node | string => (n >= 1e5 ? h('span', { title: num(n) }, compact(n)) : num(n));
const mhz = (p: number) => Math.round(1e6 / (p * PS_PER_NAND));

export class HwStatsPage implements Page {
  readonly kind = 'hwstats';
  readonly el: HTMLElement;
  private rows: HwRow[] = [];
  private q = '';
  private search!: HTMLInputElement;
  private cats = new Set<Category>(ORDER);
  private wiring = false;
  private group = true;
  private sort: Key = 'nands';
  /** Smallest first: the table opens on the gates and adders, not on the 3.4 M-NAND computers (a click on a header reverses). */
  private dir = 1;
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
    this.search = search;
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
        '(transistors, NAND gates), how slow its combinational logic is (NAND delays on the worst path) and, for a clocked part, ',
        'the clock period its slowest register-to-register path needs. Click a name to open it on the workbench.'),
      this.tiles,
      h('div', { class: 'hw-controls' }, search, this.techBtns, this.chips,
        h('div', { class: 'hw-switches' }, check('Group sizes', true, (v) => { this.group = v; }), check('Show splitters, mergers and wire parts', false, (v) => { this.wiring = v; }))),
      this.count, this.status,
      this.tableWrap = h('div', { class: 'hw-table-wrap' }, h('table', { class: 'hw-table' }, h('thead', null, this.head), this.body)),
      this.cardWrap,
      h('p', { class: 'hw-note' }, `${PS_NOTE} Depth is given for combinational parts, the period for clocked ones; switch-level parts (transistor circuits, SRAM cells) have neither.`),
      this.techNote));
    this.sortSel.addEventListener('change', () => {
      const k = this.sortSel.value as Key;
      this.dir = k === 'name' || k === 'cat' ? 1 : -1;
      this.sort = k;
      this.renderHead();
      this.render();
    });
    this.dirBtn.addEventListener('click', () => { this.dir = -this.dir; this.renderHead(); this.render(); });
    this.phone?.addEventListener?.('change', this.onPhone);
    this.renderTech();
    this.renderHead();
    loaded ??= fetch('hwstats.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { rows: HwRow[] }) => j.rows)
      .catch(async () => {
        // measured here: that reads every registered part, so the whole library loads first (the shipped file needs none of it)
        const [{ hwStatsLive }] = await Promise.all([import('../../lib/hwstats'), import('../../lib')]);
        return hwStatsLive((done, total) => {
          if (this.alive) this.status.textContent = `Measuring every component… ${done} of ${total}`;
        });
      });
    loaded.then((rows) => {
      if (!this.alive) return;
      this.rows = rows;
      this.status.remove();
      this.renderTiles();
      this.renderChips();
      this.render();
    }, (e) => { this.status.textContent = `The statistics could not be computed (${String(e)}). Reload the page to try again.`; });
  }

  destroy(): void {
    this.alive = false;
    this.phone?.removeEventListener?.('change', this.onPhone);
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
      tile(groupDigits(lib.length), `components (${fams} families of sizes), ${this.rows.length - lib.length} wiring parts`),
      tile(`${num(b.nands)} NANDs`, 'largest: ', link(b)),
      tile(`${d.depth} NAND delays`, 'deepest combinational: ', link(d)),
      tile(`${p.period} NAND delays`, 'slowest clock: ', link(p), ` (${mhz(p.period!)} MHz)`));
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
      const th = h('th', { scope: 'col', title: c.title ?? null, 'aria-sort': this.sort === c.k ? (this.dir > 0 ? 'ascending' : 'descending') : null },
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
    // A part with no NAND (a wire, a relay or transistor circuit) has no gate count to order by: it sorts last, not first.
    const val = (x: Item, k: Key) => {
      const v = isGroup(x) ? x.values[k] ?? null : this.get(x, k);
      return k === 'nands' && v === 0 ? null : v;
    };
    items.sort((a, b) => {
      const x = val(a, this.sort), y = val(b, this.sort);
      // Missing values (a dash) sort last either way.
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
      return c * this.dir || String(val(a, 'name')).localeCompare(String(val(b, 'name')));
    });
    const max = Math.max(...this.rows.map((r) => r.nands));
    // the rows in order: a family's own row, then its sizes while it is open
    const flat: Entry[] = [];
    for (const it of items) {
      if (!isGroup(it)) { flat.push({ r: it }); continue; }
      const open = this.open.has(it.family.id);
      flat.push({ g: it, open });
      if (open) for (const m of it.members) flat.push({ r: m, member: true });
    }
    const reset = () => h('button', { class: 'btn sm', onclick: () => { this.q = ''; this.search.value = ''; this.cats = new Set(ORDER); this.renderChips(); this.render(); } }, 'Clear the search and filters');
    const phone = this.phone?.matches ?? false;
    this.tableWrap.hidden = phone;
    this.cardWrap.hidden = !phone;
    if (phone) this.renderCards(flat, max, reset);
    else {
      const out = flat.map((e) => ('g' in e ? this.famRow(e.g, e.open, max) : this.row(e.r, max, e.member)));
      const empty = !out.length;
      // nothing matches: say what to do (the filters are chips, a search and a switch: easy to forget one)
      if (empty) out.push(h('tr', null, h('td', { colspan: String(columns(this.tech).length), class: 'hw-empty' }, 'No part matches. ', reset())));
      this.holdColumns(empty);
      this.body.replaceChildren(...out);
    }
    // the tile above counts every library part; this is how many of all the table's rows (wiring parts included) pass the filters
    this.count.textContent = `${groupDigits(rows.length)} of ${groupDigits(this.rows.length)} parts shown${this.group ? `, in ${groupDigits(items.length)} rows (sizes grouped)` : ''}`;
  }

  private toggleFam(id: string): void {
    if (this.open.has(id)) this.open.delete(id);
    else this.open.add(id);
    this.render();
  }

  /** A family's range of a column over its sizes ("8–2 112"). */
  private range(g: Group, k: Key): string {
    const v = g.members.map((m) => this.get(m, k)).filter((x): x is number => typeof x === 'number');
    if (!v.length) return '—';
    const lo = Math.min(...v), hi = Math.max(...v);
    return lo === hi ? this.fmt(k, lo) : `${this.fmt(k, lo)}–${this.fmt(k, hi)}`;
  }

  private famRow(g: Group, open: boolean, max: number): HTMLElement {
    const chev = h('button', { class: 'hw-chev', 'aria-expanded': String(open), 'aria-label': `${open ? 'Hide' : 'Show'} the sizes` }, open ? '▾' : '▸');
    chev.addEventListener('click', () => this.toggleFam(g.family.id));
    return h('tr', { class: 'hw-fam' },
      h('td', { class: 'hw-name' }, chev, g.family.name, h('span', { class: 'hw-tag' }, `${g.members.length} sizes`)),
      h('td', { class: 'hw-cat' }, dot(g.cat), CATEGORY_LABEL[g.cat]),
      ...columns(this.tech).slice(2).map((c) => (c.k === 'nands'
        ? h('td', { class: 'hw-nands' }, bar(g.values.nands as number, max), this.range(g, 'nands')) : h('td', null, this.range(g, c.k)))));
  }

  // ---- a phone: two-line cards, only those in view built ------------------------------------------------------------

  private readonly phone = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : null;
  private readonly onPhone = () => this.render();
  private readonly sortSel = h('select', { class: 'hw-sort-sel', 'aria-label': 'Sort by' }) as HTMLSelectElement;
  private readonly dirBtn = h('button', { class: 'btn sm hw-sort-dir' }) as HTMLButtonElement;
  private readonly cardList = h('div', { class: 'hw-cards', role: 'list', 'aria-label': 'Components' });
  private readonly cardBody = h('div', { class: 'hw-cards-body' });
  private readonly cardWrap = h('div', { class: 'hw-card-wrap', hidden: true },
    h('div', { class: 'hw-sort' }, h('label', null, 'Sort by ', this.sortSel), this.dirBtn), this.cardList);
  private tableWrap!: HTMLElement;
  private cardKey = '';
  private twice = new Set<string>();

  /** The sort select's options follow the technology's columns (the table's headers on a desktop). */
  private renderSort(): void {
    this.sortSel.replaceChildren(...columns(this.tech).map((c) => h('option', { value: c.k, selected: c.k === this.sort ? '' : null }, c.label)));
    this.sortSel.value = this.sort;
    const up = this.dir > 0, t = up ? 'Smallest first: tap for largest first' : 'Largest first: tap for smallest first';
    this.dirBtn.textContent = up ? '↑ smallest' : '↓ largest';
    this.dirBtn.title = t;
    this.dirBtn.setAttribute('aria-label', t);
  }

  private renderCards(flat: Entry[], max: number, reset: () => HTMLElement): void {
    this.renderSort();
    if (!flat.length) {
      this.cardKey = '';
      this.cardList.replaceChildren(h('p', { class: 'hw-empty' }, 'No part matches. ', reset()));
      return;
    }
    // two parts of one name (a library decoder and a campaign one) tell apart by their ids, as the table's column does
    const seen = new Set<string>();
    this.twice = new Set();
    for (const e of flat) if ('r' in e) { if (seen.has(e.r.name)) this.twice.add(e.r.name); seen.add(e.r.name); }
    const key = `${this.tech}|${this.sort}|${this.dir}`;
    // the list starts at the top when the order changes, and stays where it was when a family opens or a filter narrows it
    const keep = key === this.cardKey ? this.cardList.scrollTop : 0;
    this.cardKey = key;
    this.cardList.replaceChildren(this.cardBody);
    this.cardList.scrollTop = keep;
    virtualRows({ count: flat.length, el: this.cardList, body: this.cardBody, rowH: 82, row: (i) => this.card(flat[i], max) });
  }

  /** A card's big number: the sorted-by column's value (NAND gates when the order is by name or category). */
  private cardBig(k: Key, v: number | string | null, r: HwRow | null): string {
    if (v === null) return '—';
    if (typeof v === 'string') return v;
    if (k === 'period' && r && this.tech === 'cmos') return `period ${num(v)} · ${groupDigits(mhz(v))} MHz`;
    const unit: Partial<Record<Key, string>> = { nands: ' NAND', transistors: ' transistors', depth: ' deep', period: ' period', levels: ' levels', parts: ' boxes', devices: this.tech === 'relay' ? ' relays' : ' tubes' };
    return this.fmt(k, v) + (unit[k] ?? '');
  }

  /** The other numbers on one muted line: every column but the one in the big number (NAND gates among them when that is not it). */
  private cardLine(val: (k: Key) => string, r: HwRow | null, big: Key): string {
    const t = this.tech, out: [Key, string][] = [];
    const has = (k: Key) => val(k) !== '—';
    if (big !== 'nands' && has('nands')) out.push(['nands', `${val('nands')} NAND`]);
    if (t === 'cmos') {
      out.push(['transistors', `${val('transistors')} transistors`]);
      if (r?.switchLevel) out.push(['depth', 'switch level']);
      else {
        if (has('depth')) out.push(['depth', `depth ${val('depth')}`]);
        if (has('period')) out.push(['period', r?.period ? `period ${val('period')} · ${groupDigits(mhz(r.period))} MHz` : `period ${val('period')}`]);
      }
      out.push(['levels', `${val('levels')} levels`], ['parts', `${val('parts')} boxes`]);
    } else {
      if (has('devices')) out.push(['devices', `${val('devices')} ${t === 'relay' ? 'relays' : 'tubes'}`]);
      const step = TECH[t].step, d = r ? this.get(r, 'depth') : null, p = r ? this.get(r, 'period') : null;
      if (typeof d === 'number') out.push(['depth', `depth ${fmtTime(d * step)}`]);
      else if (!r && has('depth')) out.push(['depth', `depth ${val('depth')}`]);
      if (typeof p === 'number') out.push(['period', `period ${fmtRate(p * step)}`]);
      else if (!r && has('period')) out.push(['period', `period ${val('period')}`]);
      if (has('watts')) out.push(['watts', val('watts')]);
      if (has('mass')) out.push(['mass', val('mass')]);
    }
    return out.filter(([k]) => k !== big || (k === 'period' && t !== 'cmos')).map(([, x]) => x).join(' · ');
  }

  private card(e: Entry, max: number): HTMLElement {
    const big = this.sort === 'name' || this.sort === 'cat' ? 'nands' : this.sort;
    if ('g' in e) {
      const g = e.g;
      const chev = h('button', { class: 'hw-chev', 'aria-expanded': String(e.open), 'aria-label': `${e.open ? 'Hide' : 'Show'} the ${g.members.length} sizes of ${g.family.name}` }, e.open ? '▾' : '▸');
      chev.addEventListener('click', () => this.toggleFam(g.family.id));
      const v = (k: Key) => this.range(g, k);
      return h('div', { class: 'hw-card hw-fam', role: 'listitem' },
        h('div', { class: 'hw-l1' }, dot(g.cat), h('span', { class: 'hw-cname' }, g.family.name, h('span', { class: 'hw-tag' }, `${g.members.length} sizes`)),
          h('b', null, this.range(g, big) + (big === 'nands' ? ' NAND' : '')), chev),
        h('div', { class: 'hw-l2' }, this.cardLine(v, null, big)),
        h('span', { class: 'hw-cbar' }, bar(g.values.nands as number, max)));
    }
    const r = e.r;
    // a part with nothing in the sorted column (no period: combinational) shows its NAND gates there instead of a dash
    const shown: Key = this.get(r, big) === null ? 'nands' : big;
    const v = (k: Key) => {
      const x = this.get(r, k);
      return x === null ? '—' : typeof x === 'string' ? x : this.fmt(k, x);
    };
    const tip = `${r.name} (${r.id})`, name = r.route ? h('a', { href: r.route, title: tip }, r.name) : h('span', { title: tip }, r.name);
    return h('div', { class: `hw-card${e.member ? ' hw-member' : ''}`, role: 'listitem' },
      h('div', { class: 'hw-l1' }, dot(r.cat), h('span', { class: 'hw-cname' }, name,
        r.cpu ? h('span', { class: 'hw-tag' }, 'chapter CPU') : null), h('b', null, this.cardBig(shown, this.get(r, shown), r))),
      h('div', { class: 'hw-l2' }, this.twice.has(r.name) ? h('code', null, r.id) : null, this.cardLine(v, r, shown)),
      h('span', { class: 'hw-cbar' }, bar(r.nands, max)));
  }

  /** Widths of the header's columns as the unfiltered table laid them out, and whether the table on screen is that one. */
  private colW: number[] = [];
  private full = false;

  /** A table with no row would size its columns to the header alone and shift them: while it is empty the columns keep the
   *  widths the full table gave them (measured just before the next render replaces it, once the fonts are in; a narrowed
   *  table sizes to its few rows, so only the unfiltered one is taken). */
  private holdColumns(empty: boolean): void {
    const table = this.body.parentElement as HTMLTableElement | null;
    if (!table) return;
    const ths = [...this.head.children] as HTMLElement[];
    if (this.full) this.colW = ths.map((th) => th.offsetWidth);
    this.full = !empty && !this.q && this.cats.size === ORDER.length;
    if (!empty) { table.style.tableLayout = ''; return; }
    if (this.colW.length !== ths.length || this.colW.some((w) => !w)) return;
    ths.forEach((th, i) => { th.style.width = `${this.colW[i]}px`; });
    table.style.tableLayout = 'fixed';
  }

  /** A family row's range end, formatted for its column. */
  private fmt(k: Key, x: number): string {
    if (this.tech === 'cmos' || (k !== 'watts' && k !== 'mass')) return compact(x);
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
      ? [h('td', null, count(r.transistors)), h('td', { class: 'hw-nands' }, bar(r.nands, max), count(r.nands)),
        h('td', null, r.switchLevel ? h('span', { class: 'hw-na' }, 'switch level') : num(r.depth)),
        h('td', null, r.period === null ? '—' : num(r.period), r.period === null ? null : h('span', { class: 'hw-mhz' }, ` · ${groupDigits(mhz(r.period))} MHz`)),
        h('td', null, num(r.levels)), h('td', null, count(r.parts))]
      : [h('td', null, cell ? count(cell.n) : h('span', { class: 'hw-na' }, r.switchLevel ? 'transistors' : '—'),
          cell?.native ? h('span', { class: 'hw-tag' }, 'native') : null),
        h('td', { class: 'hw-nands' }, bar(r.nands, max), count(r.nands)),
        h('td', null, ...steps(r.depth, false)),
        h('td', null, ...steps(r.period, true)),
        h('td', null, cell ? fmtWatts(cell.watts) : '—'),
        h('td', null, cell ? fmtMass(cell.n * (t === 'relay' ? RELAY_MASS : TUBE_MASS)) : '—',
          cell ? h('span', { class: 'hw-mhz hw-tval' }, `${fmtVolume(cell.n * (t === 'relay' ? RELAY_VOLUME : TUBE_VOLUME))}`) : null)];
    return h('tr', { class: member ? 'hw-member' : null },
      h('td', { class: 'hw-name' }, member ? null : h('span', { class: 'hw-chev-space' }), name,
        r.cpu ? h('span', { class: 'hw-tag' }, 'chapter CPU') : h('code', { title: r.id }, r.id)),
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
