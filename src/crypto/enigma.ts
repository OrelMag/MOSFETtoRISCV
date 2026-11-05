// The naval Enigma M4 (DOM-free): the cipher the 3D machine draws and a code-breaking chapter will attack. Wirings and
// notches from Crypto Museum's tables; tests/enigma.test.ts holds them to the 1942 U-264 message and to the wide
// reflectors (Beta at A with thin b is reflector B, Gamma at A with thin c is reflector C).

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const idx = (c: string): number => c.charCodeAt(0) - 65;
export const chr = (i: number): string => ALPHABET[((i % 26) + 26) % 26];
const mod26 = (i: number): number => ((i % 26) + 26) % 26;

export type RotorName = 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI' | 'VII' | 'VIII';
export type GreekName = 'beta' | 'gamma';
export type ThinReflector = 'b' | 'c';
/** 'D' is the field-rewirable reflector: it fills the space of a thin reflector and its Greek wheel. */
export type ReflectorName = ThinReflector | 'D';

export interface RotorSpec {
  wiring: string;
  /** Window letters from which the wheel to the left is carried at the next key press. */
  turnover: string;
  /** Rim letters the notches are cut beside: each is NOTCH_OFFSET past its turnover letter. */
  notch: string;
}

/** A notch sits this many letters along the rim from the letter in the window when it is under its pawl. */
export const NOTCH_OFFSET = 8;

export const ROTORS: Record<RotorName, RotorSpec> = {
  I: { wiring: 'EKMFLGDQVZNTOWYHXUSPAIBRCJ', turnover: 'Q', notch: 'Y' },
  II: { wiring: 'AJDKSIRUXBLHWTMCQGZNPYFVOE', turnover: 'E', notch: 'M' },
  III: { wiring: 'BDFHJLCPRTXVZNYEIWGAKMUSQO', turnover: 'V', notch: 'D' },
  IV: { wiring: 'ESOVPZJAYQUIRHXLNFTGKDCMWB', turnover: 'J', notch: 'R' },
  V: { wiring: 'VZBRGITYUPSDNHLXAWMJQOFECK', turnover: 'Z', notch: 'H' },
  VI: { wiring: 'JPGVOUMFYQBENHZRDKASXLICTW', turnover: 'ZM', notch: 'HU' },
  VII: { wiring: 'NZJHGRCXMYSWBOUFAIVLPEKQDT', turnover: 'ZM', notch: 'HU' },
  VIII: { wiring: 'FKQHTLXOCBJSPDZRAMEWNIUYGV', turnover: 'ZM', notch: 'HU' },
};
export const GREEK: Record<GreekName, string> = { beta: 'LEYJVCNIXWPBQMDRTAKZGFUHOS', gamma: 'FSOKANUERHMBTIYCWLQPZXVGJD' };
/** The thin reflectors the M4 carries. */
export const REFLECTORS: Record<ThinReflector, string> = { b: 'ENKQAUYWJICOPBLMDXZVFTHRGS', c: 'RDOBJNTKVEHMLFCWZAXGYIPSUQ' };
/** The Enigma I / M3's wide reflectors: what a thin one and its Greek wheel at A amount to. */
export const WIDE_REFLECTORS = { B: 'YRUHQSLDPXNGOKMIEBFZCWVJAT', C: 'FVPJIAOYEDRZXWGCTKUQSBNMHL' } as const;

/** UKW-D's index ring, engraved in German notation, against the Bletchley Park letters the wiring tables use: 24 letters
 *  (no J, no Y), the two gaps its mounting screws take. Crypto Museum's table. */
export const UKWD_RING = 'A-ZXWVUTSRQPON-MLKIHGFEDCB';
/** Those two gaps are wired together for good: a key sheet sets the other twelve pairs. */
export const UKWD_FIXED = 'BO';
/** A wiring to start from (made up, like any day's: real ones were on the key sheet, "an der Umkehrwalze"). */
export const UKWD_SAMPLE = 'AZ BP CX DV EU FT GS HR IQ KO LN MW';

/** The reflector a day's twelve pairs make, German letters in, as a wiring in Bletchley Park letters. */
export function ukwdWiring(pairs: string): string {
  const m = Array.from({ length: 26 }, (_, i) => i), list = pairs.toUpperCase().split(/\s+/).filter(Boolean);
  if (list.length !== 12) throw new Error('UKW-D takes twelve pairs');
  const at = (g: string): number => {
    const i = UKWD_RING.indexOf(g);
    if (g === '-' || i < 0) throw new Error(`UKW-D has no socket ${g}`);
    return i;
  };
  for (const p of list) {
    if (!/^[A-Z][A-Z]$/.test(p) || p[0] === p[1]) throw new Error(`Not a pair: ${p}`);
    const a = at(p[0]), b = at(p[1]);
    if (m[a] !== a || m[b] !== b) throw new Error(`A socket is used twice: ${p}`);
    m[a] = b; m[b] = a;
  }
  const x = idx(UKWD_FIXED[0]), y = idx(UKWD_FIXED[1]);
  m[x] = y; m[y] = x;
  return m.map(chr).join('');
}

/** Keys and lamps share these rows. */
export const KEY_ROWS = ['QWERTZUIO', 'ASDFGHJK', 'PYXCVBNML'] as const;
/** The naval plugboard is numbered, not lettered: A is socket 1, Z socket 26, in reading order over three rows. */
export const SOCKET_ROWS = [9, 8, 9] as const;
export const socketOf = (letter: string): number => idx(letter) + 1;
export const letterOf = (socket: number): string => chr(socket - 1);

export interface EnigmaSettings {
  reflector: ReflectorName;
  greek: GreekName;
  /** Left to right: the fourth wheel is `greek`. */
  rotors: [RotorName, RotorName, RotorName];
  /** Ring settings as letters, greek first. */
  rings: string;
  /** Window letters, greek first. */
  start: string;
  /** Plug pairs as letters, 'AT BL …'. */
  plugs: string;
  /** With reflector D: its twelve pairs, in the German letters on its ring. */
  dPairs?: string;
}

export const DEFAULT_SETTINGS: EnigmaSettings = { reflector: 'b', greek: 'beta', rotors: ['I', 'II', 'III'], rings: 'AAAA', start: 'AAAA', plugs: '' };

export function plugMap(plugs: string): number[] {
  const m = Array.from({ length: 26 }, (_, i) => i);
  for (const pair of plugs.toUpperCase().split(/\s+/).filter(Boolean)) {
    if (!/^[A-Z][A-Z]$/.test(pair) || pair[0] === pair[1]) throw new Error(`Not a plug pair: ${pair}`);
    const a = idx(pair[0]), b = idx(pair[1]);
    if (m[a] !== a || m[b] !== b) throw new Error(`A letter is plugged twice: ${pair}`);
    m[a] = b; m[b] = a;
  }
  return m;
}

const forward = (w: string): number[] => [...w].map(idx);
const inverse = (f: readonly number[]): number[] => { const g = new Array<number>(26); f.forEach((v, i) => { g[v] = i; }); return g; };

/** One stage of the current's way: the contact it reached, numbered in the machine's frame (0 = A at the entry wheel). */
export interface Trace {
  input: string;
  output: string;
  /** Contact after the plugboard, going in. */
  entry: number;
  /** Contacts leaving each wheel towards the reflector, right wheel first, greek last (4). */
  out: number[];
  /** The contact the reflector returns the current to. */
  back: number;
  /** Contacts leaving each wheel on the way back, greek first (4). */
  ret: number[];
  /** What the current reaches the plugboard at, returning. */
  exit: number;
}

/** Which wheels a key press moves: [left, middle, right]; the greek wheel has no pawl. */
export type Moved = [boolean, boolean, boolean];

export class Enigma {
  readonly settings: EnigmaSettings;
  /** Window positions, greek first; the greek wheel is only ever set by hand. */
  pos: number[];
  readonly rings: number[];
  private plug: number[];
  private fwd: number[][]; // right wheel first, greek last
  private inv: number[][];
  private refl: number[];
  private turn: string[];

  constructor(s: EnigmaSettings = DEFAULT_SETTINGS) {
    this.settings = s;
    if (new Set(s.rotors).size !== 3) throw new Error('A wheel can only be fitted once');
    this.pos = [...s.start.toUpperCase()].map(idx);
    this.rings = [...s.rings.toUpperCase()].map(idx);
    this.plug = plugMap(s.plugs);
    const d = s.reflector === 'D';
    // D's body fills the Greek wheel's place: the current passes straight through it, and its red D shows in the window.
    if (d) { this.pos[0] = idx('D'); this.rings[0] = idx('D'); }
    const wheels = [ROTORS[s.rotors[2]].wiring, ROTORS[s.rotors[1]].wiring, ROTORS[s.rotors[0]].wiring, d ? ALPHABET : GREEK[s.greek]];
    this.fwd = wheels.map(forward);
    this.inv = this.fwd.map(inverse);
    this.refl = forward(s.reflector === 'D' ? ukwdWiring(s.dPairs ?? UKWD_SAMPLE) : REFLECTORS[s.reflector]);
    this.turn = s.rotors.map((r) => ROTORS[r].turnover);
  }

  /** The window of slot 1 (left), 2 (middle) or 3 (right) stands on a turnover letter: its notch is under the pawl. */
  atNotch(slot: 1 | 2 | 3): boolean { return this.turn[slot - 1].includes(chr(this.pos[slot])); }

  /** What the next key press will move. The pawl of a wheel drops in when the notch to its right is under it; the middle
   *  wheel's own notch also lets the left pawl in, and that pawl pushes the middle wheel too: the double step. */
  nextMoves(): Moved {
    const midNotch = this.atNotch(2), rightNotch = this.atNotch(3);
    return [midNotch, midNotch || rightNotch, true];
  }

  /** Which pawls drop into their wheel's ratchet: left, middle, right. Not the same as what moves: at a double step the
   *  middle pawl rides high on the right wheel's lip, and the middle wheel is pushed by the left pawl, down in its notch. */
  pawls(): Moved { return [this.atNotch(2), this.atNotch(3), true]; }

  /** Move the wheels as a key press does (before the contact closes). */
  step(): Moved {
    const m = this.nextMoves();
    if (m[0]) this.pos[1] = mod26(this.pos[1] + 1);
    if (m[1]) this.pos[2] = mod26(this.pos[2] + 1);
    if (m[2]) this.pos[3] = mod26(this.pos[3] + 1);
    return m;
  }

  /** The current's way at the wheels' present positions, stepping nothing. */
  trace(input: string): Trace {
    const inp = idx(input.toUpperCase());
    if (!(inp >= 0 && inp < 26)) throw new Error(`Not a letter: ${input}`);
    // Wheel k (0 right … 3 greek): the core stands (window position − ring) past the frame.
    const off = (k: number) => mod26(this.pos[3 - k] - this.rings[3 - k]);
    const entry = this.plug[inp];
    let c = entry;
    const out: number[] = [];
    for (let k = 0; k < 4; k++) { const o = off(k); c = mod26(this.fwd[k][mod26(c + o)] - o); out.push(c); }
    c = this.refl[c];
    const back = c, ret: number[] = [];
    for (let k = 3; k >= 0; k--) { const o = off(k); c = mod26(this.inv[k][mod26(c + o)] - o); ret.push(c); }
    return { input: chr(inp), output: chr(this.plug[c]), entry, out, back, ret, exit: c };
  }

  /** A key press: step, then the lamp. */
  press(input: string): Trace { this.step(); return this.trace(input); }

  /** Encipher (or decipher: the machine is its own inverse) a text; anything but letters is dropped. */
  run(text: string): string {
    let out = '';
    for (const ch of text.toUpperCase()) if (ch >= 'A' && ch <= 'Z') out += this.press(ch).output;
    return out;
  }

  /** The window letters, greek first. */
  windows(): string { return this.pos.map(chr).join(''); }
}

/** The first M4 message the M4 Project broke (2006): Hartwig Looks, U-264, 1942. Its text is in the boat's war diary. */
export const U264 = {
  settings: { reflector: 'b', greek: 'beta', rotors: ['II', 'IV', 'I'], rings: 'AAAV', start: 'VJNA', plugs: 'AT BL DF GJ HM NW OP QY RZ VX' } as EnigmaSettings,
  cipher: 'NCZWVUSXPNYMINHZXMQXSFWXWLKJAHSHNMCOCCAKUQPMKCSMHKSEINJUSBLKIOSXCKUBHMLLXCSJUSRRDVKOHULXWCCBGVLIYXEOAHXRHKKFVDREWEZLXOBAFGYUJQUKGRTVUKAMEURBVEKSUHHVOYHABCJWMAKLFKLMYFVNRIZRVVRTKOFDANJMOLBGFFLEOPRGTFLVRHOWOPBEKVWMUQFMPWPARMFHAGKXIIBG',
  plain: 'VONVONJLOOKSJHFFTTTEINSEINSDREIZWOYYQNNSNEUNINHALTXXBEIANGRIFFUNTERWASSERGEDRUECKTYWABOSXLETZTERGEGNERSTANDNULACHTDREINULUHRMARQUANTONJOTANEUNACHTSEYHSDREIYZWOZWONULGRADYACHTSMYSTOSSENACHXEKNSVIERMBFAELLTYNNNNNNOOOVIERYSICHTEINSNULL',
};

/** Key presses before the three moving wheels stand where they started. */
export function stepPeriod(s: EnigmaSettings = DEFAULT_SETTINGS): number {
  const e = new Enigma(s), seen = new Map<string, number>();
  for (let n = 0; ; n++) {
    const w = e.windows(), at = seen.get(w);
    if (at !== undefined) return n - at;
    seen.set(w, n);
    e.step();
  }
}
