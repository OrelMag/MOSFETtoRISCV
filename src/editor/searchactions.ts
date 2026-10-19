// The editor's actions in the search box (`>` in the sandbox and on a level screen): every toolbar action
// this editor shows (its registry: registerToolbarAction), run / pause and a new chip, while the editor is
// mounted. Disabled actions are left out.

import { keyDef } from '../ui/keys';
import type { NavItem } from '../ui/chapternav';
import { here, registerActions } from '../ui/searchsources';
import { type Editor, registerEditorPlugin } from './editor';

/** A toolbar title's own shortcut, "Undo (Ctrl+Z)" → title "Undo", keys ["Ctrl Z"]. */
function split(title: string): { name: string; keys?: string[] } {
  const m = /^(.*?)\s*\(([^()]+)\)$/.exec(title);
  if (!m || !/^(Ctrl|⌘|Shift|Alt|[A-Z?/.\d]|F\d+|Esc)(\+|$)/.test(m[2])) return { name: title };
  return { name: m[1], keys: [m[2].replace(/\+/g, ' ')] };
}

const caps = (id: string) => keyDef(id)?.caps.filter((c) => c !== '·' && c !== '…');

function actionsOf(ed: Editor): NavItem[] {
  const where = ed.level ? 'Level' : 'Sandbox';
  const out: NavItem[] = [here({ kind: 'action', id: 'sb.run', title: 'Run / pause', sub: `${where} · the simulation`, keys: caps('sb.run'), run: () => ed.toggleRun() })];
  for (const a of ed.barActions()) {
    if (a.enabled && !a.enabled(ed)) continue;
    const { name, keys } = split(a.title);
    const title = a.menu ?? a.label ?? name;
    const on = a.active?.(ed);
    out.push({
      kind: 'action', id: `sb.${a.id}`, title, sub: `${where} · ${name}${on === undefined ? '' : on ? ' (on)' : ' (off)'}`,
      keys: keys ?? (a.id === 'help' ? ['?'] : undefined), run: () => a.run(ed),
    });
  }
  if (!ed.level) out.push({ kind: 'action', id: 'sb.new', title: 'New chip', sub: 'Sandbox · an empty chip in a new tab', run: () => ed.newChip() });
  return out;
}

registerEditorPlugin((ed) => registerActions(() => (ed.el.isConnected ? actionsOf(ed) : [])));
