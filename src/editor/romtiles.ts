// The program editor's Tiles view: the program as one tile per line, drawn from the text (which stays
// what is stored and undone). A tile shows the instruction's name, operands and word as a strip of
// its fields; a branch or jump draws an arrow in the gutter to the line it goes to; pointing at a tile
// outlines the lines above that wrote the registers it reads. A click opens the instruction builder on
// that line; dragging a tile moves its line (one undo step in the code editor). Model: isa/tiles.ts.

import type { ComposeIsa } from '../isa/composekit';
import type { Tile } from '../isa/tiles';
import { h, s } from '../ui/dom';
import type { CodeEditor } from '../widgets/codeedit';

export interface RomTiles {
  el: HTMLElement;
  /** Rebuild from the editor's text (after an edit). */
  refresh(): void;
}

const ROLE_OF = (t: Tile) => (t.target !== undefined ? 'f-fn' : t.writes.length ? 'f-rd' : 'f-rs');

export function romTiles(ce: CodeEditor, isaOf: () => Promise<ComposeIsa | null>, openAt: (line: number) => void): RomTiles {
  const list = h('div', { class: 'sb-tiles-list' });
  const gutter = s('svg', { class: 'sb-tiles-gutter', 'aria-hidden': 'true' });
  const el = h('div', { class: 'sb-tiles' }, h('div', { class: 'sb-tiles-gut' }, gutter), list);
  let tiles: Tile[] = [];
  let isa: ComposeIsa | null = null;
  let dragFrom = 0;
  let seq = 0;

  const draw = () => {
    if (!isa) return;
    const W = isa.wordBits;
    const rows = tiles.map((t, i) => {
      if (t.kind === 'blank') return h('div', { class: 'sb-tile-gap', 'data-i': i });
      if (t.kind === 'comment') return h('div', { class: 'sb-tile-note', 'data-i': i }, t.comment);
      const label = h('span', { class: 'lbl' }, t.labels.map((l) => `${l}:`).join(' '));
      let body: (Node | string)[];
      let right: Node | string = '';
      if (t.kind === 'instr' && t.name) {
        const ops = t.code.slice(t.code.search(/\s|$/)).trim();
        const args = ops ? ops.split(/,\s*/) : [];
        body = [h('span', { class: `mn ${ROLE_OF(t)}` }, t.code.split(/\s+/)[0]), ...args.map((a) => h('span', { class: 'opd' }, a))];
        const w = t.words[0].word;
        const fields = isa!.fields(w);
        right = h('span', { class: 'right' },
          h('span', { class: 'mini', style: `--n:${W}` }, Array.from({ length: W }, (_, k) => {
            const b = W - 1 - k, f = fields.find((x) => x.lo <= b && b <= x.hi);
            return h('i', { class: `f-${f?.role ?? 'op'}${(w >>> b) & 1 ? ' one' : ''}` });
          })),
          h('code', { class: 'hex' }, `${t.words[0].addr.toString(16).padStart(3, '0')}  ${(w >>> 0).toString(16).padStart(W / 4, '0')}`));
      } else if (t.kind === 'pseudo') {
        body = [h('span', { class: 'mn f-op' }, t.code.split(/\s+/)[0]), h('span', { class: 'opd' }, t.code.slice(t.code.search(/\s|$/)).trim()),
          h('span', { class: 'cmt' }, `→ ${t.words.length} instructions: ${t.words.map((x) => isa!.text(x.word)).join('; ')}`)];
      } else if (t.kind === 'error') {
        body = [h('span', { class: 'opd' }, t.code), h('span', { class: 'sb-tile-err' }, t.error ?? 'does not assemble')];
      } else {
        body = [h('span', { class: 'opd' }, t.code || '')];
      }
      const why = h('span', { class: 'sb-tile-why' });
      const row = h('div', {
        class: `sb-tile ${t.kind}`, 'data-i': i, draggable: 'true', tabindex: '0', role: 'button',
        title: `line ${t.line}: click to build it, drag to move it`,
      }, h('span', { class: 'grip', 'aria-hidden': 'true' }, '⋮⋮'), label, h('span', { class: 'body' }, ...body, t.comment ? h('span', { class: 'cmt' }, t.comment) : '', why), right);
      row.addEventListener('click', () => openAt(t.line));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); openAt(t.line); } });
      row.addEventListener('mouseenter', () => {
        for (const f of t.from) list.querySelector(`[data-i="${f.tile}"]`)?.classList.add('prod');
        why.textContent = t.from.length ? `← ${t.from.map((f) => `${f.reg.name} from line ${tiles[f.tile].line}`).join(', ')}` : '';
      });
      row.addEventListener('mouseleave', () => { list.querySelectorAll('.prod').forEach((x) => x.classList.remove('prod')); why.textContent = ''; });
      row.addEventListener('dragstart', (e) => { dragFrom = t.line; row.classList.add('dragging'); e.dataTransfer?.setData('text/plain', String(t.line)); });
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); list.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')); });
      row.addEventListener('dragover', (e) => { e.preventDefault(); list.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')); row.classList.add('drop'); });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragFrom) return;
        void import('../isa/tiles').then(({ moveLine }) => {
          const next = moveLine(ce.value, dragFrom, t.line);
          dragFrom = 0;
          ce.replaceAll(next);
        });
      });
      return row;
    });
    list.replaceChildren(...rows);
    requestAnimationFrame(arrows);
  };

  /** Branch arrows: from a tile's middle to its target's, nested so a short one sits inside a long one. */
  const arrows = () => {
    const gb = gutter.getBoundingClientRect();
    const spans = tiles.map((t, i) => ({ i, j: t.target ?? -2 })).filter((x) => x.j >= 0)
      .sort((a, b) => Math.abs(a.j - a.i) - Math.abs(b.j - b.i));
    const W = gb.width;
    const parts: SVGElement[] = [];
    spans.forEach((sp, k) => {
      const a = list.querySelector(`[data-i="${sp.i}"]`)?.getBoundingClientRect();
      const b = list.querySelector(`[data-i="${sp.j}"]`)?.getBoundingClientRect();
      if (!a || !b) return;
      const y1 = a.top + a.height / 2 - gb.top, y2 = b.top + b.height / 2 - gb.top;
      const x = Math.max(4, W - 10 - (k % 6) * 6);
      const d = sp.i === sp.j ? `M${W} ${y1 - 5} H${x} V${y1 + 5} H${W - 6}` : `M${W} ${y1} H${x} V${y2} H${W - 6}`;
      const ty = sp.i === sp.j ? y1 + 5 : y2;
      parts.push(s('path', { d }), s('polygon', { points: `${W},${ty} ${W - 7},${ty - 4} ${W - 7},${ty + 4}` }));
    });
    gutter.replaceChildren(...parts);
  };

  const refresh = async () => {
    const my = ++seq;
    const [found, { programTiles }] = await Promise.all([isa ? Promise.resolve(isa) : isaOf(), import('../isa/tiles')]);
    if (my !== seq) return;
    isa = found;
    if (!isa) { list.replaceChildren(h('p', { class: 'sb-sum' }, 'This language has no instructions to draw as tiles.')); return; }
    tiles = programTiles(isa, ce.value);
    draw();
  };
  new ResizeObserver(() => requestAnimationFrame(arrows)).observe(list);
  return { el, refresh: () => void refresh() };
}
