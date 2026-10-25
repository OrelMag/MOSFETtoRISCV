// Truth-table chips in the sandbox (plugin): the table beside the canvas (pins, rows, a Karnaugh map with the cover's
// loops for 2–4 inputs, each output's equation and the cost), a banner on the canvas (Detach, Hide table), and
// New chip ▾ Truth table. Every edit of the table is one undo step that redraws the chip (ttable.ts).

import '../styles/editor-table.css';
import { h } from '../ui/dom';
import { type Editor, registerEditorPlugin, registerNewChipKind } from './editor';
import type { TableDoc } from './model';
import { pinBig } from './model';
import {
  addInput, addOutput, type Cell, detachTable, equation, inBit, newTableChip, nextCell, removeInput, removeOutput, renamePin, rowCount, setCell,
  setTable, TABLE_MAX_IN, TABLE_MAX_OUT, tableCost, tableDef, tableLogic, type TableLogic, termCovers, termText,
} from './ttable';

const HIDDEN_KEY = 'mosfet2riscv:table-hidden';
const load = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };

/** Gray-code order of 1 or 2 bits: K-map rows and columns. */
const GRAY: Record<number, number[]> = { 0: [0], 1: [0, 1], 2: [0, 1, 3, 2] };
/** Loop colours (classes tt-l0…tt-l5, both themes in editor-table.css). */
const LOOPS = 6;

class TableUi {
  readonly pane: HTMLElement;
  private readonly body: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly unsub: () => void;
  private hidden = new Set<string>(JSON.parse(load(HIDDEN_KEY) ?? '[]') as string[]);
  /** The output the Karnaugh map shows, per chip. */
  private mapOut = new Map<string, number>();
  /** A cell to focus after the next render (keyboard entry moves down the column). */
  private focusAt: { j: number; r: number } | null = null;
  private hot: number | null = null;
  private key = '';

  constructor(readonly ed: Editor) {
    this.body = h('div', { class: 'tt-body' });
    this.pane = h('div', { class: 'tt-pane', hidden: true, role: 'region', 'aria-label': 'Truth table' }, this.body);
    this.banner = h('div', { class: 'hdl-banner tt-banner', hidden: true });
    ed.slots.left.append(this.pane);
    ed.slots.overlay.append(this.banner);
    this.unsub = ed.onChange(() => this.sync());
    this.sync();
  }

  destroy(): void {
    this.unsub();
    this.pane.remove();
    this.banner.remove();
  }

  private get table(): TableDoc | undefined { return this.ed.ws.chips[this.ed.chipId]?.table; }

  /** After every change: the pane for the open chip's table (rebuilt only when the table or the inputs moved). */
  sync(): void {
    const t = this.table;
    const id = this.ed.chipId;
    this.banner.hidden = !t;
    this.pane.hidden = !t || this.hidden.has(id);
    if (!t) { this.key = ''; return; }
    this.renderBanner(id);
    const key = JSON.stringify([id, t, this.liveRow(t), this.mapOut.get(id) ?? 0, this.hot]);
    if (key === this.key || this.pane.hidden) return;
    this.key = key;
    this.render(id, t);
  }

  /** The row the chip's input pins select now (every input set), else null. */
  private liveRow(t: TableDoc): number | null {
    const pins = this.ed.doc.pins;
    let r = 0;
    for (const name of t.ins) {
      const p = pins.find((x) => x.name === name && x.dir === 'in');
      if (!p) return null;
      r = (r << 1) | Number(pinBig(p.value) & 1n);
    }
    return r;
  }

  private renderBanner(id: string): void {
    const hidden = this.hidden.has(id);
    this.banner.replaceChildren(
      h('span', { class: 'hdl-badge tt-badge' }, 'TT'),
      h('span', { class: 'grow' }, 'Drawn from its ', h('b', null, 'truth table'), ' · edit the table to change it'),
      h('button', { class: 'btn sm', title: 'Keep the drawing as an ordinary chip (the table is dropped)', onclick: () => this.detach() }, 'Detach as drawn chip'),
      h('button', { class: 'btn sm', onclick: () => this.toggleHidden(id) }, hidden ? 'Show table' : 'Hide table'));
  }

  private toggleHidden(id: string): void {
    if (this.hidden.has(id)) this.hidden.delete(id); else this.hidden.add(id);
    save(HIDDEN_KEY, JSON.stringify([...this.hidden]));
    this.key = '';
    this.sync();
  }

  private detach(): void {
    const name = this.ed.doc.name;
    this.ed.editWs((ws) => detachTable(ws, this.ed.chipId));
    this.ed.toast(`${name} is an ordinary drawn chip now (Ctrl+Z puts the table back)`);
  }

  /** One undo step: the table and the redrawn chip. */
  private apply(next: TableDoc): void {
    const id = this.ed.chipId;
    if (next === this.table) return;
    let err: string | null = null;
    this.ed.editWs((ws) => {
      const r = setTable(ws, id, next);
      if ('error' in r) { err = r.error; return ws; }
      return r;
    });
    if (err) { this.ed.toast(`Truth table: ${err}`, 'err'); this.key = ''; this.sync(); }
  }

  // ---- drawing --------------------------------------------------------------------------------------

  private render(id: string, t: TableDoc): void {
    const logic = tableLogic(t);
    const def = tableDef(t, 'tt', logic);
    const cost = tableCost(t, logic, def);
    const live = this.liveRow(t);
    const sel = Math.min(this.mapOut.get(id) ?? 0, t.outs.length - 1);
    const n = t.ins.length;

    const form = h('div', { class: 'hdl-seg tt-form', role: 'radiogroup', 'aria-label': 'Built as' },
      ([['nand', 'NAND–NAND', 'Only NAND gates and inverters: the two-level form the brick gives'], ['andor', 'AND–OR', 'AND gates into OR gates, with inverters: the textbook drawing']] as const)
        .map(([k, label, title]) => h('button', {
          class: t.form === k ? 'on' : '', role: 'radio', 'aria-checked': String(t.form === k), title,
          onclick: () => t.form !== k && this.apply({ ...t, form: k }),
        }, label)));

    const head = h('div', { class: 'tt-head' },
      h('span', { class: 'tt-title' }, 'Truth table'), h('span', { class: 'grow' }), form,
      h('button', { class: 'btn sm', title: 'Hide the table (the banner shows it again)', onclick: () => this.toggleHidden(id), 'aria-label': 'Hide the table' }, '◂'));

    const pins = h('div', { class: 'tt-pins' },
      h('div', { class: 'tt-pinrow' }, h('span', { class: 'tt-lbl' }, 'Inputs'),
        t.ins.map((name, i) => this.pinField(t, 'in', i, name)),
        h('button', { class: 'btn sm', disabled: n >= TABLE_MAX_IN, title: n >= TABLE_MAX_IN ? `At most ${TABLE_MAX_IN} inputs` : 'Add an input (the outputs ignore it until you change them)', onclick: () => this.apply(addInput(t)) }, '+ Input')),
      h('div', { class: 'tt-pinrow' }, h('span', { class: 'tt-lbl' }, 'Outputs'),
        t.outs.map((name, j) => this.pinField(t, 'out', j, name)),
        h('button', { class: 'btn sm', disabled: t.outs.length >= TABLE_MAX_OUT, title: t.outs.length >= TABLE_MAX_OUT ? `At most ${TABLE_MAX_OUT} outputs` : 'Add an output (all 0)', onclick: () => this.apply(addOutput(t)) }, '+ Output')));

    const grid = this.tableGrid(t, live, logic, sel);
    const kmap = n >= 2 && n <= 4 ? this.kmap(t, sel, logic) : h('p', { class: 'tt-note' }, n < 2 ? 'A Karnaugh map needs two inputs or more.' : 'Karnaugh maps are drawn for up to four inputs; the table and the equations cover the rest.');

    const outTabs = t.outs.length > 1 ? h('div', { class: 'hdl-seg tt-outs', role: 'tablist', 'aria-label': 'Output shown on the map' },
      t.outs.map((o, j) => h('button', { class: j === sel ? 'on' : '', role: 'tab', 'aria-selected': String(j === sel), onclick: () => { this.mapOut.set(id, j); this.hot = null; this.sync(); } }, o))) : null;

    const eqs = h('div', { class: 'tt-eqs' }, t.outs.map((_, j) => {
      const o = logic.outs[j];
      return h('div', { class: `tt-eq${j === sel ? ' sel' : ''}` }, h('code', null, `${t.outs[j]} = `),
        o.kind === 'const' ? h('code', null, String(o.value)) : o.uses.map((k, i) => [
          i ? h('code', null, ' + ') : null,
          h('code', {
            class: j === sel ? `tt-term tt-l${o.uses.indexOf(k) % LOOPS}${this.hot === k ? ' hot' : ''}` : 'tt-term',
            onmouseenter: () => { if (j === sel) { this.hot = k; this.sync(); } },
            onmouseleave: () => { if (this.hot === k) { this.hot = null; this.sync(); } },
          }, termText(t, logic.terms[k])),
        ]));
    }));

    const costLine = h('div', { class: 'tt-cost' },
      h('span', null, h('b', null, String(cost.nands)), ' NAND'),
      h('span', null, 'depth ', h('b', null, cost.depth === null ? '–' : String(cost.depth))),
      h('span', null, h('b', null, String(cost.terms)), ` term${cost.terms === 1 ? '' : 's'}, `, h('b', null, String(cost.literals)), ' literals'),
      h('span', { class: cost.exact ? 'ok' : 'warn', title: cost.exact ? 'Fewest terms, then fewest literals, for every output (proved by search)' : 'The search for a proven minimum was too long: a greedy cover from the prime implicants, close to minimal' },
        cost.exact ? '✓ minimal' : '≈ near-minimal'));

    this.body.replaceChildren(head, pins,
      h('div', { class: 'tt-main' }, grid,
        h('div', { class: 'tt-side' }, h('span', { class: 'tt-lbl' }, 'Karnaugh map'), outTabs, kmap, h('span', { class: 'tt-lbl' }, 'Minimized'), eqs, costLine,
          h('p', { class: 'tt-note' }, 'A click on an output cycles 0 → 1 → – (don’t care). On a cell, type 0, 1 or - (x too): the next row gets the focus.'))));

    if (this.focusAt) {
      const { j, r } = this.focusAt;
      this.focusAt = null;
      (this.body.querySelector(`[data-cell="${j}:${r}"]`) as HTMLElement | null)?.focus();
    }
  }

  private pinField(t: TableDoc, side: 'in' | 'out', k: number, name: string): HTMLElement {
    const inp = h('input', { class: 'tt-pin', value: name, size: Math.max(2, name.length), spellcheck: 'false', 'aria-label': `${side === 'in' ? 'Input' : 'Output'} ${k + 1} name` }) as HTMLInputElement;
    const commit = () => {
      const v = inp.value.trim();
      if (v === name) return;
      this.apply(renamePin(t, side, k, v));
    };
    inp.addEventListener('change', commit);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = name; inp.blur(); } });
    const many = side === 'in' ? t.ins.length > 1 : t.outs.length > 1;
    return h('span', { class: `tt-pinbox ${side}` }, inp,
      many ? h('button', { class: 'tt-x', title: side === 'in' ? `Remove ${name} (the rows where it is 1 go)` : `Remove ${name}`, 'aria-label': `Remove ${name}`,
        onclick: () => this.apply(side === 'in' ? removeInput(t, k) : removeOutput(t, k)) }, '×') : null);
  }

  private tableGrid(t: TableDoc, live: number | null, logic: TableLogic, sel: number): HTMLElement {
    const n = t.ins.length;
    const hotTerm = this.hot !== null ? logic.terms[this.hot] : null;
    const rows = Array.from({ length: rowCount(t) }, (_, r) => h('tr', { class: `${r === live ? 'live' : ''}${hotTerm && termCovers(hotTerm, r) ? ' hot' : ''}` },
      t.ins.map((_, i) => h('td', { class: 'in' }, String(inBit(t, r, i)))),
      t.outs.map((o, j) => {
        const c = t.rows[j][r];
        return h('td', { class: `out${j === 0 ? ' sep' : ''}${j === sel ? ' sel' : ''}` }, h('button', {
          class: `tt-cell c${c === '-' ? 'd' : c}`, 'data-cell': `${j}:${r}`,
          'aria-label': `${o} for ${t.ins.map((x, i) => `${x}=${inBit(t, r, i)}`).join(' ')}: ${c === '-' ? 'don’t care' : c}`,
          onclick: () => this.apply(setCell(t, j, r, nextCell(c))),
          onkeydown: (e: Event) => this.cellKey(e as KeyboardEvent, t, j, r),
        }, c === '-' ? '–' : c));
      })));
    return h('div', { class: 'tt-scroll' }, h('table', { class: 'tt-table' },
      h('thead', null, h('tr', null, t.ins.map((x) => h('th', { class: 'in' }, x)), t.outs.map((x, j) => h('th', { class: `out${j === 0 ? ' sep' : ''}${j === sel ? ' sel' : ''}` }, x)))),
      h('tbody', null, rows)),
    n > 6 ? h('p', { class: 'tt-note' }, `${rowCount(t)} rows`) : null);
  }

  private cellKey(e: KeyboardEvent, t: TableDoc, j: number, r: number): void {
    const map: Record<string, Cell> = { '0': '0', '1': '1', '-': '-', x: '-', X: '-' };
    const set = map[e.key];
    const last = rowCount(t) - 1;
    if (set) {
      e.preventDefault();
      this.focusAt = { j, r: Math.min(r + 1, last) };
      const next = setCell(t, j, r, set);
      if (next === t) { this.focusAt = null; (this.body.querySelector(`[data-cell="${j}:${Math.min(r + 1, last)}"]`) as HTMLElement | null)?.focus(); }
      else this.apply(next);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const nr = e.key === 'ArrowDown' ? Math.min(r + 1, last) : e.key === 'ArrowUp' ? Math.max(r - 1, 0) : r;
      const nj = e.key === 'ArrowRight' ? Math.min(j + 1, t.outs.length - 1) : e.key === 'ArrowLeft' ? Math.max(j - 1, 0) : j;
      (this.body.querySelector(`[data-cell="${nj}:${nr}"]`) as HTMLElement | null)?.focus();
    }
  }

  /** Output j's Karnaugh map: the first half of the inputs down the side, the rest across, both in Gray order. */
  private kmap(t: TableDoc, j: number, logic: TableLogic): HTMLElement {
    const n = t.ins.length, rb = n >> 1, cb = n - rb;
    const rowsG = GRAY[rb], colsG = GRAY[cb];
    const rowOf = (ri: number, ci: number) => (rowsG[ri] << cb) | colsG[ci];
    const CW = 40, CH = 32, HW = 52, HH = 26;
    const bits = (v: number, w: number) => (w ? v.toString(2).padStart(w, '0') : '');
    const o = logic.outs[j];
    const cells: HTMLElement[] = [];
    cells.push(h('div', { class: 'tt-kh corner', style: `left:0;top:0;width:${HW}px;height:${HH}px` },
      h('span', null, t.ins.slice(0, rb).join('')), h('span', null, t.ins.slice(rb).join(''))));
    colsG.forEach((c, ci) => cells.push(h('div', { class: 'tt-kh', style: `left:${HW + ci * CW}px;top:0;width:${CW}px;height:${HH}px` }, bits(c, cb))));
    rowsG.forEach((rg, ri) => {
      cells.push(h('div', { class: 'tt-kh', style: `left:0;top:${HH + ri * CH}px;width:${HW}px;height:${CH}px` }, bits(rg, rb)));
      colsG.forEach((_, ci) => {
        const r = rowOf(ri, ci), c = t.rows[j][r];
        cells.push(h('button', {
          class: `tt-kc c${c === '-' ? 'd' : c}`, style: `left:${HW + ci * CW}px;top:${HH + ri * CH}px;width:${CW}px;height:${CH}px`,
          'aria-label': `${t.outs[j]} for ${t.ins.map((x, i) => `${x}=${inBit(t, r, i)}`).join(' ')}: ${c === '-' ? 'don’t care' : c}`,
          onclick: () => this.apply(setCell(t, j, r, nextCell(c))),
        }, c === '-' ? '–' : c));
      });
    });
    // Loops: a term's cells form runs along each axis (two when it wraps); one rectangle per pair of runs.
    if (o.kind === 'terms') o.uses.forEach((k, li) => {
      const p = logic.terms[k];
      const runs = (count: number, inTerm: (i: number) => boolean) => {
        const out: [number, number][] = [];
        for (let i = 0; i < count; i++) if (inTerm(i) && (i === 0 || !inTerm(i - 1))) {
          let e = i;
          while (e + 1 < count && inTerm(e + 1)) e++;
          out.push([i, e]);
        }
        return out;
      };
      const rr = runs(rowsG.length, (ri) => colsG.some((_, ci) => termCovers(p, rowOf(ri, ci))));
      const cr = runs(colsG.length, (ci) => rowsG.some((_, ri) => termCovers(p, rowOf(ri, ci))));
      const inset = 3 + (li % 3) * 3;
      for (const [r0, r1] of rr) for (const [c0, c1] of cr) {
        cells.push(h('span', {
          class: `tt-loop tt-l${li % LOOPS}${this.hot === k ? ' hot' : ''}`, 'aria-hidden': 'true',
          style: `left:${HW + c0 * CW + inset}px;top:${HH + r0 * CH + inset}px;width:${(c1 - c0 + 1) * CW - 2 * inset}px;height:${(r1 - r0 + 1) * CH - 2 * inset}px`,
        }));
      }
    });
    return h('div', { class: 'tt-kmap', style: `width:${HW + colsG.length * CW}px;height:${HH + rowsG.length * CH}px`, role: 'group', 'aria-label': `Karnaugh map of ${t.outs[j]}: ${equation(t, j, logic)}` }, cells);
  }
}

registerEditorPlugin((ed) => {
  if (ed.level) return; // campaign levels: not yet (it would solve the levels that teach minimization)
  const ui = new TableUi(ed);
  return () => ui.destroy();
});

registerNewChipKind({
  label: 'Truth table', hint: 'fill in a table: the minimized logic is drawn', icon: 'table',
  run: (ed) => ed.editWs((ws) => newTableChip(ws).ws),
});
