// The sandbox's keys that need not load with the first page (Tools.keyCanvas handles them): added to ui/keys.ts's
// table when the editor loads, so the ? sheet lists them. Single characters obey the single-key switch.

import { addKeys } from '../ui/keys';

addKeys([
  { id: 'sb.nextpart', group: 'place', caps: ['[', '·', ']'], does: 'cursor to the previous · next part (↵ then selects it)', taken: ['[', ']'],
    match: [{ code: 'BracketRight', codeOnly: true, shift: false }, { code: 'BracketLeft', codeOnly: true, shift: false }] },
  { id: 'sb.stepkey', group: 'view', caps: ['.'], does: 'one step (a clock cycle, or a gate delay in gate mode)', taken: ['.'], match: [{ key: '.', code: 'Period', shift: false }] },
  { id: 'sb.zoomin', group: 'view', caps: ['+', '·', '−'], does: 'zoom in · out', taken: ['+', '=', '-'], match: [{ key: '+' }, { key: '=', code: 'Equal', shift: false }] },
  { id: 'sb.zoomout', group: 'view', caps: [], does: '', match: [{ key: '-', code: 'Minus', shift: false }] },
  { id: 'sb.fit', group: 'view', caps: ['0'], does: 'fit the chip to the view', taken: ['0'], match: [{ key: '0', code: 'Digit0', shift: false }] },
]);
