// Text that points at the circuit. An element of a step's text with data-show="hz fwdA" lights those instances of the
// scene's opening view while hovered or focused, and keeps them lit and framed when clicked (again: unpinned; Fit shows the whole circuit again). Names are
// instances of that view, `pin:a` for a pin, or a dotted path ('dp.alu') that opens the instances before the last and
// lights it there (on click only: hovering never navigates). litLine() says in words what the step's own highlight
// shows, each item itself pointing at its parts.

import { netlistOf, type ComponentDef } from '../../sim/types';
import type { Scene, Stage } from '../../view/stage';
import { h, icon } from '../dom';
import { reducedMotion } from '../motion';

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The definition a scene opens on. */
export function viewDef(scene: Scene): ComponentDef | undefined {
  let d: ComponentDef | undefined = scene.root;
  for (const n of scene.path ?? []) {
    d = d && netlistOf(d)?.instances.find((i) => i.name === n)?.def;
    if (!d) return undefined;
  }
  return d;
}

/** What a name in data-show refers to in `def` (undefined: nothing of that name). */
export function showTarget(def: ComponentDef, name: string): string | undefined {
  const nl = netlistOf(def);
  if (name.startsWith('pin:')) return def.ports.some((p) => p.name === name.slice(4)) ? `pin ${name.slice(4)}` : undefined;
  const [head, ...rest] = name.split('.');
  const inst = nl?.instances.find((i) => i.name === head);
  if (!inst) return undefined;
  if (!rest.length) return inst.label ?? inst.def.symbol?.label ?? inst.def.name;
  return showTarget(inst.def, rest.join('.'));
}

/** Where the circuit sits under the text (a phone): the stage is off screen, so a tap on a term needs a way down to it. */
const narrow = (): boolean => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 760px)').matches;

/**
 * A small dismissible chip over the foot of the screen: "Lit on the circuit ↓" scrolls to the stage, where the tapped
 * parts are lit. One at a time; it goes by itself after a few seconds.
 */
let chip: { el: HTMLElement; off: () => void } | null = null;
function litChip(stage: Stage): void {
  chip?.off();
  let timer = 0;
  // gone once the circuit is on screen: the chip would sit on its input bar
  // (a meaningful part of the stage, not all of it: a screen's height of it is more than the chip needs to give way)
  const io = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting && (e.intersectionRatio >= 0.15 || e.intersectionRect.height >= 160)) off(); }, { threshold: [0, 0.05, 0.1, 0.15, 0.25, 0.5] })
    : null;
  io?.observe(stage.el);
  const off = () => { clearTimeout(timer); io?.disconnect(); el.remove(); if (chip?.el === el) chip = null; };
  const go = h('button', { class: 'btn sm primary', type: 'button', onclick: () => {
    stage.el.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    off();
  } }, 'Lit on the circuit', icon('chevD', 16));
  const x = h('button', { class: 'btn sm ghost lit-chip-x', type: 'button', 'aria-label': 'Dismiss', onclick: off }, icon('close', 14));
  const el = h('div', { class: 'lit-chip', role: 'status' }, go, x);
  document.body.append(el);
  chip = { el, off };
  timer = window.setTimeout(off, 8000);
}

/** Wire every [data-show] element under `root` to `stage`. Returns a function that drops a pinned highlight. */
export function wireLooks(root: HTMLElement, stage: Stage): () => void {
  let pinned: HTMLElement | null = null;
  const home = () => stage.scene?.path ?? [];
  const names = (el: HTMLElement) => (el.dataset.show ?? '').split(/[\s,]+/).filter(Boolean);
  const apply = (list: string[], nav: boolean): void => {
    const deep = list.find((n) => n.includes('.') && !n.startsWith('pin:'));
    if (deep) {
      if (!nav) return;
      const parts = deep.split('.');
      stage.reveal([...home(), ...parts.slice(0, -1)], parts[parts.length - 1]);
      return;
    }
    if (!same(stage.path, home())) {
      if (!nav) return;
      stage.goTo(home());
    }
    stage.highlight(list, true);
    if (nav) stage.frame(list);
  };
  const rest = (): void => {
    if (pinned) return apply(names(pinned), false);
    if (same(stage.path, home())) stage.highlight(stage.scene?.highlight ?? []);
  };
  for (const el of root.querySelectorAll<HTMLElement>('[data-show]')) {
    el.classList.add('look');
    // a short name stays on one line; a phrase longer than that wraps (unbroken, it ran out of the text panel)
    if ((el.textContent ?? '').length > 28) el.classList.add('long');
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-pressed', 'false');
    el.title ||= narrow() ? 'Tap to light it on the circuit' : 'Hover to light it on the circuit; click to keep it lit';
    el.addEventListener('mouseenter', () => apply(names(el), false));
    el.addEventListener('focus', () => apply(names(el), false));
    el.addEventListener('mouseleave', rest);
    el.addEventListener('blur', rest);
    const toggle = () => {
      const was = pinned;
      pinned?.classList.remove('on');
      pinned?.setAttribute('aria-pressed', 'false');
      pinned = was === el ? null : el;
      if (pinned) {
        pinned.classList.add('on');
        pinned.setAttribute('aria-pressed', 'true');
        apply(names(pinned), true);
        if (narrow()) litChip(stage);
      } else { rest(); chip?.off(); }
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  }
  return () => { pinned?.classList.remove('on'); pinned = null; chip?.off(); };
}

/**
 * The step's highlight in words: instances grouped by what they are ("Hazard unit · 2 × Mux"), each group pointing
 * at its instances. `text` overrides it (Step.lit; '' hides it). Null when nothing is highlighted.
 */
export function litLine(scene: Scene, text?: string): HTMLElement | null {
  const hl = scene.highlight ?? [];
  if (text === '' || (!hl.length && text === undefined)) return null;
  const line = h('div', { class: 'lit-line' }, h('span', { class: 'lit-k' }, 'Lit on the circuit'));
  if (text !== undefined) {
    line.append(h('span', { html: text }));
    return line;
  }
  const def = viewDef(scene);
  const groups = new Map<string, string[]>();
  for (const n of hl) {
    const what = (def && showTarget(def, n)) ?? n;
    groups.set(what, [...(groups.get(what) ?? []), n]);
  }
  let first = true;
  for (const [what, ns] of groups) {
    if (!first) line.append(' · ');
    first = false;
    line.append(h('span', { 'data-show': ns.join(' '), title: ns.join(', ') }, ns.length > 1 ? `${ns.length} × ${what}` : what));
  }
  return line;
}
