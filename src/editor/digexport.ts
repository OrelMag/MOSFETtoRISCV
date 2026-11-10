// .dig export: a sandbox chip, and every chip and library part inside it, as Digital (hneemann/Digital) circuit files.
// One file per chip and per library part with a netlist of its own (each written once), placed by file name like Digital's
// own sub-circuits. Parts Digital has an element for become that element (gates, flip-flops, registers, adders,
// multiplexers, decoders, constants, splitters, ROM, RAM, LEDs, 7-segment digits, buttons, DIP switches): the inverse
// of import/digital.ts's table, so a file read back gives the same parts. Every connection is a short wire to a
// tunnel named for its net: no drawing to reproduce, and nothing joins by accident.
//
// What Digital has no element for and we have no gates for (a console, a screen, a keyboard, a behavioural memory, a
// switch-level circuit) becomes an empty circuit with the part's pins, its outputs tied to 0, and a problem line says
// so: the files still open in Digital, and the rest of the circuit runs. Element pins come from the importer's shapes
// (digitalPins), so what this writes reads back through the same code; tests/dig-export.test.ts round-trips the
// Examples gallery's chips through importDigital and compares their simulations. DOM-free.

import { digitalPins } from '../import/digital';
import { isExternal, netlistOf, type ComponentDef, type Netlist } from '../sim/types';
import { UserLibrary } from './library';
import { type PartRef, slug, type Workspace } from './model';
import { romImage } from './memory';
import { isError, partDef } from './parts';

export interface DigFile { name: string; text: string }
export interface DigExport {
  /** The top chip's file first, then the circuits it places. */
  files: DigFile[];
  top: string;
  /** Each part written as an empty circuit or changed, once per kind, with where it sits. */
  problems: string[];
  /** Nothing was left out or changed: the files compute what the chip computes. */
  exact: boolean;
}

/** Most generated circuit files one export writes; past it, library parts become empty circuits. */
export const MAX_FILES = 300;
/** Digital's widest wire. */
const MAX_BITS = 64;

type Attr = string | number | boolean | { long: bigint | number } | { data: string } | { test: string } | { inDefault: number } | { rot: number };
interface Elem { name: string; attrs: [string, Attr][]; conns: Map<string, string> }
type Conn = (port: string) => string | undefined;

/** One circuit file being written: elements joined by named nets. */
class Circ {
  readonly elems: Elem[] = [];
  private names = new Set<string>();
  private n = 0;
  constructor(readonly file: string, readonly title: string) {}

  /** A net name for this circuit (tunnels join by name), unique. */
  net(want?: string): string {
    let s = (want ?? '').replace(/[^A-Za-z0-9_.[\]]+/g, '_');
    if (!s) s = `n${++this.n}`;
    let t = s, i = 1;
    while (this.names.has(t)) t = `${s}_${++i}`;
    this.names.add(t);
    return t;
  }

  add(name: string, attrs: [string, Attr][], conns: Record<string, string | undefined>): void {
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(conns)) if (v) m.set(k, v);
    this.elems.push({ name, attrs, conns: m });
  }

  const(net: string, bits: number, value: bigint | number): void {
    this.add('Const', [['Value', { long: value }], ['Bits', bits]], { out: net });
  }
}

const XML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => XML_ESC[c]);

function attrXml(k: string, v: Attr): string {
  let val: string;
  if (typeof v === 'string') val = `<string>${esc(v)}</string>`;
  else if (typeof v === 'number') val = `<int>${v}</int>`;
  else if (typeof v === 'boolean') val = `<boolean>${v}</boolean>`;
  else if ('long' in v) val = `<long>${v.long}</long>`;
  else if ('data' in v) val = `<data>${v.data}</data>`;
  else if ('test' in v) val = `<testData>\n            <dataString>${esc(v.test)}</dataString>\n          </testData>`;
  else if ('rot' in v) val = `<rotation rotation="${v.rot}"/>`;
  else val = `<value v="${v.inDefault}" z="false"/>`;
  return `        <entry>\n          <string>${esc(k)}</string>\n          ${val}\n        </entry>\n`;
}

/** ROM contents in Digital's data syntax: every word in hex, comma-separated (no run-length shorthand: plain words are what every
 *  version of Digital reads). */
const dataOf = (words: number[]) => words.map((x) => x.toString(16)).join(',');
/** n one-bit fields, written out. */
const ones = (n: number) => Array(n).fill(1).join(',');

type Dir = 'right' | 'up' | 'left' | 'down';
const STEP: Record<Dir, [number, number]> = { right: [20, 0], up: [0, -20], left: [-20, 0], down: [0, 20] };
const ROT: Record<Dir, number> = { right: 0, up: 1, left: 2, down: 3 };
const up20 = (x: number) => Math.ceil(x / 20) * 20;

/** Places the elements in rows, each pin's tunnel one grid step out, and writes the file. */
function writeCirc(c: Circ, subs: (base: string) => { ins: string[]; outs: string[] } | undefined, description?: string): string {
  const attrsOf = (e: Elem) => Object.fromEntries(e.attrs.filter(([, v]) => typeof v !== 'object').map(([k, v]) => [k, v as string | number | boolean]));
  const placed: { e: Elem; pos: [number, number]; pins: { name: string; at: [number, number]; dir: Dir }[] }[] = [];
  const ROW_W = 2400;
  let x = 0, y = 0, rowH = 0;
  for (const e of c.elems) {
    const pins = digitalPins(e.name, attrsOf(e), subs) ?? [];
    const xs = pins.map((p) => p.at[0]), ys = pins.map((p) => p.at[1]);
    const [x0, x1, y0, y1] = pins.length ? [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)] : [0, 0, 0, 0];
    const vertical = e.name === 'Seven-Seg' || e.name === 'Seven-Seg-Hex';
    const dirOf = (p: { dir: 'in' | 'out'; at: [number, number] }): Dir => {
      if (vertical) return p.at[1] === y0 ? 'up' : 'down';
      if (pins.length === 1) return p.dir === 'out' ? 'right' : 'left';
      if (p.at[0] === x0) return 'left';
      if (p.at[0] === x1) return 'right';
      return p.at[1] === y1 ? 'down' : 'up';
    };
    const pd = pins.map((p) => ({ name: p.name, at: p.at, dir: dirOf(p) }));
    // room for each side's tunnels: a wire, the flag and its name (about 8 px a character), and the element's own body
    const reach = (d: Dir) => Math.max(0, ...pd.filter((p) => p.dir === d && e.conns.has(p.name)).map((p) => 40 + up20(8 * e.conns.get(p.name)!.length)));
    const body = 60;
    const left = Math.max(reach('left'), body), right = Math.max(reach('right'), body), top = Math.max(reach('up'), 40), bottom = Math.max(reach('down'), 40);
    const w = left + (x1 - x0) + right + 20, h = top + (y1 - y0) + bottom + 20;
    if (x > 0 && x + w > ROW_W) { x = 0; y += rowH; rowH = 0; }
    const pos: [number, number] = [up20(x + left - x0), up20(y + top - y0)];
    placed.push({ e, pos, pins: pd.map((p) => ({ ...p, at: [p.at[0] + pos[0], p.at[1] + pos[1]] as [number, number] })) });
    x += up20(w);
    rowH = Math.max(rowH, up20(h));
  }
  // a net with one end joins nothing: no tunnel for it
  const ends = new Map<string, number>();
  for (const e of c.elems) for (const n of e.conns.values()) ends.set(n, (ends.get(n) ?? 0) + 1);
  const ve: string[] = [], wires: string[] = [];
  const el = (name: string, attrs: [string, Attr][], pos: [number, number]) => {
    ve.push(`    <visualElement>\n      <elementName>${esc(name)}</elementName>\n      ${attrs.length ? `<elementAttributes>\n${attrs.map(([k, v]) => attrXml(k, v)).join('')}      </elementAttributes>` : '<elementAttributes/>'}\n      <pos x="${pos[0]}" y="${pos[1]}"/>\n    </visualElement>\n`);
  };
  for (const p of placed) {
    el(p.e.name, p.e.attrs, p.pos);
    for (const pin of p.pins) {
      const net = p.e.conns.get(pin.name);
      if (!net || (ends.get(net) ?? 0) < 2) continue;
      const s = STEP[pin.dir], t: [number, number] = [pin.at[0] + s[0], pin.at[1] + s[1]];
      wires.push(`    <wire>\n      <p1 x="${pin.at[0]}" y="${pin.at[1]}"/>\n      <p2 x="${t[0]}" y="${t[1]}"/>\n    </wire>\n`);
      el('Tunnel', [['NetName', net], ...(ROT[pin.dir] ? [['rotation', { rot: ROT[pin.dir] }] as [string, Attr]] : [])], t);
    }
  }
  return '<?xml version="1.0" encoding="utf-8"?>\n<circuit>\n  <version>2</version>\n'
    + (description ? `  <attributes>\n${attrXml('Description', description).replace(/^ {8}/gm, '    ')}  </attributes>\n` : '  <attributes/>\n')
    + `  <visualElements>\n${ve.join('')}  </visualElements>\n  <wires>\n${wires.join('')}  </wires>\n  <measurementOrdering/>\n</circuit>\n`;
}

interface Job { key: string; file: string; title: string; ins: string[]; outs: string[]; build: (c: Circ) => void; description?: string }

class Exporter {
  readonly problems = new Map<string, { msg: string; where: string[] }>();
  exact = true;
  private files = new Map<string, Job>();
  private taken = new Set<string>();
  private queue: Job[] = [];

  constructor(private lib: UserLibrary, private ws: Workspace) {}

  problem(key: string, where: string, msg: string, exact = false) {
    if (!exact) this.exact = false;
    const p = this.problems.get(key);
    if (p) { if (p.where.length < 50) p.where.push(where); } else this.problems.set(key, { msg, where: [where] });
  }

  fileName(want: string): string {
    let s = slug(want), t = s, i = 1;
    while (this.taken.has(`${t}.dig`)) t = `${s}_${++i}`;
    this.taken.add(`${t}.dig`);
    return `${t}.dig`;
  }

  subs = (base: string) => {
    const j = [...this.files.values()].find((f) => f.file.toLowerCase() === base);
    return j && { ins: j.ins, outs: j.outs };
  };

  /** The circuit file of a chip (once). */
  chipFile(id: string, top = false): Job {
    const k = `chip:${id}`;
    const hit = this.files.get(k);
    if (hit) return hit;
    const doc = this.ws.chips[id];
    const d = this.lib.defOf(id)!;
    const job: Job = {
      key: k, file: this.fileName(doc?.name ?? id), title: doc?.name ?? id,
      ins: d.ports.filter((p) => p.dir === 'in').map((p) => p.name), outs: d.ports.filter((p) => p.dir === 'out').map((p) => p.name),
      build: (c) => this.chipBody(c, id, top), description: doc?.notes,
    };
    this.files.set(k, job);
    this.queue.push(job);
    return job;
  }

  /** The circuit file of a library part from its netlist (once), or null past the cap. */
  defFile(def: ComponentDef): Job | null {
    const k = `def:${def.id}`;
    const hit = this.files.get(k);
    if (hit) return hit;
    if (this.files.size >= MAX_FILES) return null;
    const job: Job = {
      key: k, file: this.fileName(def.id), title: def.name,
      ins: def.ports.filter((p) => p.dir === 'in').map((p) => p.name), outs: def.ports.filter((p) => p.dir === 'out').map((p) => p.name),
      build: (c) => this.netlistBody(c, def), description: `${def.name}: written from the library part ${def.id}.`,
    };
    this.files.set(k, job);
    this.queue.push(job);
    return job;
  }

  /** An empty circuit with a part's pins, its outputs tied to 0 (once per definition). */
  stubFile(def: ComponentDef): Job {
    const k = `stub:${def.id}`;
    const hit = this.files.get(k);
    if (hit) return hit;
    const job: Job = {
      key: k, file: this.fileName(def.id), title: def.name,
      ins: def.ports.filter((p) => p.dir === 'in').map((p) => p.name), outs: def.ports.filter((p) => p.dir === 'out').map((p) => p.name),
      build: (c) => {
        for (const p of def.ports) {
          const n = c.net(p.name);
          if (p.dir === 'in') c.add('In', [['Label', p.name], ['Bits', p.width]], { out: n });
          else if (p.dir === 'out') { c.add('Out', [['Label', p.name], ['Bits', p.width]], { in: n }); c.const(n, p.width, 0); }
        }
      },
      description: `${def.name}: Digital has no element for it and it has no gates to write, so this circuit is empty: its outputs are 0.`,
    };
    this.files.set(k, job);
    this.queue.push(job);
    return job;
  }

  run(topId: string): DigExport {
    const top = this.chipFile(topId, true);
    const out: DigFile[] = [];
    for (let i = 0; i < this.queue.length; i++) {
      const j = this.queue[i], c = new Circ(j.file, j.title);
      j.build(c);
      out.push({ name: j.file, text: writeCirc(c, this.subs, j.description) });
    }
    const problems = [...this.problems.values()].map((p) => `${p.where.slice(0, 3).join(', ')}${p.where.length > 3 ? ` and ${p.where.length - 3} more` : ''}: ${p.msg}`);
    return { files: out, top: top.file, problems, exact: this.exact };
  }

  // ---- a chip's file: its pins, its parts by their references ----

  private chipBody(c: Circ, id: string, top: boolean) {
    const doc = this.ws.chips[id];
    const cc = this.lib.compiled(id)!;
    const nl = netlistOf(cc.def);
    const names = new Map<number, string>();
    const netOf = (key: string, want?: string): string | undefined => {
      const i = cc.netOfEnd.get(key);
      if (i === undefined || i < 0) return undefined;
      if (!names.has(i)) names.set(i, c.net(nl?.nets[i]?.name ?? want));
      return names.get(i);
    };
    const order = new Map(cc.def.ports.map((p, i) => [p.name, i]));
    const pins = [...doc.pins].sort((a, b) => (order.get(a.name) ?? 1e9) - (order.get(b.name) ?? 1e9));
    for (const dir of ['in', 'out'] as const) for (const p of pins) {
      if (p.dir === 'inout') { if (dir === 'in') this.problem(`inout:${id}:${p.name}`, `${doc.name} ▸ ${p.name}`, 'a bidirectional pin: Digital pins go one way, so it is left out'); continue; }
      if (p.dir !== dir) continue;
      if (p.width > MAX_BITS) this.problem(`wide:${id}:${p.name}`, `${doc.name} ▸ ${p.name}`, `${p.width} bits: Digital's wires carry at most ${MAX_BITS}`);
      const n = netOf(`pin:${p.id}`, p.name) ?? c.net();
      if (dir === 'in') {
        const clock = top && p.kind === 'clock';
        const attrs: [string, Attr][] = [['Label', p.name], ['Bits', p.width]];
        const v = typeof p.value === 'number' ? p.value : 0;
        if (!clock && v > 0) attrs.push(['InDefault', { inDefault: v }]);
        c.add(clock ? 'Clock' : 'In', clock ? attrs.filter(([k]) => k !== 'Bits') : attrs, { out: n });
      } else c.add('Out', [['Label', p.name], ['Bits', p.width]], { in: n });
    }
    for (const t of doc.tests ?? []) c.add('Testcase', [['Label', t.name], ['Testdata', { test: t.src }]], {});
    for (const part of doc.parts) {
      const def = partDef(part.ref, this.lib.resolver());
      const where = `${doc.name} ▸ ${part.label ?? part.id}`;
      if (isError(def)) { this.problem(`err:${id}:${part.id}`, where, `left out: ${def.error}`); continue; }
      const conn: Conn = (port) => netOf(`p:${part.id}.${port}`);
      for (const p of def.ports) if (p.dir === 'in' && !conn(p.name)) this.problem(`open:${id}:${part.id}:${p.name}`, `${where}.${p.name}`, 'an input left open: Digital needs every input connected', true);
      this.part(c, part.ref, def, conn, where, part.label);
    }
  }

  // ---- a library part's file: its netlist, instance by instance ----

  private netlistBody(c: Circ, def: ComponentDef) {
    const nl = netlistOf(def) as Netlist;
    const at = new Map<string, string>();
    nl.nets.forEach((n) => { const name = c.net(n.name); for (const e of n.ends) at.set(e, name); });
    for (const dir of ['in', 'out'] as const) for (const p of def.ports) {
      if (p.dir !== dir) continue;
      const n = at.get(p.name) ?? c.net();
      if (dir === 'in') c.add('In', [['Label', p.name], ['Bits', p.width]], { out: n });
      else c.add('Out', [['Label', p.name], ['Bits', p.width]], { in: n });
    }
    for (const inst of nl.instances) this.part(c, undefined, inst.def, (port) => at.get(`${inst.name}.${port}`), `${def.name} ▸ ${inst.name}`);
  }

  // ---- one part: a Digital element, a circuit file, or an empty circuit ----

  private part(c: Circ, ref: PartRef | undefined, def: ComponentDef, conn: Conn, where: string, label?: string) {
    if (ref && this.sandboxPart(c, ref, def, conn, where, label)) return;
    const stub = (why: string) => {
      this.problem(`stub:${def.id}`, where, `${def.name}: ${why}; written as an empty circuit with its pins (outputs 0)`);
      this.place(c, this.stubFile(def), def, conn, label);
    };
    if (isExternal(def)) return stub('a device at the edge of the circuit (a console, screen, keyboard or the like), which Digital has no element for');
    if (this.libPart(c, def, conn, label)) return;
    if (def.prim === 'alias' && def.alias) return this.alias(c, def, conn);
    if (ref && 'chip' in ref) return this.place(c, this.chipFile(ref.chip), def, conn, label);
    if (def.prim) return stub(`a ${def.prim} primitive, which Digital has no element for`);
    const nl = def.netlist && !def.preferBehavior ? netlistOf(def) : undefined;
    if (!nl) return stub(def.preferBehavior ? 'a behavioural memory or core, not written as gates' : 'a behaviour with no gates inside');
    if (nl.level === 'switch') return stub('a switch-level (transistor) circuit');
    const f = this.defFile(def);
    if (!f) return stub(`past ${MAX_FILES} circuit files`);
    // initial contents held as power-on settings of storage inside it (a TTL RAM's words): a file has no place for them
    if (Object.entries(def.powerOn ?? {}).some(([n, v]) => v === 1 && n.includes('.')))
      this.problem(`init:${def.id}`, where, `${def.name}: its initial contents are left out: Digital starts its storage at 0`);
    this.place(c, f, def, conn, label);
  }

  /** A placed circuit file: Digital's sub-circuit element, pins by name. */
  private place(c: Circ, f: Job, def: ComponentDef, conn: Conn, label?: string) {
    const conns: Record<string, string | undefined> = {};
    for (const p of def.ports) conns[p.name] = conn(p.name);
    c.add(f.file, label ? [['Label', label]] : [], conns);
  }

  /** Sandbox references Digital has an element for. */
  private sandboxPart(c: Circ, ref: PartRef, def: ComponentDef, conn: Conn, where: string, label?: string): boolean {
    const L: [string, Attr][] = label ? [['Label', label]] : [];
    if ('split' in ref) {
      const total = ref.split.reduce((a, b) => a + b, 0);
      const conns: Record<string, string | undefined> = { in0: conn('in') };
      ref.split.forEach((_, i) => (conns[`out${i}`] = conn(`o${i}`)));
      c.add('Splitter', [['Input Splitting', String(total)], ['Output Splitting', ref.split.join(',')]], conns);
      return true;
    }
    if ('merge' in ref) {
      const total = ref.merge.reduce((a, b) => a + b, 0);
      const conns: Record<string, string | undefined> = { out0: conn('out') };
      ref.merge.forEach((_, i) => (conns[`in${i}`] = conn(`i${i}`)));
      c.add('Splitter', [['Input Splitting', ref.merge.join(',')], ['Output Splitting', String(total)]], conns);
      return true;
    }
    if ('const' in ref) { c.add('Const', [['Value', { long: ref.const.value }], ['Bits', ref.const.width], ...L], { out: conn('y') }); return true; }
    if ('display' in ref) {
      const w = ref.width ?? 1, a = conn('a');
      if (ref.display === 'led' && w === 1) c.add('LED', L, { in: a });
      else if (ref.display === 'hex' && w === 4) c.add('Seven-Seg-Hex', L, { d: a });
      else if (ref.display === 'seg7' && w === 8) {
        const segs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'], nets = segs.map(() => c.net());
        c.add('Splitter', [['Input Splitting', '8'], ['Output Splitting', ones(8)]], { in0: a, ...Object.fromEntries(nets.map((n, i) => [`out${i}`, n])) });
        c.add('Seven-Seg', L, Object.fromEntries(segs.map((s, i) => [s, nets[i]])));
      } else {
        c.add('Probe', [['Label', label ?? ref.display], ['Bits', w]], { in: a });
        if (ref.display === 'halt' || ref.display === 'buzzer') this.problem(`disp:${ref.display}`, where, `a ${ref.display} part: Digital shows its value on a probe`, true);
      }
      return true;
    }
    if ('key' in ref) { c.add('Button', [['Label', label ?? ref.key]], { out: conn('q') }); return true; }
    if ('switches' in ref) {
      const n = ref.switches, nets = Array.from({ length: n }, () => c.net());
      nets.forEach((net, i) => c.add('DipSwitch', [['Label', `${label ?? 'sw'}${i}`]], { out: net }));
      if (n === 1) c.add('Splitter', [['Input Splitting', '1'], ['Output Splitting', '1']], { in0: nets[0], out0: conn('q') });
      else c.add('Splitter', [['Input Splitting', ones(n)], ['Output Splitting', String(n)]], { ...Object.fromEntries(nets.map((x, i) => [`in${i}`, x])), out0: conn('q') });
      return true;
    }
    if ('rom' in ref) {
      const r = ref.rom, a = def.ports.find((p) => p.dir === 'in'), d = def.ports.find((p) => p.dir === 'out');
      if (r.c || !a || !d || d.width !== r.w || r.k > 16) return false;
      const img = romImage(r);
      if (img.error) { this.problem(`romerr:${where}`, where, `ROM left empty: ${img.error}`); }
      // every word: past the program a byte-addressed ROM reads NOP (parts.ts wordRom), not Digital's 0
      const fill = r.addr === 'rv32' ? 0x13 : 0, mask = r.w === 32 ? 0xffffffff : (1 << r.w) - 1;
      const words = Array.from({ length: 2 ** r.k }, (_, i) => ((img.error ? fill : img.words[i] ?? fill) & mask) >>> 0);
      while (words.length && !words[words.length - 1]) words.pop();
      const one = c.net();
      c.const(one, 1, 1);
      let addr = conn(a.name);
      if (a.width !== r.k) {
        // a byte-addressed ROM (addr 'rv32'): the word address is bits [k+1:2]
        if (r.addr !== 'rv32' || a.width < r.k + 2) return false;
        const lo = c.net(), word = c.net(), hi = a.width - r.k - 2 > 0 ? c.net() : undefined;
        const parts = [2, r.k, ...(hi ? [a.width - r.k - 2] : [])].join(',');
        c.add('Splitter', [['Input Splitting', String(a.width)], ['Output Splitting', parts]], { in0: addr, out0: lo, out1: word, out2: hi });
        addr = word;
      }
      c.add('ROM', [['AddrBits', r.k], ['Bits', r.w], ['Data', { data: dataOf(words) }], ...L], { A: addr, sel: one, D: conn(d.name) });
      return true;
    }
    if ('ram' in ref) {
      const r = ref.ram;
      if ((r.ports ?? 1) > 1) return false;
      if (r.init?.some((x) => x)) this.problem(`raminit:${where}`, where, 'its initial contents are left out: Digital\'s RAM starts at 0');
      const one = c.net();
      c.const(one, 1, 1);
      c.add('RAMDualPort', [['AddrBits', r.k], ['Bits', r.w], ...L], { A: conn('addr'), Din: conn('din'), str: conn('we'), C: conn('clk'), ld: one, D: conn('dout') });
      return true;
    }
    return false;
  }

  /** Library parts Digital has an element for, by id; the ports must be exactly the ones the importer gives back. */
  private libPart(c: Circ, def: ComponentDef, conn: Conn, label?: string): boolean {
    const L: [string, Attr][] = label ? [['Label', label]] : [];
    const ports = def.ports.map((p) => `${p.dir}:${p.name}:${p.width}`).join(' ');
    const want = (s: string) => ports === s;
    const id = def.id;
    let m: RegExpExecArray | null;
    const GATE: Record<string, string> = { and: 'And', or: 'Or', xor: 'XOr', nand: 'NAnd', nor: 'NOr', xnor: 'XNOr' };
    if ((GATE[id] && want('in:a:1 in:b:1 out:y:1')) || (def.prim === 'nand' && want('in:a:1 in:b:1 out:y:1'))) {
      c.add(GATE[def.prim === 'nand' ? 'nand' : id], L, { In_1: conn('a'), In_2: conn('b'), out: conn('y') });
      return true;
    }
    if ((m = /^(and|or)(\d+)$/.exec(id))) {
      const n = +m[2];
      if (!want([...Array.from({ length: n }, (_, i) => `in:i${i}:1`), 'out:y:1'].join(' '))) return false;
      c.add(GATE[m[1]], [['Inputs', n], ...L], { ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`In_${i + 1}`, conn(`i${i}`)])), out: conn('y') });
      return true;
    }
    if ((m = /^(and|or|xor)x(\d+)$/.exec(id)) && want(`in:a:${m[2]} in:b:${m[2]} out:y:${m[2]}`)) {
      c.add(GATE[m[1]], [['Bits', +m[2]], ...L], { In_1: conn('a'), In_2: conn('b'), out: conn('y') });
      return true;
    }
    if (id === 'not' && want('in:a:1 out:y:1')) { c.add('Not', L, { in: conn('a'), out: conn('y') }); return true; }
    if (id === 'dff' && want('in:d:1 in:clk:1 out:q:1')) { c.add('D_FF', L, { D: conn('d'), C: conn('clk'), Q: conn('q') }); return true; }
    if ((m = /^reg(\d+)$/.exec(id)) && want(`in:d:${m[1]} in:en:1 in:clk:1 out:q:${m[1]}`)) {
      c.add('Register', [['Bits', +m[1]], ...L], { D: conn('d'), C: conn('clk'), en: conn('en'), Q: conn('q') });
      return true;
    }
    if ((m = /^rca(\d+)$/.exec(id)) && want(`in:a:${m[1]} in:b:${m[1]} in:cin:1 out:s:${m[1]} out:cout:1`)) {
      c.add('Add', [['Bits', +m[1]], ...L], { a: conn('a'), b: conn('b'), c_i: conn('cin'), s: conn('s'), c_o: conn('cout') });
      return true;
    }
    if ((m = /^mux2x(\d+)$/.exec(id)) && want(`in:a:${m[1]} in:b:${m[1]} in:s:1 out:y:${m[1]}`)) {
      c.add('Multiplexer', [['Bits', +m[1]], ['Selector Bits', 1], ...L], { in_0: conn('a'), in_1: conn('b'), sel: conn('s'), out: conn('y') });
      return true;
    }
    if ((m = /^mux(\d+)x(\d+)$/.exec(id))) {
      const n = +m[1], w = +m[2], k = Math.log2(n);
      if (!Number.isInteger(k) || k < 2 || !want([...Array.from({ length: n }, (_, i) => `in:d${i}:${w}`), `in:s:${k}`, `out:y:${w}`].join(' '))) return false;
      c.add('Multiplexer', [['Bits', w], ['Selector Bits', k], ...L], { ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`in_${i}`, conn(`d${i}`)])), sel: conn('s'), out: conn('y') });
      return true;
    }
    if ((m = /^dec(\d+)$/.exec(id))) {
      const k = +m[1];
      if (!want([`in:a:${k}`, ...Array.from({ length: 1 << k }, (_, i) => `out:y${i}:1`)].join(' '))) return false;
      c.add('Decoder', [['Selector Bits', k], ...L], { sel: conn('a'), ...Object.fromEntries(Array.from({ length: 1 << k }, (_, i) => [`out_${i}`, conn(`y${i}`)])) });
      return true;
    }
    // a constant: no inputs, a stateless behaviour
    if (def.behavior && !def.behavior.seq && !def.behavior.init && def.ports.every((p) => p.dir === 'out' && p.width <= 53)) {
      let v: number[];
      try { v = def.behavior.eval([], undefined); } catch { return false; }
      if (v.length !== def.ports.length || v.some((x) => !Number.isSafeInteger(x) || x < 0)) return false;
      def.ports.forEach((p, i) => c.add('Const', [['Value', { long: v[i] }], ['Bits', p.width]], { out: conn(p.name) }));
      return true;
    }
    return false;
  }

  /** A wiring box (split, merge, zero-extend, any bit map): each input port spread to bits, each output port gathered from them. */
  private alias(c: Circ, def: ComponentDef, conn: Conn) {
    const parent = new Map<string, string>();
    const find = (x: string): string => { while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!; return x; };
    for (const [pa, ba, pb, bb] of def.alias!) {
      const [x, y] = [find(`${pa}#${ba}`), find(`${pb}#${bb}`)];
      if (x !== y) parent.set(y, x);
    }
    const bitNet = new Map<string, string>();
    const net = (port: string, b: number) => {
      const r = find(`${port}#${b}`);
      if (!bitNet.has(r)) bitNet.set(r, c.net());
      return bitNet.get(r)!;
    };
    for (const p of def.ports) {
      const bits = Array.from({ length: p.width }, (_, b) => net(p.name, b));
      const many = ones(p.width);
      if (p.dir === 'in') c.add('Splitter', [['Input Splitting', String(p.width)], ['Output Splitting', many]], { in0: conn(p.name), ...Object.fromEntries(bits.map((n, i) => [`out${i}`, n])) });
      else if (p.dir === 'out') c.add('Splitter', [['Input Splitting', many], ['Output Splitting', String(p.width)]], { ...Object.fromEntries(bits.map((n, i) => [`in${i}`, n])), out0: conn(p.name) });
    }
  }
}

/** A chip and everything inside it as Digital circuit files. `ws` holds the chip and the chips it places. */
export function digExport(ws: Workspace, topId: string): DigExport {
  if (!ws.chips[topId]) throw new Error(`no chip ${topId}`);
  return new Exporter(new UserLibrary(ws), ws).run(topId);
}
