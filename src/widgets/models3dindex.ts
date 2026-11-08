// Every 3D model on the site, in one DOM-free list: the codex's "3D models" page (ui/models3dpage.ts) draws its cards from it,
// the search finds models by title, and codex entries link to the models that show them. `open` loads the same entry the
// chapter step mounts (placeholder, controls and SVG fallback included), as a chunk of its own, so this file stays tiny.
//
// tests/models3dindex.test.ts holds it to the code: every widgets/*3dview.ts (a model's body) is claimed by an entry's
// `files`, every entry's chapter / step exists and its widget calls `factory`, and every `codex` id is an entry.
// A new model: add its entry here (the test's message says what is missing).

import type { Widget } from '../view/stage';

export type ModelCategory = 'devices' | 'machines' | 'memory' | 'comms' | 'dsp' | 'analogies';

export const MODEL_CATEGORIES: readonly { id: ModelCategory; title: string }[] = [
  { id: 'devices', title: 'Devices' },
  { id: 'machines', title: 'Machines' },
  { id: 'memory', title: 'Memory' },
  { id: 'comms', title: 'Communication' },
  { id: 'dsp', title: 'Signal processing' },
  { id: 'analogies', title: 'Analogies' },
];

export interface Model3d {
  /** Unique, kebab-free: the address #/campaign/codex/models/<id>. */
  id: string;
  title: string;
  /** One line: what it shows and what drives it. */
  summary: string;
  category: ModelCategory;
  /** The chapter id and step index that mount it. */
  chapter: string;
  step: number;
  /** The widgets/ files that make it up (without .ts): the test's claim on every *3dview.ts. */
  files: readonly string[];
  /** The function the step's widget calls (the test reads it in the step's source). */
  factory: string;
  /** Codex entries it shows (each gets an "In 3D" link). */
  codex?: readonly string[];
  /** The model, as the step mounts it (the widget returned at once shows a placeholder until its chunk arrives). */
  open: () => Promise<Widget>;
}

export const MODELS_3D: readonly Model3d[] = [
  {
    id: 'mosfet', title: 'The MOSFET in 3D', category: 'devices', chapter: 'mosfet', step: 0,
    summary: 'Width, length and gate area as solid geometry: the inversion sheet and the carriers that cross it.',
    files: ['modelhost', 'mosfet3dview', 'mosfet3dparts'], factory: 'mosfet3d', codex: ['mosfet', 'cmos'],
    open: () => import('./modelhost').then((m) => m.mosfet3d()),
  },
  {
    id: 'relay', title: 'A telephone relay', category: 'devices', chapter: 'relays', step: 0,
    summary: 'Coil, armature and contacts placed by the relay\'s physics model over 25 ms: pull-in, travel and bounce.',
    files: ['relay3d', 'relay3dview'], factory: 'relayCloseup', codex: ['relay', 'relaystep', 'selfhold'],
    open: () => import('./relay3d').then((m) => m.relayCloseup()),
  },
  {
    id: 'triode', title: 'The 6SN7 twin triode', category: 'devices', chapter: 'tubes', step: 0,
    summary: 'A twin triode at real size with a plate cut away: cathode glow, electrons and the transfer curve from the tube model.',
    files: ['triode3d', 'triode3dview'], factory: 'triodeCloseup', codex: ['triode', 'griddivider'],
    open: () => import('./triode3d').then((m) => m.triodeCloseup()),
  },
  {
    id: 'cell', title: 'A standard cell, layer by layer', category: 'devices', chapter: 'silicon', step: 0,
    summary: 'A CMOS cell\'s diffusion, poly, metal and contacts stacked and spread apart; its inputs switch the transistors.',
    files: ['cell3d'], factory: 'layoutWidget', codex: ['stdcell', 'cmos'],
    open: () => import('./silicon').then((m) => m.layoutWidget({ mode: '3d' })),
  },
  {
    id: 'masks', title: 'The chip, mask by mask', category: 'devices', chapter: 'silicon', step: 1,
    summary: 'The same cell built step by step: each mask above the die, and the layer it patterns landing below.',
    files: ['masks3d', 'masks3dview', 'masks3dparts'], factory: 'masks3d', codex: ['stdcell'],
    open: () => import('./masks3d').then((m) => m.masks3d()),
  },
  {
    id: 'package', title: 'A package, opened up', category: 'devices', chapter: 'wire', step: 8,
    summary: 'Die, pads, bond wires, lead frame and board, with the ground bounce that more ground wires divide.',
    files: ['package3d', 'package3dview', 'package3dparts'], factory: 'package3d',
    open: () => import('./package3d').then((m) => m.package3d()),
  },
  {
    id: 'dram', title: 'The DRAM array', category: 'memory', chapter: 'dram', step: 4,
    summary: 'The chapter\'s 4 × 4 array on the switch-level simulator: every cell\'s charge as a height, step by step through the protocol.',
    files: ['dram3d', 'dram3dview', 'dram3dparts', 'dram3dbench'], factory: 'dram3d', codex: ['senseamp', 'dramtiming'],
    open: () => import('./dram3d').then((m) => m.dram3d()),
  },
  {
    id: 'fgate', title: 'The floating gate', category: 'memory', chapter: 'flash', step: 1,
    summary: 'A NAND string of four flash cells: program a cell pulse by pulse, erase the block, read with the others at the pass voltage.',
    files: ['fgate3d', 'fgate3dview', 'fgate3dparts'], factory: 'fgate3d', codex: ['ftl', 'boot'],
    open: () => import('./fgate3d').then((m) => m.fgate3d()),
  },
  {
    id: 'press', title: 'Hollerith\'s pin press', category: 'machines', chapter: 'cards', step: 1,
    summary: 'The census card under the press: pins reach mercury through the holes and the dials count.',
    files: ['press3d', 'press3dview', 'press3dparts'], factory: 'press3d', codex: ['hollerith'],
    open: () => import('./press3d').then((m) => m.press3d()),
  },
  {
    id: 'cardreader', title: 'The card reader', category: 'machines', chapter: 'cards', step: 5,
    summary: 'Picker knife, feed rolls and read station feeding a computer the sum program, edge by edge.',
    files: ['cardreader3d', 'cardreader3dview', 'cardreader3dparts'], factory: 'cardReader3d', codex: ['hollerith'],
    // The chapter's deck: the sum program, a card a word, two edges a card.
    open: () => Promise.all([import('./cardreader3d'), import('../cards/card'), import('../riscv/asm'), import('../riscv/programs')])
      .then(([m, card, asm, progs]) => {
        const sum = asm.assemble(progs.PROGRAMS.find((p) => p.id === 'sum')!.source);
        const deck = card.programDeck('sum.s', sum.lines.map((l) => ({ word: l.word, source: l.text })));
        return m.cardReader3d(deck, 2, sum.lines.map((l) => l.text.trim()));
      }),
  },
  {
    id: 'enigma', title: 'The Enigma M4', category: 'machines', chapter: 'secret', step: 0,
    summary: 'The naval Enigma opened as an operator would: wheels, pawls, plugs and lamps are the cipher\'s state. Type on it.',
    files: ['enigma3d', 'enigma3dview', 'enigma3dparts', 'enigma3dmachine', 'enigma3dextras'], factory: 'enigma3d', codex: ['enigma'],
    open: () => import('./enigma3d').then((m) => m.enigma3d()),
  },
  {
    id: 'fibre', title: 'An optical fibre, cut open', category: 'comms', chapter: 'glass', step: 1,
    summary: 'Core, cladding and coating to scale: rays held by total internal reflection, and a pulse spread by the modes.',
    files: ['fibre3d', 'fibre3dview', 'fibre3dparts'], factory: 'fibre3d', codex: ['dispersion'],
    open: () => import('./fibre3d').then((m) => m.fibre3d()),
  },
  {
    id: 'telegraph', title: 'Telegraph key and sounder', category: 'comms', chapter: 'telegraph', step: 1,
    summary: 'Hold the key to send: the sounder\'s armature moves as the relay model moves it at the voltage the line leaves.',
    files: ['telegraph3d', 'telegraph3dview', 'telegraph3dparts'], factory: 'telegraph3d', codex: ['relay'],
    open: () => import('./telegraph3d').then((m) => m.telegraph3d()),
  },
  {
    id: 'strowger', title: 'The Strowger selector', category: 'comms', chapter: 'exchange', step: 3,
    summary: 'The stepping switch behind the exchange: dial a level, mark lines busy, hang up.',
    files: ['strowger3d', 'strowger3dview', 'strowger3dparts'], factory: 'strowger3d', codex: ['relay'],
    open: () => import('./strowger3d').then((m) => m.strowger3d()),
  },
  {
    id: 'cable', title: 'Twisted pair and coax', category: 'comms', chapter: 'wire', step: 6,
    summary: 'Why a pair is twisted: each half twist flips a loop\'s EMF so the pickup cancels; or swap in a coax.',
    files: ['cable3d', 'cable3dview', 'cable3dparts'], factory: 'cable3d',
    open: () => import('./cable3d').then((m) => m.cable3d()),
  },
];

export const modelById = (id: string): Model3d | undefined => MODELS_3D.find((m) => m.id === id);

/** The models that show a codex entry. */
export const modelsOfCodex = (codexId: string): Model3d[] => MODELS_3D.filter((m) => m.codex?.includes(codexId));

/** Models whose title, summary or category matches every word of `q` (titles first). */
export function searchModels(q: string): Model3d[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const cat = (m: Model3d) => MODEL_CATEGORIES.find((c) => c.id === m.category)!.title;
  const hit = (s: string) => words.every((w) => s.toLowerCase().includes(w));
  const byTitle = MODELS_3D.filter((m) => hit(`${m.title} ${m.id} 3d model`));
  const rest = MODELS_3D.filter((m) => !byTitle.includes(m) && hit(`${m.title} ${m.id} ${m.summary} ${cat(m)} 3d model`));
  return [...byTitle, ...rest];
}
