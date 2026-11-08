import { describe, expect, it } from 'vitest';
import { U264 } from '../src/crypto/enigma';
import { aesSbox } from '../src/lib/aes';
import { m4Gates } from '../src/lib/enigmagates';
import { shaCore } from '../src/lib/sha256';
import { secretBenches } from '../src/widgets/secretscenes';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { routeNetlist } from '../src/view/route';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';

// The secret chapter's redrawn levels: no wire runs through a part's body (see tests/redrawclear.test.ts).
const sub = (top: ComponentDef, name: string): ComponentDef => netlistOf(top)!.instances.find((i) => i.name === name)!.def;
const levels: [string, () => ComponentDef][] = [
  ...secretBenches().map((d): [string, () => ComponentDef] => [d.id, () => d]),
  ['SHA-256 core', () => shaCore()],
  ['S-box into the tower', () => sub(aesSbox(), 'u0')],
  ['S-box out of the tower', () => sub(aesSbox(), 'u2')],
  ['plugboard table', () => sub(m4Gates(U264.settings), 'plug_in')],
  ['wheel I table', () => sub(sub(m4Gates(U264.settings), 'w0_f'), 'u1')],
  ['reflector table', () => sub(m4Gates(U264.settings), 'ukw')],
];

describe('secret chapter levels', () => {
  it.each(levels)('%s: no wire runs through a part', (_, make) => {
    const def = make();
    const nl = drawnNetlist(def, netlistOf(def)!);
    const hit = wiresThroughParts(nl, routeNetlist(def, nl).nets);
    expect([...hit].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0])).toEqual([]);
  });
});
