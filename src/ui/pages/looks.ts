// Text that points at the circuit. An element of a step's text with data-show="hz fwdA" lights those instances of the
// scene's opening view while hovered or focused, and keeps them lit and framed when clicked (again: unpinned; Fit shows the whole circuit again). Names are
// instances of that view, `pin:a` for a pin, or a dotted path ('dp.alu') that opens the instances before the last and
// lights it there (on click only: hovering never navigates). litLine() says in words what the step's own highlight
// shows, each item itself pointing at its parts.

import { netlistOf, type ComponentDef } from '../../sim/types';
import type { Scene, Stage } from '../../view/stage';
import { h } from '../dom';

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
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-pressed', 'false');
    el.title ||= 'Hover to light it on the circuit; click to keep it lit';
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
      } else rest();
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  }
  return () => { pinned?.classList.remove('on'); pinned = null; };
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
