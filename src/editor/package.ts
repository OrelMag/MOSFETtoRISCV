// "Package as chip…": the Digital-Logic-Sim moment. Every circuit in the sandbox already is a
// chip (its pins are its ports); packaging names it, gives it a colour and notes, and shapes the
// box it will be when placed: the face editor drags pins along an edge or onto another side,
// resizes the box from its corner, and puts the chip's displays on it, live (face.ts; the
// automatic box until something is moved). "Save & new circuit" then starts the next one, the
// packaged chip waiting in the palette under My chips.

import { symbolGeom, type Vec } from '../sim/geometry';
import type { ComponentDef } from '../sim/types';
import { h, icon, s } from '../ui/dom';
import { drawSymbol } from '../view/symbols';
import { relations } from './chips';
import { drawFace, type FaceEls, paintFace } from './dispface';
import { type Editor, registerToolbarAction } from './editor';
import {
  applyFace, autoLayout, type FaceItem, faceItems, isEmptyFace, itemTitle, movePin, pathKey, pinToSide, placeDisplay, resizeFace,
  type ResolvedFace, resolveFace, SCALE_MAX, SCALE_MIN, setFaceOf, shownBox, SIDES, toggleDisplay,
} from './face';
import type { ChipDoc, FaceDoc, FaceSide, PinDoc } from './model';

/** Hues offered as swatches (any other is a slider away). */
const HUES = [250, 210, 180, 150, 100, 45, 20, 330];

/** The compiled def as it will look with this name and hue (the preview only). */
function previewDef(def: ComponentDef, name: string, hue: number): ComponentDef {
  return { ...def, name, symbol: { ...def.symbol, label: def.symbol.label === '' ? '' : name, color: hue } };
}

/** Short wire stubs at each port of a symbol (the preview's "this is where wires attach"). */
function stubs(def: ComponentDef): SVGPathElement[] {
  const g = symbolGeom(def);
  return Object.values(g.ports).map((p) => {
    const [x, y] = p.pos;
    const d = p.exit === 'left' ? [-1.6, 0] : p.exit === 'right' ? [1.6, 0] : p.exit === 'up' ? [0, -1.6] : [0, 1.6];
    return s('path', { d: `M${x},${y} l${d[0]},${d[1]}`, class: 'wire sb-pack-stub' });
  });
}

/** The packaged symbol, with a short stub at each port, sized to fit. */
export function symbolPreview(def: ComponentDef): SVGSVGElement {
  const g = symbolGeom(def);
  const svg = s('svg', { class: 'schematic sb-pack-svg', viewBox: `${-3} ${-1.5} ${g.w + 6} ${g.h + 3}`, role: 'img', 'aria-label': `${def.name} symbol` });
  svg.append(...stubs(def), drawSymbol(def));
  return svg;
}

type FaceSel = { k: 'pin'; id: string } | { k: 'disp'; key: string } | null;
type Drag =
  | { k: 'pin'; id: string; face: FaceDoc | undefined; r: ResolvedFace }
  | { k: 'size'; face: FaceDoc | undefined; r: ResolvedFace; from: Vec }
  | { k: 'move'; path: string[]; face: FaceDoc; at: Vec; from: Vec; max: Vec }
  | { k: 'scale'; path: string[]; face: FaceDoc; at: Vec; w: number; scale: number; from: Vec };

const SIDE_NAME: Record<FaceSide, string> = { left: 'Left', top: 'Top', right: 'Right', bottom: 'Bottom' };
const along = (side: FaceSide) => side === 'left' || side === 'right';

export function packageDialog(ed: Editor): void {
  ed.el.querySelector('.sb-pack')?.remove();
  const doc = ed.doc;
  const compiled = ed.compiled;
  const def = compiled.def;
  let hue = doc.hue ?? 250;
  let face: FaceDoc | undefined = doc.face;
  let sel: FaceSel = null;
  let drag: Drag | null = null;
  /** The viewBox, held still while dragging (the box may grow under the pointer). */
  let frame: { x: number; y: number; w: number; h: number } | null = null;

  // The pins in port order (compile.ts), and what the face may show.
  const pins = def.ports.map((p) => doc.pins.find((q) => q.name === p.name)).filter((p): p is PinDoc => !!p);
  const items: FaceItem[] = faceItems(doc.parts.flatMap((p) => {
    const d = ed.defOf(p);
    return d ? [{ doc: p, def: d }] : [];
  }), (id) => compiled.netOfEnd.get(`p:${id}.a`) ?? -1);
  const itemByKey = new Map(items.map((it) => [pathKey(it.path), it]));

  const name = h('input', { type: 'text', value: doc.name, spellcheck: 'false', 'aria-label': 'Chip name', maxlength: '40' }) as HTMLInputElement;
  const notes = h('textarea', { rows: '3', placeholder: 'What it does, how to use it…', 'aria-label': 'Notes' }, doc.notes ?? '') as HTMLTextAreaElement;
  const range = h('input', { type: 'range', min: '0', max: '359', value: String(hue), 'aria-label': 'Colour (hue)' }) as HTMLInputElement;
  const swatches = h('div', { class: 'sb-swatches', role: 'radiogroup', 'aria-label': 'Colour' });
  const showName = h('input', { type: 'checkbox', checked: !face?.noLabel }) as HTMLInputElement;
  const dispList = h('div', { class: 'sb-face-list' });
  const selBox = h('div', { class: 'sb-face-sel' });
  const sizeText = h('span', { class: 'sb-face-size' });
  const autoBtn = h('button', { class: 'btn sm ghost', title: 'Inputs on the left, outputs on the right, in canvas order; sized to fit (displays stay)' }, 'Auto layout') as HTMLButtonElement;
  const svg = s('svg', { class: 'schematic sb-face-svg', role: 'img', 'aria-label': 'Chip face: drag pins, the corner and displays', tabindex: '0' });
  const warn = h('div', { class: 'sb-pack-warn' });

  let r: ResolvedFace = resolveFace(face, pins, doc.name, items);
  let faceEls: FaceEls[] = [];
  let shownDef: ComponentDef = def;

  /** The chip as placed: compiled def with the draft face, name and hue (displays registered for drawFace). */
  const build = () => {
    const nm = name.value.trim() || doc.name;
    r = resolveFace(face, pins, nm, items);
    shownDef = previewDef(applyFace(def, pins, r, nm), nm, hue);
    setFaceOf(shownDef, { displays: r.displays });
  };

  const toSvg = (e: PointerEvent): Vec => {
    const m = svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  };

  /** The displays' values: the chip's own simulation (its root is this chip). */
  const livePaint = () => {
    const sim = ed.sim.sim;
    paintFace(faceEls, sim, sim?.design.root ?? null, ed.view.radix);
  };

  const drawFaceSvg = () => {
    const g = symbolGeom(shownDef), { w, h: bh } = g;
    const vb = frame ?? (() => {
      const vw = Math.max(w + 10, 26), vh = Math.max(bh + 8, 16);
      return { x: w / 2 - vw / 2, y: bh / 2 - vh / 2, w: vw, h: vh };
    })();
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    const root = s('g', null);
    root.append(...stubs(shownDef), drawSymbol(shownDef));
    const fg = s('g', null);
    faceEls = drawFace(fg, shownDef, false) ?? [];
    root.append(fg);
    // Free spots on every side (where a dragged pin can land).
    if (drag?.k === 'pin') {
      const id = drag.id;
      const taken = new Set([...r.pins].filter(([q]) => q !== id).map(([, p]) => `${p.side}:${p.at}`));
      const dots = s('g', { class: 'sb-face-slots' });
      for (const side of SIDES) {
        const len = along(side) ? bh : w;
        for (let at = 1; at < len; at++) {
          if (taken.has(`${side}:${at}`)) continue;
          const [x, y] = side === 'left' ? [0, at] : side === 'right' ? [w, at] : side === 'top' ? [at, 0] : [at, bh];
          dots.append(s('circle', { cx: x, cy: y, r: 0.12 }));
        }
      }
      root.append(dots);
    }
    // Displays: an outline to grab, a scale handle on the selected one.
    for (const d of r.displays) {
      const key = pathKey(d.path), b = shownBox(d, w, bh, false), on = sel?.k === 'disp' && sel.key === key;
      root.append(s('rect', { class: `sb-face-disp${on ? ' on' : ''}`, x: b.x - 0.15, y: b.y - 0.15, width: b.w + 0.3, height: b.h + 0.3, rx: 0.25, 'data-disp': key },
        s('title', null, `${itemTitle(d)} ${d.path.join('.')}: drag to move`)));
      if (on) root.append(s('rect', { class: 'sb-face-handle', x: b.x + b.w - 0.25, y: b.y + b.h - 0.25, width: 0.6, height: 0.6, 'data-scale': key },
        s('title', null, 'Drag to scale')));
    }
    // Pins: a knob at each port to drag.
    for (const p of pins) {
      const pg = g.ports[p.name];
      if (!pg) continue;
      const on = sel?.k === 'pin' && sel.id === p.id;
      root.append(s('circle', { class: `sb-face-pin${on ? ' on' : ''}`, cx: pg.pos[0], cy: pg.pos[1], r: 0.45, 'data-pin': p.id },
        s('title', null, `${p.name}: drag along an edge or onto another side`)));
    }
    root.append(s('rect', { class: 'sb-face-handle sb-face-corner', x: w - 0.3, y: bh - 0.3, width: 0.6, height: 0.6, 'data-size': '1' },
      s('title', null, 'Drag to resize the box')));
    svg.replaceChildren(root);
    sizeText.textContent = `${w} × ${bh}`;
    autoBtn.disabled = !face || (face.w === undefined && face.h === undefined && !face.pins);
    livePaint();
  };

  const drawList = () => {
    const shown = new Set(r.displays.map((d) => pathKey(d.path)));
    dispList.replaceChildren(...(items.length ? items.map((it) => {
      const key = pathKey(it.path);
      const cb = h('input', { type: 'checkbox', checked: shown.has(key) }) as HTMLInputElement;
      cb.addEventListener('change', () => {
        face = toggleDisplay(face, r, it, cb.checked);
        sel = cb.checked ? { k: 'disp', key } : null;
        paint();
      });
      const where = it.path.length > 1 ? h('small', null, `in ${it.path.slice(0, -1).join('.')}`) : null;
      return h('label', { class: 'sb-face-item' }, cb, h('span', null, `${itemTitle(it)} `, h('code', null, it.path[it.path.length - 1])), where);
    }) : [h('p', { class: 'sb-sum' }, 'No displays in this chip yet. LEDs, digits, value boxes, buzzers, consoles, screens and switch banks placed inside it, or shown on the box of a chip placed inside it, can go on its box.')]));
  };

  const drawSel = () => {
    if (sel?.k === 'pin') {
      const id = sel.id, p = doc.pins.find((q) => q.id === id), at = r.pins.get(id);
      if (!p || !at) return void selBox.replaceChildren();
      selBox.replaceChildren(h('b', null, 'Pin ', h('code', null, p.name)),
        h('div', { class: 'sb-face-sides', role: 'radiogroup', 'aria-label': 'Side' }, SIDES.map((side) => h('button', {
          class: `btn sm${at.side === side ? ' on' : ''}`, role: 'radio', 'aria-checked': String(at.side === side),
          onclick: () => { face = pinToSide(face, r, id, side); paint(); },
        }, SIDE_NAME[side]))),
        h('p', { class: 'sb-sum' }, `${at.at} from the ${along(at.side) ? 'top' : 'left'}; the arrow keys nudge it.`));
    } else if (sel?.k === 'disp') {
      const key = sel.key, d = r.displays.find((q) => pathKey(q.path) === key);
      if (!d) return void selBox.replaceChildren();
      const sc = h('input', { type: 'range', min: String(SCALE_MIN * 100), max: String(SCALE_MAX * 100), step: '5', value: String(Math.round(d.scale * 100)), 'aria-label': 'Scale' }) as HTMLInputElement;
      const pct = h('span', { class: 'sb-face-pct' }, `${Math.round(d.scale * 100)}%`);
      sc.addEventListener('input', () => {
        face = placeDisplay(face!, d.path, [d.x, d.y], Number(sc.value) / 100);
        pct.textContent = `${sc.value}%`;
        build();
        drawFaceSvg();
      });
      sc.addEventListener('change', paint);
      selBox.replaceChildren(h('b', null, `${itemTitle(d)} `, h('code', null, d.path.join('.'))),
        h('div', { class: 'sb-face-scale' }, h('span', null, 'Scale'), sc, pct),
        h('button', { class: 'btn sm ghost', onclick: () => { face = toggleDisplay(face, r, itemByKey.get(key) ?? d, false); sel = null; paint(); } }, icon('close', 12), 'Take off the box'));
    } else selBox.replaceChildren(h('p', { class: 'sb-sum' }, 'Click a pin or a display on the box to change it.'));
  };

  const paint = () => {
    build();
    for (const b of swatches.children) b.classList.toggle('on', Number((b as HTMLElement).dataset.hue) === hue);
    drawFaceSvg();
    drawList();
    drawSel();
    const nm = name.value.trim() || doc.name;
    const w: string[] = [];
    if (!doc.pins.length) w.push('No pins yet: a chip talks to its parent only through its input and output pins.');
    const errs = ed.diags.filter((d) => d.level === 'error').length;
    if (errs) w.push(`${errs} problem${errs > 1 ? 's' : ''} in this circuit: chips that place it will show ${errs > 1 ? 'them' : 'it'} too.`);
    if (Object.values(ed.ws.chips).some((c) => c.id !== doc.id && c.name === nm)) w.push(`Another chip is already called “${nm}”.`);
    if (r.missing.length) w.push(`No ${r.missing.join(', ')} in the chip any more: left off the box.`);
    warn.replaceChildren(...w.map((t) => h('p', null, t)));
  };

  for (const v of HUES) {
    swatches.append(h('button', { class: 'sb-swatch', style: `--chip-h:${v}`, 'data-hue': String(v), role: 'radio', title: `Hue ${v}`, 'aria-label': `Hue ${v}`,
      onclick: () => { hue = v; range.value = String(v); paint(); } }));
  }
  range.addEventListener('input', () => { hue = Number(range.value); paint(); });
  name.addEventListener('input', paint);
  showName.addEventListener('change', () => {
    const f: FaceDoc = { ...face };
    if (showName.checked) delete f.noLabel;
    else f.noLabel = true;
    face = isEmptyFace(f) ? undefined : f;
    paint();
  });
  autoBtn.addEventListener('click', () => { face = autoLayout(face); paint(); });

  // ---- the face editor's pointer: pins, the corner, displays ----
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const t = e.target as Element, at = toSvg(e);
    const pin = t.getAttribute('data-pin'), disp = t.getAttribute('data-disp'), scale = t.getAttribute('data-scale');
    const box = svg.viewBox.baseVal;
    frame = { x: box.x, y: box.y, w: box.width, h: box.height };
    const shown = (key: string) => r.displays.find((q) => pathKey(q.path) === key);
    if (pin) {
      sel = { k: 'pin', id: pin };
      drag = { k: 'pin', id: pin, face, r };
    } else if (t.hasAttribute('data-size')) drag = { k: 'size', face, r, from: at };
    else if (scale && face && shown(scale)) {
      const d = shown(scale)!;
      drag = { k: 'scale', path: d.path, face, at: [d.x, d.y], w: d.crop.w * d.scale, scale: d.scale, from: at };
    } else if (disp && face && shown(disp)) {
      const d = shown(disp)!;
      sel = { k: 'disp', key: disp };
      drag = { k: 'move', path: d.path, face, at: [d.x, d.y], from: at, max: [Math.max(0, r.w - d.crop.w * d.scale), Math.max(0, r.h - d.crop.h * d.scale)] };
    } else {
      sel = null;
      frame = null;
      paint();
      return;
    }
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    svg.focus({ preventScroll: true });
    paint();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [x, y] = toSvg(e);
    if (drag.k === 'pin') {
      const { w, h: bh } = drag.r;
      // The nearest edge, the nearest grid point along it.
      const dist: Record<FaceSide, number> = { left: Math.abs(x), right: Math.abs(x - w), top: Math.abs(y), bottom: Math.abs(y - bh) };
      const side = SIDES.reduce((a, b) => (dist[b] < dist[a] ? b : a));
      face = movePin(drag.face ?? {}, drag.r, drag.id, side, along(side) ? y : x);
    } else if (drag.k === 'size') {
      face = resizeFace(drag.face ?? {}, drag.r, drag.r.w + x - drag.from[0], drag.r.h + y - drag.from[1]);
    } else if (drag.k === 'move') {
      const nx = Math.max(0, Math.min(drag.max[0], drag.at[0] + x - drag.from[0]));
      const ny = Math.max(0, Math.min(drag.max[1], drag.at[1] + y - drag.from[1]));
      face = placeDisplay(drag.face, drag.path, [nx, ny]);
    } else {
      const k = Math.max(0.1, (drag.w + x - drag.from[0]) / drag.w);
      face = placeDisplay(drag.face, drag.path, drag.at, drag.scale * k);
    }
    build();
    drawFaceSvg();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    frame = null;
    paint();
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('keydown', (e) => {
    const step: Record<string, Vec> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const v = step[e.key];
    if (!v || !sel) return;
    e.preventDefault();
    if (sel.k === 'pin') {
      const at = r.pins.get(sel.id);
      if (!at) return;
      const d = along(at.side) ? v[1] : v[0];
      if (d) face = movePin(face ?? {}, r, sel.id, at.side, at.at + d);
    } else {
      const key = sel.key, d = r.displays.find((q) => pathKey(q.path) === key);
      if (d && face) face = placeDisplay(face, d.path, [Math.max(0, d.x + v[0] / 2), Math.max(0, d.y + v[1] / 2)]);
    }
    paint();
  });

  const { usedBy } = relations(ed.ws, doc.id);

  const commit = (): boolean => {
    const nm = name.value.trim();
    if (!nm) {
      name.focus();
      return false;
    }
    const nt = notes.value.trim();
    // A face that only says what the automatic one does is not kept.
    const f = face && !isEmptyFace(face) ? face : undefined;
    ed.edit((d): ChipDoc => {
      if (d.name === nm && d.hue === hue && (d.notes ?? '') === nt && JSON.stringify(d.face) === JSON.stringify(f)) return d;
      const n: ChipDoc = { ...d, name: nm, hue };
      if (nt) n.notes = nt;
      else delete n.notes;
      if (f) n.face = f;
      else delete n.face;
      return n;
    });
    return true;
  };
  const close = () => {
    ed.paintHooks.delete(livePaint);
    ov.remove();
    ed.view.svg.focus({ preventScroll: true });
  };
  const save = (fresh: boolean) => {
    if (!commit()) return;
    const nm = ed.doc.name;
    close();
    if (fresh) {
      ed.newChip();
      ed.toast(`“${nm}” is under My chips: drag it in`);
    } else ed.toast(`Packaged “${nm}”${usedBy.length ? `: ${usedBy.length} chip${usedBy.length > 1 ? 's' : ''} using it follow` : ': find it under My chips'}`);
  };

  const ov = h('div', { class: 'sb-help sb-pack', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Package as chip', onclick: (e: Event) => { if (e.target === ov) close(); } },
    h('div', { class: 'panel' },
      h('div', { class: 'sb-help-head' }, h('h3', null, 'Package as chip'), h('button', { class: 'btn ghost icon-only', 'aria-label': 'Close', onclick: close }, icon('close', 16))),
      h('p', { class: 'sb-sum' }, 'Placed in another chip, this circuit becomes the box below: only its pins and the displays you pick show. Drag pins along an edge or onto another side, drag the corner to resize. It stays editable: every chip that uses it follows.'),
      h('div', { class: 'sb-pack-grid' },
        h('div', { class: 'sb-pack-form' },
          h('label', { class: 'sb-row' }, h('span', null, 'Name'), name),
          h('div', { class: 'sb-row' }, h('span', null, 'Colour'), h('div', null, swatches, range)),
          h('label', { class: 'sb-row' }, h('span', null, 'Notes'), notes),
          h('label', { class: 'sb-face-check' }, showName, 'Show the name on the box'),
          h('div', { class: 'sb-face-sec' }, h('b', null, 'Displays on the box'), dispList),
          h('div', { class: 'sb-face-sec' }, selBox)),
        h('div', { class: 'sb-pack-side' },
          h('div', { class: 'sb-face' }, h('div', { class: 'sb-face-bar' }, h('span', null, 'Box'), sizeText, h('span', { class: 'sp' }), autoBtn), svg),
          h('p', { class: 'sb-sum' }, 'Pins sit on grid points (wires snap to them); a pin dropped on another swaps with it. The box never shrinks below its pins and displays; the name moves out of the displays’ way, or leaves the box when there is no room.'))),
      warn,
      h('div', { class: 'sb-btns sb-pack-btns' },
        h('button', { class: 'btn sm ghost', onclick: close }, 'Cancel'),
        h('button', { class: 'btn sm', title: 'Save and keep editing it', onclick: () => save(false) }, icon('check', 14), 'Save'),
        h('button', { class: 'btn sm primary', title: 'Save, then start a new empty circuit (the packaged chip is in the palette)', onclick: () => save(true) }, icon('plus', 14), 'Save & new circuit'))));
  ov.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text') save(false);
  });
  ed.el.append(ov);
  ed.paintHooks.add(livePaint);
  paint();
  name.focus();
  name.select();
}

registerToolbarAction({
  id: 'package', title: 'Package as chip… (name, colour, the box: pins and displays)', icon: 'chip', label: 'Package', order: 60,
  run: (ed) => packageDialog(ed),
});
