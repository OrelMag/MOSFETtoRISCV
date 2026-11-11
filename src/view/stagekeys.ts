// The stage's part-cursor keys (Stage.cursorKey), added to ui/keys.ts's table when the stage loads, so they cost the
// first page nothing. They act only while the circuit itself has the focus: a 3D model's + − Home, a panel's arrows
// stay theirs. Single characters obey the single-key switch.

import { addKeys, MOD } from '../ui/keys';

addKeys([
  { id: 'cursor.move', group: 'stage', caps: ['←', '→', '↑', '↓'], does: 'move the cursor to the nearest part or pin that way (the first press: the first input)' },
  { id: 'cursor.ends', group: 'stage', caps: ['Home', '·', 'End'], does: 'cursor to the first input · the first output' },
  { id: 'cursor.act', group: 'stage', caps: ['↵'], does: 'an input toggles (a bus: edit its value), a part opens, an output is read out' },
  { id: 'cursor.toggle', group: 'stage', caps: ['Space'], does: 'toggle the input under the cursor' },
  { id: 'cursor.run', group: 'stage', caps: [`${MOD} ↵`], does: 'run / pause the clock' },
  { id: 'cursor.pulse', group: 'stage', caps: ['.'], does: 'one clock cycle (Pulse)', match: [{ key: '.', code: 'Period', shift: false }] },
  { id: 'cursor.step', group: 'stage', caps: ['>'], does: 'one gate delay (Step)', match: [{ key: '>' }] },
  { id: 'cursor.back', group: 'stage', caps: [','], does: 'back one step', match: [{ key: ',', code: 'Comma', shift: false }] },
  { id: 'cursor.zoomin', group: 'stage', caps: ['+'], does: 'zoom in (toward the cursor’s part; with Open blocks as you zoom, its inside opens)', match: [{ key: '+' }, { key: '=', code: 'Equal', shift: false }] },
  { id: 'cursor.zoomout', group: 'stage', caps: ['−'], does: 'zoom out', match: [{ key: '-', code: 'Minus', shift: false }] },
  { id: 'cursor.fit', group: 'stage', caps: ['0'], does: 'fit the circuit to the view', match: [{ key: '0', code: 'Digit0', shift: false }] },
]);
