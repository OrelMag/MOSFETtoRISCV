// The memory-map designer (File ▸ Memory map…, or `>` in the search): the chip's bus as 16 windows of 256 MiB, regions
// to drag (or move with the arrow keys), problems named as they arise, the decoder of the map as a chip and the map as
// a C header and a linker script. Edits a draft (editor/memmap.ts); Apply writes it to the chip as one undo step.

import '../styles/memmap.css';
import { logicDepth, stats } from '../sim/stats';
import { h, icon } from '../ui/dom';
import { saveFile } from '../view/image';
import { axiDecoder } from '../lib/axi';
import type { Editor } from './editor';
import {
  analyze, applyMap, cHeader, decoderDef, equation, fmtBytes, hex8, KINDS, linkerScript, moveTo, names, newRegion, nibbleOf, PALETTE, readMap, sameMap, WINDOW, WINDOWS,
  withoutRegion, withRegion, type Kind, type MemMap,
} from './memmap';
import { slug } from './model';

type Tab = 'map' | 'decoder' | 'export';
let open: HTMLElement | null = null;

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])';

/** Open the designer on the current chip (a toast says why not when it has no bus). */
export function openMemoryMap(ed: Editor): void {
  open?.remove();
  const chipId = ed.doc.id;
  const first = readMap(ed.doc);
  if ('error' in first) return void ed.toast(first.error, 'err');
  // the menu item that opened this is gone by now (activeElement is the body): Esc goes back to the File button
  const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : ed.actionAnchor('file');
  let onChip: MemMap = first;
  let draft: MemMap = first;
  let sel: number | null = null;
  let tab: Tab = 'map';
  let drag: { i: number; kind?: Kind; over: number | null; x: number; y: number; live: boolean } | null = null;
  let say = '';

  const body = h('div', { class: 'mp-body' });
  const live = h('div', { class: 'mp-live', role: 'status', 'aria-live': 'polite' });
  const close = () => {
    ov.remove();
    open = null;
    (opener?.isConnected ? opener : ed.view.svg)?.focus?.({ preventScroll: true });
  };
  const chipName = () => ed.ws.chips[chipId]?.name ?? 'this chip';
  const tabBtn = (t: Tab, label: string) => h('button', {
    type: 'button', role: 'tab', class: `mp-tab${tab === t ? ' on' : ''}`, 'aria-selected': String(tab === t),
    onclick: () => { tab = t; render(); },
  }, label);
  const head = h('header', { class: 'mp-head' });
  const ov = h('div', { class: 'sb-help mp-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Memory map' },
    h('div', { class: 'panel' }, head, body, live));
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => {
    // the editor's own keys must not fire behind the dialog
    e.stopPropagation();
    const typing = (e.target as HTMLElement).matches?.('input, select, textarea');
    if (e.key === 'Escape' && !typing) {
      e.preventDefault();
      if (drag) { drag = null; render(); } else close();
      return;
    }
    if (e.key === 'Tab') {
      const els = [...ov.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!els.length) return;
      const at = els.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? els[els.length - 1] : els[at - 1]) : (at < 0 || at === els.length - 1 ? els[0] : els[at + 1]);
      e.preventDefault();
      next.focus();
    }
  });

  const announce = (s: string) => { say = s; live.textContent = s; };
  const problemsOf = () => analyze(draft);
  const changed = () => !sameMap(draft, onChip);
  const select = (i: number | null) => { sel = i; render(); if (i !== null) body.querySelector<HTMLElement>(`[data-i="${i}"]`)?.focus(); };

  const apply = () => {
    if (ed.doc.id !== chipId) return void ed.toast('The chip this map belongs to is not the open one: switch back to it', 'err');
    let err = '';
    ed.edit((doc) => {
      try { return applyMap(doc, draft); } catch (e) { err = (e as Error).message; return doc; }
    });
    if (err) return void ed.toast(`Not applied: ${err}`, 'err');
    const again = readMap(ed.doc);
    if ('error' in again) return void ed.toast(again.error, 'err');
    onChip = draft = again;
    sel = null;
    announce('Applied to the bus');
    ed.toast('Memory map applied to the bus (Ctrl+Z undoes it)');
    render();
  };

  /** The decoder of the draft as a chip of the sandbox (one undo step), opened. */
  const openDecoder = () => void import('./remix').then(({ remixDef }) => {
    let err = '';
    ed.editWs((ws) => {
      const r = remixDef(ws, decoderDef(draft));
      if ('error' in r) { err = r.error; return ws; }
      return r.ws;
    });
    if (err) return void ed.toast(`The decoder could not be built: ${err}`, 'err');
    close();
    ed.toast('Opened the address decoder: a select line per region (Ctrl+Z removes it)');
  });

  // ---- the map tab ------------------------------------------------------------------------------------------

  const bar = (i: number) => {
    const r = draft.regions[i], k = KINDS[r.kind], a = problemsOf();
    const bad = a.problems.some((p) => p.regions.includes(i));
    const nm = names(draft)[i];
    const text = `${nm}${r.detail ? ` · ${r.detail}` : ''}`;
    const b = h('button', {
      type: 'button', class: `mp-bar k-${k.tone}${sel === i ? ' sel' : ''}${bad ? ' bad' : ''}${drag?.live && drag.i === i ? ' dragging' : ''}`, 'data-i': String(i),
      'aria-pressed': String(sel === i),
      'aria-label': `${nm} at ${hex8(r.base)}, ${fmtBytes(r.used)} used${bad ? ', has a problem' : ''}. Arrow keys move it, Delete removes it.`,
      title: k.about,
    }, h('span', { class: 'mp-bar-name' }, text), r.base % WINDOW === 0 ? h('small', null, `uses ${fmtBytes(r.used)} of 256 MiB`) : h('small', null, 'base off the window grid'));
    b.addEventListener('click', () => { if (!drag?.live) select(i); });
    b.addEventListener('keydown', (e) => {
      const n = nibbleOf(r);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const to = e.key === 'ArrowDown' ? n + 1 : e.key === 'ArrowUp' ? n - 1 : e.key === 'Home' ? 0 : WINDOWS - 1;
        if (!Number.isFinite(n)) return;
        draft = moveTo(draft, i, to);
        sel = i;
        const now = Math.floor(draft.regions[i].base / WINDOW);
        announce(`${nm} moved to ${hex8(draft.regions[i].base)}, window ${now}`);
        render();
        body.querySelector<HTMLElement>(`[data-i="${i}"]`)?.focus();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        draft = withoutRegion(draft, i);
        sel = null;
        announce(`${nm} removed`);
        render();
      }
    });
    startDrag(b, (x, y) => ({ i, over: null, x, y, live: false }));
    return b;
  };

  /** A press on `el` that moves more than a few pixels becomes a drag, dropped on the window row under the pointer. */
  function startDrag(el: HTMLElement, make: (x: number, y: number) => NonNullable<typeof drag>) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = make(e.clientX, e.clientY);
      const mv = (m: PointerEvent) => {
        if (!drag) return;
        if (!drag.live && Math.hypot(m.clientX - drag.x, m.clientY - drag.y) > 5) { drag.live = true; ov.classList.add('dragging'); }
        if (!drag.live) return;
        const row = document.elementFromPoint(m.clientX, m.clientY)?.closest<HTMLElement>('[data-n]');
        const over = row ? Number(row.dataset.n) : null;
        if (over !== drag.over) { drag.over = over; for (const r of body.querySelectorAll<HTMLElement>('[data-n]')) r.classList.toggle('drop', r.dataset.n === String(over)); }
      };
      const up = () => {
        window.removeEventListener('pointermove', mv);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        ov.classList.remove('dragging');
        const d = drag;
        drag = null;
        if (!d?.live || d.over === null) return void (d?.live && render());
        if (d.kind) {
          const r = newRegion(draft, d.kind, d.over, ed.doc.parts.map((p) => p.id));
          draft = { ...draft, regions: [...draft.regions, r] };
          sel = draft.regions.length - 1;
          announce(`${KINDS[d.kind].label} added at ${hex8(d.over * WINDOW)}`);
        } else {
          draft = moveTo(draft, d.i, d.over);
          sel = d.i;
          announce(`${names(draft)[d.i]} moved to ${hex8(d.over * WINDOW)}`);
        }
        render();
      };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  const palette = () => h('aside', { class: 'mp-side', 'aria-label': 'Region kinds' },
    h('div', { class: 'mp-cap' }, 'Drag onto the map'),
    ...PALETTE.map((k) => {
      const b = h('button', { type: 'button', class: `mp-kind k-${KINDS[k].tone}`, title: `${KINDS[k].about}. Click to put it in the first free window.` }, KINDS[k].label) as HTMLButtonElement;
      b.addEventListener('click', () => {
        if (drag?.live) return;
        const free = analyze(draft).free[0];
        if (free === undefined) return void ed.toast('No free window: remove a region first', 'err');
        const r = newRegion(draft, k, free, ed.doc.parts.map((p) => p.id));
        draft = { ...draft, regions: [...draft.regions, r] };
        announce(`${KINDS[k].label} added at ${hex8(r.base)}`);
        select(draft.regions.length - 1);
      });
      startDrag(b, (x, y) => ({ i: -1, kind: k, over: null, x, y, live: false }));
      return b;
    }),
    h('p', { class: 'mp-note' }, 'Each kind places the matching bus part (axiRam, axiFlashWindow, axiDram, a screen port, the I/O port) when you Apply. The DMA registers are the DMA engine itself: they can be moved, not added.'),
    h('p', { class: 'mp-note' }, 'Keyboard: Tab to a region, ↑ ↓ move it a window, Home / End to the ends, Delete removes it.'));

  const rows = () => {
    const a = problemsOf();
    const at = new Map<number, number[]>();
    draft.regions.forEach((r, i) => { if (r.base % WINDOW === 0 && r.base >= 0 && r.base < 2 ** 32) at.set(r.base / WINDOW, [...(at.get(r.base / WINDOW) ?? []), i]); });
    const stray = draft.regions.map((_, i) => i).filter((i) => !(draft.regions[i].base % WINDOW === 0 && draft.regions[i].base >= 0 && draft.regions[i].base < 2 ** 32));
    const out = Array.from({ length: WINDOWS }, (_, n) => {
      const here = at.get(n) ?? [];
      const free = !here.length;
      const cell = free
        ? h('span', { class: 'mp-gap' }, a.free.includes(n) ? 'gap → default slave (reads 0, writes ignored)' : '')
        : h('span', { class: `mp-cell${here.length > 1 ? ' overlap' : ''}` }, ...here.map((i) => bar(i)));
      return h('div', { class: `mp-row${free ? ' free' : ''}`, 'data-n': String(n) },
        h('span', { class: 'mp-addr' }, hex8(n * WINDOW)), cell,
        h('span', { class: 'mp-code' }, here.length ? `s${[...draft.regions].sort((x, y) => x.base - y.base).indexOf(draft.regions[here[0]])} · ${n.toString(2).padStart(4, '0')}${here.length > 1 ? ` ×${here.length}` : ''}` : '—'));
    });
    const extra = stray.length ? h('div', { class: 'mp-row stray' }, h('span', { class: 'mp-addr' }, 'off grid'), h('span', { class: 'mp-cell' }, ...stray.map((i) => bar(i))), h('span', { class: 'mp-code' }, '—')) : null;
    const def = h('div', { class: 'mp-row' }, h('span', { class: 'mp-addr' }, 'any other'), h('span', { class: 'mp-cell' }, h('span', { class: 'mp-bar k-dev static' }, h('span', { class: 'mp-bar-name' }, `Default slave (always last) · ${draft.fallback.id}`))), h('span', { class: 'mp-code' }, `s${draft.regions.length}`));
    return h('div', { class: 'mp-rows', role: 'group', 'aria-label': 'Address windows' }, ...out, ...(extra ? [extra] : []), def);
  };

  const problems = () => {
    const a = problemsOf();
    const n = a.problems.length;
    return h('section', { class: `mp-probs${n ? ' bad' : ''}`, 'aria-label': 'Problems' },
      h('strong', null, n ? `${n} problem${n > 1 ? 's' : ''}` : '✓ No problems'),
      ...a.problems.map((p) => h('span', null, p.text)),
      h('span', { class: 'mp-muted' }, `${a.free.length} window${a.free.length === 1 ? ' is' : 's are'} free: the default slave answers there (reads 0, writes dropped). Windows are powers of two and aligned by construction: the bus decodes a[31:28] only, so there is no finer split.`));
  };

  const panel = () => {
    const a = problemsOf(), n = a.problems.length;
    const r = sel !== null ? draft.regions[sel] : null;
    const kids: (Node | null)[] = [];
    if (r && sel !== null) {
      const i = sel, k = KINDS[r.kind];
      const code = Math.floor(r.base / WINDOW);
      const base = h('input', { id: 'mp-base', class: 'mp-in', value: hex8(r.base), spellcheck: false, autocomplete: 'off' }) as HTMLInputElement;
      base.addEventListener('change', () => {
        const v = Number(base.value.replace(/_/g, '').trim());
        if (!base.value.trim() || !Number.isInteger(v) || v < 0 || v > 0xffff_ffff) { ed.toast('Not an address: write it as 0x5000_0000 (0 … 0xffff_ffff)', 'err'); base.value = hex8(r.base); return; }
        draft = withRegion(draft, i, { base: v });
        announce(`${names(draft)[i]} base ${hex8(v)}`);
        render();
      });
      const nd = problemsOf().problems.length ? null : decoderStats(draft);
      kids.push(
        h('div', { class: 'mp-cap' }, `Selected · ${names(draft)[i]}`),
        h('label', { for: 'mp-base' }, 'Base'), base,
        h('label', { for: 'mp-size' }, 'Window'),
        h('input', { id: 'mp-size', class: 'mp-in', value: `256 MiB (uses ${fmtBytes(r.used)})`, readonly: true }),
        h('div', { class: 'mp-eq' },
          h('div', null, 'match = ', h('b', null, Number.isInteger(code) && code >= 0 && code < 16 ? equation(code) : '—')),
          h('div', null, nd ? `decoder: ${draft.regions.length + 1} select lines, ${nd.nands} NANDs, depth ${nd.depth}` : 'decoder: fix the problems first'),
          h('div', null, 'one-hot select → bus grant')),
        h('div', { class: 'mp-pair' },
          h('button', { type: 'button', class: 'btn sm', onclick: () => { draft = moveTo(draft, i, code - 1); announce(`${names(draft)[i]} moved to ${hex8(draft.regions[i].base)}`); render(); }, disabled: !(code > 0) }, '↑ Up a window'),
          h('button', { type: 'button', class: 'btn sm', onclick: () => { draft = moveTo(draft, i, code + 1); announce(`${names(draft)[i]} moved to ${hex8(draft.regions[i].base)}`); render(); }, disabled: !(code < 15) }, '↓ Down a window')),
        h('button', { type: 'button', class: 'mp-act', onclick: openDecoder, disabled: n > 0, title: n ? 'Fix the problems first' : 'The decoder as a chip of your own: open it, drill into it, simulate it' }, 'Open the decoder in the sandbox'),
        h('button', { type: 'button', class: 'mp-act', onclick: () => { tab = 'export'; render(); } }, 'Export: C header + linker script'),
        r.kind === 'dma' ? null : h('button', { type: 'button', class: 'mp-act', onclick: () => { draft = withoutRegion(draft, i); sel = null; announce(`${names(draft)[i] ?? 'Region'} removed`); render(); } }, 'Remove from the map'),
        h('p', { class: 'mp-note' }, k.about + '.'));
    } else {
      kids.push(h('div', { class: 'mp-cap' }, 'Selected · nothing'),
        h('p', { class: 'mp-note' }, 'Click a region, or Tab to it, to see its base, window and match equation here.'),
        h('button', { type: 'button', class: 'mp-act', onclick: openDecoder, disabled: n > 0 }, 'Open the decoder in the sandbox'),
        h('button', { type: 'button', class: 'mp-act', onclick: () => { tab = 'export'; render(); } }, 'Export: C header + linker script'));
    }
    kids.push(h('div', { class: 'mp-grow' }),
      h('p', { class: 'mp-note' }, 'The golden model of chapter 38 (bus/model.ts BusModel) takes the same map: busMapOf(map) is its `map` option, and the tests run this example with a moved region against it. The CPU drawer does not follow bus cores.'),
      changed() ? h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { draft = onChip; sel = null; announce('Reset to the chip'); render(); } }, 'Reset to the chip') : null,
      h('button', { type: 'button', class: 'btn primary mp-apply', disabled: n > 0 || !changed(), onclick: apply },
        n ? `Apply to the bus (fix ${n} problem${n > 1 ? 's' : ''} first)` : changed() ? 'Apply to the bus' : 'Nothing to apply'));
    return h('aside', { class: 'mp-side right', 'aria-label': 'Selected region' }, ...kids);
  };

  // ---- the other tabs --------------------------------------------------------------------------------------

  const decoderTab = () => {
    const a = problemsOf();
    if (a.problems.length) return h('div', { class: 'mp-pane' }, problems());
    const order = [...draft.regions].sort((x, y) => x.base - y.base), nm = names(draft);
    const s = decoderStats(draft);
    const bus = stats(axiDecoder([...order.map(nibbleOf), 0xf]));
    return h('div', { class: 'mp-pane' },
      h('p', null, h('b', null, `${s.nands} NANDs, ${s.depth} gate delays`), `: one 4-bit comparator per region on a[31:28] (the bus's own, lib/axi.ts nibbleSelects), and the default slave's line when none matches. The decoder inside the bus adds a 32-bit mux between AW and AR addresses and a register that holds the choice during a transaction: ${bus.nands} NANDs in all.`),
      h('div', { class: 'tablewrap mp-table' }, h('table', null,
        h('thead', null, h('tr', null, ...['Slave', 'Region', 'Window', 'a[31:28]', 'Match', 'Select line'].map((t) => h('th', null, t)))),
        h('tbody', null, ...order.map((r, k) => h('tr', null,
          h('td', null, `s${k}`), h('td', null, nm[draft.regions.indexOf(r)]), h('td', null, hex8(r.base)), h('td', null, h('code', null, nibbleOf(r).toString(2).padStart(4, '0'))),
          h('td', null, h('code', null, equation(nibbleOf(r)))), h('td', null, h('code', null, `sel${k}`)))),
          h('tr', null, h('td', null, `s${order.length}`), h('td', null, 'Default slave'), h('td', null, 'the rest'), h('td', null, '—'), h('td', null, 'no other line is 1'), h('td', null, h('code', null, `sel${order.length}`)))))),
      h('div', { class: 'sb-btns' }, h('button', { type: 'button', class: 'btn sm', onclick: openDecoder }, 'Open the decoder in the sandbox')));
  };

  const exportTab = () => {
    const a = problemsOf();
    if (a.problems.length) return h('div', { class: 'mp-pane' }, problems());
    const name = chipName(), header = cHeader(draft, name), ld = linkerScript(draft, name);
    const copy = (t: string) => void navigator.clipboard?.writeText(t).then(() => ed.toast('Copied'), () => ed.toast('The browser would not copy', 'err'));
    const block = (title: string, file: string, text: string, type: string) => h('section', { class: 'mp-export', 'aria-label': title },
      h('div', { class: 'mp-export-head' }, h('b', null, title),
        h('button', { type: 'button', class: 'btn sm', onclick: () => copy(text) }, 'Copy'),
        h('button', { type: 'button', class: 'btn sm', onclick: () => saveFile(file, text, type) }, icon('download', 13), `Save ${file}`)),
      h('pre', { tabindex: '0' }, text));
    return h('div', { class: 'mp-pane' },
      h('p', { class: 'mp-muted' }, `The map as the dialog shows it (not necessarily what the chip has yet)${changed() ? ': it differs from the chip, Apply to write it' : ''}.`),
      h('div', { class: 'mp-exports' }, block('C header', `${slug(name)}_map.h`, header, 'text/x-c'), block('Linker script MEMORY block', `${slug(name)}_memory.ld`, ld, 'text/plain')));
  };

  function render() {
    head.replaceChildren(
      h('h1', null, icon('layers', 18), 'Memory map'),
      h('span', { class: 'mp-sub' }, `of chip “${chipName()}” · decoded on a[31:28] · 16 windows of 256 MiB`),
      h('span', { class: 'mp-grow' }),
      h('div', { class: 'mp-tabs', role: 'tablist', 'aria-label': 'View' }, tabBtn('map', 'Map'), tabBtn('decoder', 'Decoder'), tabBtn('export', 'Export')),
      h('button', { type: 'button', class: 'btn ghost icon-only', 'aria-label': 'Close', title: 'Close (Esc)', onclick: close }, icon('close', 16)));
    body.classList.toggle('plain', tab !== 'map');
    if (tab === 'map') body.replaceChildren(palette(), h('main', { class: 'mp-main' }, rows(), problems()), panel());
    else body.replaceChildren(h('main', { class: 'mp-main' }, tab === 'decoder' ? decoderTab() : exportTab()), panel());
    live.textContent = say;
    // a render replaces the focused button: keep the focus (and so Esc and Tab) inside the dialog
    if (!ov.contains(document.activeElement)) ov.querySelector<HTMLElement>('.mp-tab.on')?.focus();
  }

  open = ov;
  ed.el.append(ov);
  render();
  (ov.querySelector('.mp-tab.on') as HTMLElement | null)?.focus();
}

/** NANDs and depth of the draft's decoder chip (null depth reads as 0: it is combinational). */
const statCache = new Map<string, { nands: number; depth: number }>();
function decoderStats(map: MemMap): { nands: number; depth: number } {
  const key = map.regions.map(nibbleOf).sort((a, b) => a - b).join(',');
  let r = statCache.get(key);
  if (!r) { const d = decoderDef(map); statCache.set(key, (r = { nands: stats(d).nands, depth: logicDepth(d) ?? 0 })); }
  return r;
}
