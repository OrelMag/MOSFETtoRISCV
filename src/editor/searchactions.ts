// The editor's actions in the search box (`>` in the sandbox and on a level screen): every toolbar action
// this editor shows (its registry: registerToolbarAction), run / pause and a new chip, while the editor is
// mounted. Disabled actions are left out.

import { keyDef } from '../ui/keys';
import type { NavItem } from '../ui/chapternav';
import { here, registerActions, registerSearchSource, type SearchCtx } from '../ui/searchsources';
import { type Editor, registerEditorPlugin } from './editor';
import { addExample, EXAMPLES } from './examples';
import { aliasesOf, itemText } from './palette';

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
    const title = (a.menu ?? a.label ?? name).replace(/\s*[▸…]+$/, '');
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

// ---- "Place a part": every palette item, armed for a click on the canvas; and the examples ----------------

/** The palette's parts (and, in the sandbox, its examples) as search rows; aliases ride in `alt` ("tunnel" finds Pointer). */
function partsOf(ed: Editor): NavItem[] {
  const parts = ed.palette.placeable().map(({ key, item, group }): NavItem => ({
    kind: 'component', id: `part:${key}`, title: item.name, sub: `Place a part · ${group.title}${item.section ? ` · ${item.section}` : ''}`,
    alt: [item.id, item.tag ?? '', ...aliasesOf(itemText(item))].join(' '), run: () => ed.armPart(item, key),
  }));
  if (ed.level) return parts;
  return [...parts, ...EXAMPLES.map((ex): NavItem => ({
    kind: 'component', id: `example:${ex.id}`, title: `Example: ${ex.name}`, sub: `Load as a new chip · ${ex.blurb}`,
    alt: ['example', ...aliasesOf(`${ex.name} ${ex.blurb}`)].join(' '),
    run: () => {
      let id = '';
      ed.editWs((ws) => { const a = addExample(ws, ex); id = a.id; return a.ws; });
      ed.toast(`Loaded “${ed.ws.chips[id]?.name ?? ex.name}” (Ctrl+Z removes it)`);
    },
  }))];
}

const onEditor = (ctx: SearchCtx) => /^#\/(sandbox|campaign\/play)\b/.test(ctx.hash);

registerEditorPlugin((ed) => registerSearchSource({
  id: 'parts', title: 'Place a part', scope: 'Parts',
  // ranked first on the sandbox and a level screen
  order: (ctx) => (onEditor(ctx) ? -2 : 9),
  items: (ctx) => (ed.el.isConnected && onEditor(ctx) ? partsOf(ed) : []),
}));
