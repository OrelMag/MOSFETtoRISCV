// Puzzle devices: a small world behind named pins (the third kind of puzzle part, beside PUZZLE IN and PUZZLE OUT).
// The circuit drives the device's `drive` pins (lamps, motors, a coin chute) and reads its `sense` pins (a button,
// walls, coins). The world takes one step at each rising clk edge (with the optional `en` pin: only where en = 1),
// reading the drive pins as they were just before the edge; the sense pins follow its state alone, so a controller
// wired straight back into it makes no loop (editor/puzzleparts.ts deviceDef, a `seq` behaviour). Every step the
// world's rules judge what the pins did: the first broken rule is a fault, and the world stops there. A test is a
// starting world (a maze, a script of presses or coins) and a step limit; it passes when the world says it is done
// (the maze's goal) or the limit is reached with nothing broken and nothing left owed (end()). No DOM.

export type DeviceId = 'crossing' | 'maze' | 'vend';

export interface DevicePin { name: string; width: number; doc: string }

export interface DeviceTest { name: string; /** Steps the test runs at most. */ steps: number }

/** One step of a world as the player shows it: the drive pins sampled, the sense pins they saw, and what happened. */
export interface DeviceFrame { step: number; drive: number[]; sense: number[]; fault?: string; note?: string }

export interface DeviceModel<W = unknown, T extends DeviceTest = DeviceTest> {
  id: DeviceId;
  /** The part's name and box label. */
  title: string;
  label: string;
  drive: DevicePin[];
  sense: DevicePin[];
  start(t: T): W;
  /** The sense pins, from the world's state alone. */
  sensors(w: W): number[];
  /** One step: the drive pins (none X) as they were at the edge. Returns the first rule it broke (the world then stops). */
  step(w: W, drive: number[]): string | null;
  /** The test is over and passed (the maze's goal): no more steps. */
  done(w: W): boolean;
  /** At the step limit: what is still wrong (a press not served, change owed), or null. */
  end(w: W): string | null;
  /** One line about the world now (the part on the canvas, the player). */
  status(w: W): string;
  clone(w: W): W;
}

// ---- the crossing ------------------------------------------------------------------------------------------------

export interface CrossingTest extends DeviceTest { /** Steps at which someone presses the button (seen on req from that step). */ presses: number[] }

export interface CrossingWorld {
  t: number;
  presses: number[];
  /** A press waits (held until WALK lights). */
  req: number;
  /** The step the waiting press came. */
  pressAt: number;
  /** The car lamp lit last step ('' before the first), and how long it has been lit. */
  lamp: '' | 'r' | 'y' | 'g';
  run: number;
  walk: number;
  walkRun: number;
  /** Green steps since the last WALK ended (Infinity before the first). */
  green: number;
  walks: number;
  /** The longest a press waited. */
  waited: number;
}

export const CROSSING = {
  /** Yellow at least this many steps between green and red. */
  YELLOW: 2,
  /** WALK at least this many steps. */
  WALK: 4,
  /** A press served (WALK lit) within this many steps. */
  SERVE: 12,
  /** Green for cars at least this many steps between two WALKs. */
  GREEN: 6,
};

const LAMP_NAME = { r: 'red', y: 'yellow', g: 'green' } as const;

export const CROSSING_MODEL: DeviceModel<CrossingWorld, CrossingTest> = {
  id: 'crossing', title: 'Crossing', label: 'CROSSING',
  drive: [
    { name: 'car_r', width: 1, doc: 'The cars\' red lamp' },
    { name: 'car_y', width: 1, doc: 'The cars\' yellow lamp' },
    { name: 'car_g', width: 1, doc: 'The cars\' green lamp' },
    { name: 'walk', width: 1, doc: 'WALK lit for the people crossing (else WAIT)' },
  ],
  sense: [{ name: 'req', width: 1, doc: 'Someone pressed the button: 1 from the press until WALK lights' }],
  start: (t) => ({ t: 0, presses: t.presses.slice(), req: t.presses.includes(0) ? 1 : 0, pressAt: 0, lamp: '', run: 0, walk: 0, walkRun: 0, green: Infinity, walks: 0, waited: 0 }),
  sensors: (w) => [w.req],
  step(w, [r, y, g, walk]) {
    const lit = (['r', 'y', 'g'] as const).filter((_, i) => [r, y, g][i] === 1);
    if (lit.length !== 1) return lit.length ? `${lit.map((k) => LAMP_NAME[k]).join(' and ')} lit together: exactly one car lamp at a time` : 'no car lamp lit: exactly one at a time';
    const now = lit[0];
    if (walk && now !== 'r') return `WALK while the cars have ${LAMP_NAME[now]}: only on red`;
    if (w.lamp === 'g' && now === 'r') return `red straight after green: yellow first, for at least ${CROSSING.YELLOW} steps`;
    if (w.lamp === 'y' && now === 'r' && w.run < CROSSING.YELLOW) return `yellow for only ${w.run} step${w.run === 1 ? '' : 's'}: at least ${CROSSING.YELLOW}`;
    if (w.lamp === 'y' && now === 'g') return 'green again straight after yellow: yellow leads to red';
    if (w.lamp === 'r' && now === 'y') return 'yellow after red: red goes back to green';
    if (w.walk && !walk && w.walkRun < CROSSING.WALK) return `WALK for only ${w.walkRun} step${w.walkRun === 1 ? '' : 's'}: at least ${CROSSING.WALK}`;
    if (walk && !w.walk) {
      if (!w.req) return 'WALK with nobody waiting: only after a press';
      if (w.walks && w.green < CROSSING.GREEN) return `WALK again after only ${w.green} step${w.green === 1 ? '' : 's'} of green: cars get at least ${CROSSING.GREEN}`;
      w.waited = Math.max(w.waited, w.t - w.pressAt);
      w.walks++;
      w.req = 0;
    }
    if (!walk && w.req && w.t - w.pressAt >= CROSSING.SERVE) return `the press at step ${w.pressAt} not served within ${CROSSING.SERVE} steps`;
    // the lamps held over this step
    w.run = now === w.lamp ? w.run + 1 : 1;
    w.lamp = now;
    w.walkRun = walk ? (w.walk ? w.walkRun + 1 : 1) : 0;
    if (walk) w.green = 0;
    else if (now === 'g' && w.walks) w.green++;
    w.walk = walk;
    w.t++;
    // a press for the next step: ignored while WALK is lit (it is being served)
    if (w.presses.includes(w.t) && !w.req && !walk) { w.req = 1; w.pressAt = w.t; }
    return null;
  },
  done: () => false,
  end: (w) => (w.req ? `the press at step ${w.pressAt} still waits at the end` : null),
  status: (w) => `${w.lamp ? `${LAMP_NAME[w.lamp]}${w.walk ? ' · WALK' : ''}` : 'off'}${w.req ? ' · waiting' : ''}`,
  clone: (w) => ({ ...w, presses: w.presses.slice() }),
};

export const CROSSING_TESTS: CrossingTest[] = [
  { name: 'quiet', steps: 40, presses: [] },
  { name: 'one press', steps: 40, presses: [3] },
  { name: 'impatient', steps: 40, presses: [3, 4, 5, 9] },
  { name: 'back to back', steps: 48, presses: [3, 15] },
  { name: 'during walk', steps: 40, presses: [2, 10] },
  { name: 'at power-on', steps: 40, presses: [0, 30] },
];

// ---- the maze ------------------------------------------------------------------------------------------------------

/** A maze drawn in text: (2r + 1, 2c + 1) is cell (r, c), the characters between are walls ('#') or openings. S start, G goal. */
export interface MazeTest extends DeviceTest { maze: string[]; /** Heading at the start: 0 north, 1 east, 2 south, 3 west. */ dir: number }

export interface MazeWorld { maze: string[]; r: number; c: number; d: number; goal: boolean; t: number; moves: number;
  /** Where the robot stood, facing which way, at each step (r·64 + c·4 + d → the first step), for the limit's message. */
  seen: Map<number, number>; trail: number[] }

export const DIRS: [number, number][] = [[-1, 0], [0, 1], [1, 0], [0, -1]];
const HEAD = ['north', 'east', 'south', 'west'];

export const mazeSize = (m: string[]) => ({ rows: (m.length - 1) / 2, cols: (m[0].length - 1) / 2 });
export const mazeWall = (m: string[], r: number, c: number, d: number) => m[2 * r + 1 + DIRS[d][0]][2 * c + 1 + DIRS[d][1]] === '#';
export const mazeCell = (m: string[], r: number, c: number) => m[2 * r + 1][2 * c + 1];
function find(m: string[], ch: string): [number, number] {
  const { rows, cols } = mazeSize(m);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (mazeCell(m, r, c) === ch) return [r, c];
  throw new Error(`maze without ${ch}`);
}

export const MAZE_MODEL: DeviceModel<MazeWorld, MazeTest> = {
  id: 'maze', title: 'Maze robot', label: 'MAZE',
  drive: [
    { name: 'fwd', width: 1, doc: 'Drive one square forward' },
    { name: 'left', width: 1, doc: 'Turn left on the spot' },
    { name: 'right', width: 1, doc: 'Turn right on the spot' },
  ],
  sense: [
    { name: 'wall_f', width: 1, doc: 'A wall ahead' },
    { name: 'wall_l', width: 1, doc: 'A wall on the left' },
    { name: 'wall_r', width: 1, doc: 'A wall on the right' },
    { name: 'goal', width: 1, doc: 'Standing on the goal' },
  ],
  start(t) {
    const [r, c] = find(t.maze, 'S');
    return { maze: t.maze, r, c, d: t.dir, goal: false, t: 0, moves: 0, seen: new Map([[r * 64 + c * 4 + t.dir, 0]]), trail: [r * 64 + c * 4 + t.dir] };
  },
  sensors: (w) => [+mazeWall(w.maze, w.r, w.c, w.d), +mazeWall(w.maze, w.r, w.c, (w.d + 3) % 4), +mazeWall(w.maze, w.r, w.c, (w.d + 1) % 4), +w.goal],
  step(w, [f, l, rt]) {
    const on = (['fwd', 'left', 'right'] as const).filter((_, i) => [f, l, rt][i] === 1);
    if (on.length > 1) return `${on.join(' and ')} at once: one command a step`;
    if (f) {
      if (mazeWall(w.maze, w.r, w.c, w.d)) return `drove forward into a wall at row ${w.r + 1}, column ${w.c + 1}, facing ${HEAD[w.d]}`;
      w.r += DIRS[w.d][0];
      w.c += DIRS[w.d][1];
    } else if (l) w.d = (w.d + 3) % 4;
    else if (rt) w.d = (w.d + 1) % 4;
    if (on.length) w.moves++;
    w.t++;
    w.goal = mazeCell(w.maze, w.r, w.c) === 'G';
    const k = w.r * 64 + w.c * 4 + w.d;
    if (!w.seen.has(k)) w.seen.set(k, w.t);
    w.trail.push(k);
    return null;
  },
  done: (w) => w.goal,
  end(w) {
    const k = w.r * 64 + w.c * 4 + w.d;
    const first = w.seen.get(k)!;
    const again = first < w.t ? `; it stood here facing ${HEAD[w.d]} at step ${first} too: going round?` : '';
    return `not at the goal after ${w.t} steps (row ${w.r + 1}, column ${w.c + 1})${again}`;
  },
  status: (w) => (w.goal ? 'on the goal' : `row ${w.r + 1}, column ${w.c + 1}, facing ${HEAD[w.d]}`),
  clone: (w) => ({ ...w, seen: new Map(w.seen), trail: w.trail.slice() }),
};

export const MAZE_TESTS: MazeTest[] = [
  { name: 'the long way', steps: 60, dir: 2, maze: [
    '#############',
    '#S#.......#.#',
    '#.#.###.#.#.#',
    '#...#...#...#',
    '###.#.#####.#',
    '#...#.#.....#',
    '#.###.#.###.#',
    '#.#...#.#...#',
    '#.#.###.#.###',
    '#.#.....#...#',
    '#.#######.#.#',
    '#.........#G#',
    '#############'] },
  { name: 'switchbacks', steps: 80, dir: 1, maze: [
    '#############',
    '#S..........#',
    '###########.#',
    '#...........#',
    '#.###########',
    '#...........#',
    '###########.#',
    '#...........#',
    '#.###########',
    '#...........#',
    '###########.#',
    '#G..........#',
    '#############'] },
  { name: 'dead ends', steps: 120, dir: 2, maze: [
    '#############',
    '#S..#.......#',
    '#.#.#.#####.#',
    '#.#...#...#.#',
    '#.#####.#.#.#',
    '#.....#.#...#',
    '#####.#.#####',
    '#.....#.....#',
    '#.#########.#',
    '#.#.......#.#',
    '#.#.#####.#.#',
    '#...#....G#.#',
    '#############'] },
  { name: 'facing a wall', steps: 60, dir: 0, maze: [
    '#############',
    '#.....#.....#',
    '#.###.#.###.#',
    '#.#S#...#G#.#',
    '#.#.#####.#.#',
    '#.#.......#.#',
    '#.#########.#',
    '#...........#',
    '#############'] },
];

// ---- the vending machine ---------------------------------------------------------------------------------------------

/** Coin codes on `coin` (and their value in cents); `chg` returns 1 → 5¢, 2 → 10¢ (3 is no coin). */
export const COIN_CENTS = [0, 5, 10, 25];
export const CHANGE_CENTS = [0, 5, 10];
export const VEND = { PRICE: 30, /** A buy served (an item dropped) within this many steps. */ SERVE: 4, /** All change back within this many steps of the sale or refund. */ PAYOUT: 10 };

export type VendEvent = 'c5' | 'c10' | 'c25' | 'buy' | 'refund';

export interface VendTest extends DeviceTest { /** The customer's actions: step → what they do then. */ script: [number, VendEvent][] }

export interface VendWorld {
  t: number;
  script: [number, VendEvent][];
  /** Cents in the machine that belong to the customer (paid, not yet spent or returned). */
  credit: number;
  /** A buy waits to be served (the step it was pressed, -1 none). */
  buyAt: number;
  /** Change is owed from this step (-1 none): the credit must go back to 0. */
  oweAt: number;
  items: number;
  returned: number;
  paid: number;
}

const evAt = (w: VendWorld, t: number) => w.script.find(([s]) => s === t)?.[1];

export const VEND_MODEL: DeviceModel<VendWorld, VendTest> = {
  id: 'vend', title: 'Vending machine', label: 'VENDING',
  drive: [
    { name: 'vend', width: 1, doc: 'Drop one item (it costs 30¢)' },
    { name: 'chg', width: 2, doc: 'Return a coin: 1 a 5¢, 2 a 10¢, 0 none' },
  ],
  sense: [
    { name: 'coin', width: 2, doc: 'A coin dropping in this step: 1 5¢, 2 10¢, 3 25¢, 0 none' },
    { name: 'buy', width: 1, doc: 'The buy button, this step' },
    { name: 'refund', width: 1, doc: 'The coin return button, this step' },
  ],
  start: (t) => ({ t: 0, script: t.script.slice(), credit: 0, buyAt: -1, oweAt: -1, items: 0, returned: 0, paid: 0 }),
  sensors(w) {
    const e = evAt(w, w.t);
    return [e === 'c5' ? 1 : e === 'c10' ? 2 : e === 'c25' ? 3 : 0, +(e === 'buy'), +(e === 'refund')];
  },
  step(w, [vend, chg]) {
    const e = evAt(w, w.t);
    // the buttons count from the step they are pressed: the machine may answer in the same step
    if (e === 'buy' && w.credit >= VEND.PRICE && w.buyAt < 0 && w.oweAt < 0) w.buyAt = w.t;
    if (e === 'refund' && w.credit > 0 && w.oweAt < 0) w.oweAt = w.t;
    if (chg === 3) return 'chg = 3: there is no such coin to return';
    if (vend) {
      if (w.buyAt < 0) return w.credit < VEND.PRICE ? `dropped an item with only ${w.credit}¢ paid` : 'dropped an item with nobody pressing buy';
      w.credit -= VEND.PRICE;
      w.items++;
      w.buyAt = -1;
      if (w.credit > 0) w.oweAt = w.t;
    }
    if (chg) {
      const a = CHANGE_CENTS[chg];
      if (w.oweAt < 0) return `gave back ${a}¢ with no sale or refund to make change for`;
      if (a > w.credit) return `gave back ${a}¢ with only ${w.credit}¢ left to return`;
      w.credit -= a;
      w.returned += a;
    }
    if (w.oweAt >= 0 && w.credit === 0) w.oweAt = -1;
    if (w.buyAt >= 0 && w.t - w.buyAt >= VEND.SERVE - 1) return `buy at step ${w.buyAt} not served within ${VEND.SERVE} steps`;
    if (w.oweAt >= 0 && w.t - w.oweAt >= VEND.PAYOUT - 1) return `${w.credit}¢ change still owed ${VEND.PAYOUT} steps after step ${w.oweAt}`;
    // the coin of this step lands at its edge
    const coin = e === 'c5' ? 5 : e === 'c10' ? 10 : e === 'c25' ? 25 : 0;
    w.credit += coin;
    w.paid += coin;
    w.t++;
    return null;
  },
  done: () => false,
  end: (w) => (w.buyAt >= 0 ? `buy at step ${w.buyAt} never served` : w.oweAt >= 0 ? `${w.credit}¢ change still owed at the end` : null),
  status: (w) => `credit ${w.credit}¢ · ${w.items} item${w.items === 1 ? '' : 's'}${w.returned ? ` · ${w.returned}¢ back` : ''}`,
  clone: (w) => ({ ...w, script: w.script.slice() }),
};

export const VEND_TESTS: VendTest[] = [
  { name: 'exact', steps: 24, script: [[2, 'c10'], [4, 'c10'], [6, 'c10'], [9, 'buy']] },
  { name: 'change 5¢', steps: 24, script: [[2, 'c25'], [4, 'c10'], [7, 'buy']] },
  { name: 'change 20¢', steps: 24, script: [[2, 'c25'], [4, 'c25'], [7, 'buy']] },
  { name: 'too little', steps: 24, script: [[2, 'c25'], [5, 'buy'], [9, 'refund']] },
  { name: 'two sales', steps: 40, script: [[2, 'c25'], [3, 'c5'], [5, 'buy'], [12, 'c10'], [13, 'c25'], [16, 'buy']] },
  { name: 'refund nothing', steps: 16, script: [[3, 'refund'], [6, 'buy']] },
];

// ---- the list ------------------------------------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DEVICES: Record<DeviceId, DeviceModel<any, any>> = { crossing: CROSSING_MODEL, maze: MAZE_MODEL, vend: VEND_MODEL };
export const DEVICE_IDS = Object.keys(DEVICES) as DeviceId[];
/** Each device's tests (one puzzle per device). */
export const DEVICE_TESTS: Record<DeviceId, DeviceTest[]> = { crossing: CROSSING_TESTS, maze: MAZE_TESTS, vend: VEND_TESTS };
export const isDeviceId = (x: unknown): x is DeviceId => typeof x === 'string' && x in DEVICES;

// ---- a world played by a controller written in TypeScript (the tests' mutants, the references' spec) ----------------

export interface WorldRun { ok: boolean; why?: string; /** The step the fault or the end came. */ at: number; frames: DeviceFrame[]; world: unknown }

/**
 * Play test `t` on `model` with `ctl` deciding the drive pins from the sense pins each step (a controller with state
 * keeps it in its closure). As the part does: the drive pins sampled at each step, an X (−1) is a fault.
 */
export function playWorld<W, T extends DeviceTest>(model: DeviceModel<W, T>, t: T, ctl: (sense: number[], step: number) => number[]): WorldRun {
  const w = model.start(t);
  const frames: DeviceFrame[] = [];
  for (let s = 0; s < t.steps; s++) {
    if (model.done(w)) return { ok: true, at: s, frames, world: w };
    const sense = model.sensors(w);
    const drive = ctl(sense, s);
    const why = stepWorld(model, w, drive);
    frames.push({ step: s, drive, sense, ...(why ? { fault: why } : {}) });
    if (why) return { ok: false, why, at: s, frames, world: w };
  }
  if (model.done(w)) return { ok: true, at: t.steps, frames, world: w };
  const why = model.end(w);
  return why ? { ok: false, why, at: t.steps, frames, world: w } : { ok: true, at: t.steps, frames, world: w };
}

/** One step with the part's own checks first: an X on a drive pin. */
export function stepWorld<W>(model: DeviceModel<W, never>, w: W, drive: number[]): string | null {
  const x = drive.findIndex((v) => v < 0);
  if (x >= 0) return `${model.drive[x].name} is X (unknown): drive every pin to 0 or 1`;
  return model.step(w, drive);
}
