// The memory-map designer's model (DOM-free; the dialog is memmapui.ts). A sandbox chip with a bus (the sandbox's
// bundled interconnect, lib/axi.ts sandboxBus: two masters, slave k answers the addresses whose top nibble is
// codes[k], the last slave is the default) has a map: one region per decoded slave. The bus decodes a[31:28] only,
// so every region owns a window of 256 MiB at base = nibble << 28 and `used` says how much of it the device fills
// (a split of one window on a[27:24] would need a second decoder level the bus does not have: left out). The map is
// read from the chip (the bus part's codes and the slaves wired to its ports, by wire or by pointer name) and written
// back by applyMap (pure: a new ChipDoc, which the dialog hands to Editor.edit, so one Apply is one undo step), which
// swaps the bus part for one with the new codes, moves the slaves' links to the new ports (their pointer names kept),
// places the parts of new regions and takes out those of removed ones. busMapOf gives the golden model (bus/model.ts
// BusDevices.map) the same nibbles; cHeader / linkerScript export it; decoderDef is the decoder as a chip.

import { MAP } from '../bus/model';
import { sandboxBus, BUS_DRAM } from '../lib/axi';
import { memmapDecoder } from '../lib/memmapdec';
import { SANDBOX_PARTS } from '../lib/soc';
import { SANDBOX_SOURCE } from '../bus/programs';
import { instPort, symbolGeom, type Vec } from '../sim/geometry';
import type { ComponentDef } from '../sim/types';
import type { ChipDoc, EndRef, LabelDoc, PartDoc, PartRef, WireDoc } from './model';
import { nextId, uniqueName } from './model';
import { isError, partDef } from './parts';

/** The size of every window: a[27:0]. */
export const WINDOW = 2 ** 28;
/** The number of windows (a[31:28]). */
export const WINDOWS = 16;

export type Kind = 'ram' | 'flash' | 'dram' | 'screen' | 'io' | 'dma' | 'other';

export interface KindInfo {
  label: string;
  /** What the region holds, for the panel. */
  about: string;
  /** Can Apply place a new one? (The DMA registers are the DMA engine itself: only moved.) */
  placeable: boolean;
  /** The CSS hue class of its colour. */
  tone: 'ram' | 'flash' | 'dram' | 'screen' | 'io' | 'dev';
}

export const KINDS: Record<Kind, KindInfo> = {
  ram: { label: 'RAM', about: 'axiRam: four byte lanes, answers the cycle after the address', placeable: true, tone: 'ram' },
  flash: { label: 'Flash', about: 'axiFlashWindow over a ROM part that holds the contents; read only', placeable: true, tone: 'flash' },
  dram: { label: 'DRAM', about: 'chapter 36\'s controller and device behind one slave', placeable: true, tone: 'dram' },
  screen: { label: 'Screen', about: 'a store to base + 256·y + 4·x paints pixel (x, y)', placeable: true, tone: 'screen' },
  io: { label: 'Keys + timer', about: 'keyboard at +0 / +4, timer count and irq at +8 / +12', placeable: true, tone: 'io' },
  dma: { label: 'DMA registers', about: 'src, dst, len, ctrl: the DMA engine\'s own slave port (moved, not added)', placeable: false, tone: 'io' },
  other: { label: 'Other slave', about: 'a part this designer does not know: kept as it is', placeable: false, tone: 'dev' },
};

/** The kinds the palette offers, in order. */
export const PALETTE: Kind[] = ['ram', 'flash', 'dram', 'screen', 'io'];

/** How a slave is joined to the bus: the pointer names of its two links (or wires drawn straight between the parts). */
export interface Link { req: string; rsp: string; direct: boolean }

export interface Region {
  /** The slave part's instance name on the chip (a new region's is made by newRegion). */
  id: string;
  kind: Kind;
  /** The first address of its window. Anything but a multiple of 256 MiB is a problem. */
  base: number;
  /** Bytes the device answers (the rest of the window reads 0 / ignores writes inside the part). */
  used: number;
  /** Extra words for the panel: "64 × 64", "16 KiB". */
  detail: string;
  link?: Link;
}

export interface MemMap {
  /** The bus part's instance name. */
  bus: string;
  /** Decoded slaves, in the bus's slave order (apply sorts them by base). */
  regions: Region[];
  /** The last slave: answers every address no region claims. */
  fallback: { id: string; link?: Link };
}

export const hex8 = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, '0').replace(/^(.{4})/, '$1_')}`;
export const nibbleOf = (r: Region) => Math.floor(r.base / WINDOW);
const fmtBytes = (n: number) => (n >= 2 ** 30 ? `${n / 2 ** 30} GiB` : n >= 2 ** 20 ? `${n / 2 ** 20} MiB` : n >= 1024 ? `${n / 1024} KiB` : `${n} B`);
export { fmtBytes };

/** The display name of each region: its kind's label, numbered when several share one. */
export function names(map: MemMap): string[] {
  const seen = new Map<Kind, number>(), total = new Map<Kind, number>();
  for (const r of map.regions) total.set(r.kind, (total.get(r.kind) ?? 0) + 1);
  return map.regions.map((r) => {
    const n = (seen.get(r.kind) ?? 0) + 1;
    seen.set(r.kind, n);
    return KINDS[r.kind].label + (total.get(r.kind)! > 1 ? ` ${n}` : '');
  });
}

// ---- problems -----------------------------------------------------------------------------------------------

export interface Problem {
  kind: 'overlap' | 'misaligned' | 'range' | 'count';
  /** Indices into map.regions. */
  regions: number[];
  text: string;
}

export interface Analysis {
  problems: Problem[];
  /** Windows no region claims (a[31:28] values): they go to the default slave. */
  free: number[];
}

export function analyze(map: MemMap): Analysis {
  const nm = names(map), problems: Problem[] = [];
  const claimed = new Map<number, number[]>();
  map.regions.forEach((r, i) => {
    if (!Number.isInteger(r.base) || r.base < 0 || r.base >= 2 ** 32) {
      problems.push({ kind: 'range', regions: [i], text: `${nm[i]}: the base is not an address (0 … 0xFFFF_FFFF).` });
      return;
    }
    if (r.base % WINDOW !== 0) {
      const fix = Math.floor(r.base / WINDOW) * WINDOW;
      problems.push({ kind: 'misaligned', regions: [i], text: `${nm[i]} at ${hex8(r.base)} is not aligned to its 256 MiB window: the bus decodes a[31:28] only. Use ${hex8(fix)}.` });
      return;
    }
    const n = r.base / WINDOW;
    claimed.set(n, [...(claimed.get(n) ?? []), i]);
  });
  const free = Array.from({ length: WINDOWS }, (_, n) => n).filter((n) => !claimed.has(n));
  for (const [n, who] of [...claimed].sort((a, b) => a[0] - b[0])) {
    if (who.length < 2) continue;
    const spot = free.find((f) => !claimed.has(f));
    problems.push({
      kind: 'overlap', regions: who,
      text: `${who.map((i) => nm[i]).join(' and ')} both sit at ${hex8(n * WINDOW)}: both would answer the same reads.${spot !== undefined ? ` Move one to the free window ${hex8(spot * WINDOW)}.` : ' No window is free: remove one.'}`,
    });
  }
  if (map.regions.length > WINDOWS) problems.push({ kind: 'count', regions: [], text: `${map.regions.length} regions, but a[31:28] has ${WINDOWS} windows.` });
  if (map.regions.length === 0) problems.push({ kind: 'count', regions: [], text: 'No region: the bus needs at least one slave besides the default.' });
  return { problems, free };
}

// ---- reading a chip --------------------------------------------------------------------------------------------

const BUS_RE = /^axibus2_(\d+(?:_\d+)*)_b$/;
const isBus = (p: PartDoc) => 'lib' in p.ref && BUS_RE.test(p.ref.lib);
const same = (a: EndRef, b: EndRef) => JSON.stringify(a) === JSON.stringify(b);
const isPart = (e: EndRef): e is { part: string; port: string } => 'part' in e;

/** Is the chip's bus one this designer can edit? The bus part's id, else null. */
export function busOf(doc: ChipDoc): PartDoc | null {
  return doc.parts.find(isBus) ?? null;
}
/** The File menu's test: a chip with the sandbox's bundled interconnect. */
export const hasBus = (doc: ChipDoc) => !!busOf(doc);

/** What the other end(s) of `e` are: through its wires, and through the pointers of the same name. */
function peers(doc: ChipDoc, e: EndRef): { ends: EndRef[]; label?: string; direct: boolean } {
  const out: EndRef[] = [];
  let label: string | undefined, direct = true;
  const other = (w: WireDoc) => (same(w.a, e) ? w.b : same(w.b, e) ? w.a : null);
  for (const w of doc.wires) {
    const o = other(w);
    if (!o) continue;
    if ('label' in o) {
      direct = false;
      const l = doc.labels.find((x) => x.id === o.label);
      if (!l) continue;
      label = l.name;
      for (const twin of doc.labels) {
        if (twin.name !== l.name) continue;
        for (const w2 of doc.wires) {
          const t = { label: twin.id };
          const o2 = same(w2.a, t) ? w2.b : same(w2.b, t) ? w2.a : null;
          if (o2 && !same(o2, e)) out.push(o2);
        }
      }
    } else out.push(o);
  }
  return { ends: out, label, direct };
}

interface Info { kind: Kind; used: number; detail: string }
const ID = Object.fromEntries(Object.entries(SANDBOX_PARTS).map(([k, d]) => [k, d.id])) as Record<keyof typeof SANDBOX_PARTS, string>;

function infoOf(doc: ChipDoc, p: PartDoc): Info {
  const id = 'lib' in p.ref ? p.ref.lib : '';
  let m: RegExpMatchArray | null;
  if ((m = id.match(/^axiram(\d+)_(\d+)_b$/))) { const used = 4 * 2 ** +m[1]; return { kind: 'ram', used, detail: fmtBytes(used) }; }
  if ((m = id.match(/^axiflashwin(\d+)_\d+_b$/))) { const used = 4 * 2 ** +m[1]; return { kind: 'flash', used, detail: `read only · ${fmtBytes(used)}` }; }
  if (id === ID.dram || /^axidram\d+_/.test(id)) { const used = 4 * 2 ** BUS_DRAM.k; return { kind: 'dram', used, detail: fmtBytes(used) }; }
  if (id === ID.pixel) {
    // the screen part beside it: pointer-joined through x
    const scr = peers(doc, { part: p.id, port: 'x' }).ends.find(isPart);
    const sp = scr && doc.parts.find((q) => q.id === scr.part);
    const n = sp && 'screen' in sp.ref ? sp.ref.screen.size : 64;
    return { kind: 'screen', used: 256 * n, detail: `${n} × ${n}` };
  }
  if (id === ID.io) return { kind: 'io', used: 16, detail: 'keys +0, timer +8' };
  if (id === ID.dma) return { kind: 'dma', used: 16, detail: 'src dst len ctrl' };
  return { kind: 'other', used: 0, detail: id || 'part' };
}

/** The chip's memory map, or why it has none. */
export function readMap(doc: ChipDoc): MemMap | { error: string } {
  const bus = busOf(doc);
  if (!bus) return { error: 'This chip has no bus interconnect (Examples ▸ System on a bus has one).' };
  const codes = (bus.ref as { lib: string }).lib.match(BUS_RE)![1].split('_').map(Number);
  const slaves = codes.map((code, k) => {
    const rq = peers(doc, { part: bus.id, port: `s${k}_req` });
    const target = rq.ends.find((e): e is { part: string; port: string } => isPart(e) && e.port === 'req');
    const part = target && doc.parts.find((p) => p.id === target.part);
    if (!part) return { code, k, part: null as PartDoc | null, link: undefined as Link | undefined };
    const rsp = peers(doc, { part: bus.id, port: `s${k}_rsp` });
    const link: Link = { req: rq.label ?? `${part.id}_req`, rsp: rsp.label ?? `${part.id}_rsp`, direct: rq.direct };
    return { code, k, part, link };
  });
  const missing = slaves.findIndex((s) => !s.part);
  if (missing >= 0) return { error: `The bus's slave ${missing} (s${missing}_req) is not wired to a part's req port: connect it first.` };
  const last = slaves[slaves.length - 1];
  const regions: Region[] = slaves.slice(0, -1).map((s) => {
    const i = infoOf(doc, s.part!);
    return { id: s.part!.id, kind: i.kind, base: s.code * WINDOW, used: i.used, detail: i.detail, link: s.link };
  });
  return { bus: bus.id, regions, fallback: { id: last.part!.id, link: last.link } };
}

/** The golden model's view of a map (bus/model.ts BusDevices.map): the top nibble of each device it models. */
export function busMapOf(map: MemMap): Partial<Record<keyof typeof MAP, number>> {
  const out: Partial<Record<keyof typeof MAP, number>> = {};
  const key: Partial<Record<Kind, keyof typeof MAP>> = { ram: 'ram', flash: 'flash', dram: 'dram', screen: 'screen', io: 'keys', dma: 'dma' };
  for (const r of map.regions) { const k = key[r.kind]; if (k && !(k in out)) out[k] = r.base / WINDOW; }
  return out;
}

// ---- editing the map ---------------------------------------------------------------------------------------

/** A new region of `kind` in window `nibble` (its part is placed by applyMap). */
export function newRegion(map: MemMap, kind: Kind, nibble: number, partIds: Iterable<string> = []): Region {
  const taken = [...map.regions.map((r) => r.id), map.fallback.id, ...partIds];
  const info: Record<Kind, [number, string]> = {
    ram: [4 * 2 ** 12, '16 KiB'], flash: [4 * 2 ** 8, 'read only · 1 KiB'], dram: [4 * 2 ** BUS_DRAM.k, '16 KiB'],
    screen: [256 * 64, '64 × 64'], io: [16, 'keys +0, timer +8'], dma: [16, ''], other: [0, ''],
  };
  return { id: uniqueName(kind, taken), kind, base: nibble * WINDOW, used: info[kind][0], detail: info[kind][1] };
}

export const withRegion = (map: MemMap, i: number, patch: Partial<Region>): MemMap => ({ ...map, regions: map.regions.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
export const withoutRegion = (map: MemMap, i: number): MemMap => ({ ...map, regions: map.regions.filter((_, k) => k !== i) });

/** Move region i to window `nibble` (clamped to 0 … 15). A window already taken is allowed: that is the overlap problem, shown. */
export function moveTo(map: MemMap, i: number, nibble: number): MemMap {
  return withRegion(map, i, { base: Math.max(0, Math.min(WINDOWS - 1, nibble)) * WINDOW });
}

/** Is the map as the chip has it? (The Apply button's enabled test.) */
export function sameMap(a: MemMap, b: MemMap): boolean {
  return a.regions.length === b.regions.length && a.regions.every((r, i) => r.id === b.regions[i].id && r.base === b.regions[i].base && r.kind === b.regions[i].kind);
}

// ---- writing it back -------------------------------------------------------------------------------------------

const exitStep: Record<string, Vec> = { left: [-2, 0], right: [2, 0], up: [0, -2], down: [0, 2] };

const heightOf = (ref: PartRef): number => { try { return symbolGeom(defOf(ref)).h; } catch { return 10; } };

function defOf(ref: PartRef): ComponentDef {
  const d = partDef(ref, () => undefined);
  if (isError(d)) throw new Error(d.error);
  return d;
}

/** The parts and pointers of a new slave of `kind`, at `at` (devices to its right). */
function slaveParts(kind: Kind, id: string, at: Vec, taken: Set<string>): { parts: PartDoc[]; taps: [string, string][]; pairs: [string, string, string][] } {
  const lib = (k: keyof typeof SANDBOX_PARTS): PartRef => ({ lib: SANDBOX_PARTS[k].id });
  const slaveRef = { ram: lib('ram'), flash: lib('flash'), dram: lib('dram'), screen: lib('pixel'), io: lib('io'), dma: lib('dma'), other: lib('def') }[kind];
  const parts: PartDoc[] = [{ id, ref: slaveRef, at, label: KINDS[kind].label }];
  const pairs: [string, string, string][] = [];
  const w = symbolGeom(defOf(slaveRef)).w, x = at[0] + w + 18;
  const dev = (name: string, ref: PartRef, y: number, label?: string) => {
    const did = uniqueName(`${id}_${name}`, taken);
    taken.add(did);
    parts.push({ id: did, ref, at: [x, y], label });
    return did;
  };
  if (kind === 'flash') {
    const rom = dev('contents', { rom: { k: 8, w: 32, addr: 'word', lang: 'asm', src: SANDBOX_SOURCE } }, at[1], 'flash contents');
    pairs.push([`${id}.addr`, `${rom}.addr`, `${id}_addr`], [`${rom}.data`, `${id}.data`, `${id}_data`]);
  } else if (kind === 'screen') {
    const scr = dev('screen', { screen: { mode: 'write', size: 64, color: 'rgb332' } }, at[1], 'screen');
    for (const [a, b] of [['x', 'x'], ['y', 'y'], ['color', 'color'], ['we', 'we']]) pairs.push([`${id}.${a}`, `${scr}.${b}`, `${id}_${a}`]);
  } else if (kind === 'io') {
    const kbd = dev('keyboard', { keyboard: true }, at[1], 'keyboard');
    const h = symbolGeom(defOf({ keyboard: true })).h;
    const tmr = dev('timer', { lib: 'timer1000' }, at[1] + h + 6, 'timer');
    const cnt = dev('count', { split: [8, 2] }, at[1] + h + 8 + symbolGeom(defOf({ lib: 'timer1000' })).h, 'timer count');
    pairs.push([`${id}.kack`, `${kbd}.ack`, `${id}_kack`], [`${kbd}.code`, `${id}.code`, `${id}_kcode`], [`${kbd}.ready`, `${id}.ready`, `${id}_kready`],
      [`${tmr}.irq`, `${id}.irq`, `${id}_tirq`], [`${id}.tack`, `${tmr}.ack`, `${id}_tack`], [`${tmr}.count`, `${cnt}.in`, `${id}_tcount`], [`${cnt}.o0`, `${id}.count`, `${id}_tcount8`]);
  }
  return { parts, taps: [], pairs };
}

/**
 * The chip with `map` applied: the bus swapped for one with the new codes (regions sorted by base, the default
 * slave last), every slave's links moved to its new ports with the pointer names it had, new regions' parts placed
 * in a column below the slaves, removed regions' slave parts taken out (devices they drove stay on the canvas).
 */
export function applyMap(doc: ChipDoc, map: MemMap): ChipDoc {
  const bus = doc.parts.find((p) => p.id === map.bus);
  if (!bus) throw new Error(`no bus part '${map.bus}'`);
  const problems = analyze(map).problems;
  if (problems.length) throw new Error(problems[0].text);
  const order = [...map.regions].sort((a, b) => a.base - b.base);
  const codes = [...order.map(nibbleOf), 0xf];
  const busDef = sandboxBus(codes);
  const newBus: PartDoc = { ...bus, ref: { lib: busDef.id } };

  const parts = doc.parts.map((p) => (p.id === bus.id ? newBus : p));
  let wires = [...doc.wires], labels = [...doc.labels];
  const wid = () => nextId('w', wires.map((w) => w.id));
  const lid = () => nextId('l', labels.map((l) => l.id));
  const dropWires = (pred: (w: WireDoc) => boolean) => {
    const gone = wires.filter(pred);
    wires = wires.filter((w) => !pred(w));
    // pointers nothing reaches any more
    const used = new Set(wires.flatMap((w) => [w.a, w.b]).filter((e): e is { label: string } => 'label' in e).map((e) => e.label));
    for (const w of gone) for (const e of [w.a, w.b]) if ('label' in e && !used.has(e.label)) labels = labels.filter((l) => l.id !== e.label);
  };
  const touches = (w: WireDoc, f: (e: { part: string; port: string }) => boolean) => [w.a, w.b].some((e) => isPart(e) && f(e));
  const tap = (part: string, ref: PartRef, at: Vec, flip: boolean | undefined, rot: PartDoc['rot'], port: string, name: string) => {
    const g = instPort(defOf(ref), at, flip, port, rot);
    const d = exitStep[g.exit];
    const l: LabelDoc = { id: lid(), name, at: [g.pos[0] + d[0], g.pos[1] + d[1]], face: g.exit };
    labels.push(l);
    wires.push({ id: wid(), a: { part, port }, b: { label: l.id }, pts: [] });
  };

  // slaves leaving (not in the new map, nor the default)
  const keep = new Set([...map.regions.map((r) => r.id), map.fallback.id]);
  const old = readMap(doc);
  if ('error' in old) throw new Error(old.error);
  const leaving = old.regions.filter((r) => !keep.has(r.id)).map((r) => r.id);
  dropWires((w) => touches(w, (e) => e.part === bus.id && /^s\d+_(req|rsp)$/.test(e.port)));
  for (const id of leaving) dropWires((w) => touches(w, (e) => e.part === id));
  let outParts = parts.filter((p) => !leaving.includes(p.id));

  // new slaves: a column below the others
  const slaveIds = [...old.regions.map((r) => r.id), old.fallback.id].filter((id) => !leaving.includes(id));
  const col = outParts.filter((p) => slaveIds.includes(p.id));
  const busW = symbolGeom(busDef).w;
  const x = col.length ? Math.min(...col.map((p) => p.at[0])) : bus.at[0] + busW + 18;
  let y = col.length ? Math.max(...col.map((p) => p.at[1] + heightOf(p.ref))) + 6 : bus.at[1];
  const takenIds = new Set(outParts.map((p) => p.id));
  const clkName = peers(doc, { part: bus.id, port: 'clk' }).label ?? 'clk';
  const fresh: Region[] = [];
  const pairLabels: [string, string, string][] = [];
  for (const r of order) {
    if (keep.has(r.id) && old.regions.some((o) => o.id === r.id)) continue;
    const made = slaveParts(r.kind, r.id, [x, y], takenIds);
    for (const p of made.parts) takenIds.add(p.id);
    outParts = [...outParts, ...made.parts];
    y += symbolGeom(defOf(made.parts[0].ref)).h + 6;
    pairLabels.push(...made.pairs);
    fresh.push(r);
  }
  // direct wires between a slave and the bus become pointers (the slave's end needs its own)
  const labelNames = () => new Set(labels.map((l) => l.name));
  const linkOf = new Map<string, Link>();
  for (const r of [...map.regions, { id: map.fallback.id, link: map.fallback.link } as Region]) {
    const taken = labelNames();
    const link = r.link ?? { req: uniqueName(`${r.id}_req`, taken), rsp: uniqueName(`${r.id}_rsp`, taken), direct: false };
    for (const l of [link.req, link.rsp]) taken.add(l);
    linkOf.set(r.id, link);
  }
  const partOf = (id: string) => outParts.find((p) => p.id === id)!;
  // slave side of a direct or new link: its own pointers
  const slaveSide = new Set([...fresh.map((r) => r.id), ...old.regions.filter((r) => r.link?.direct).map((r) => r.id), ...(old.fallback.link?.direct ? [old.fallback.id] : [])]);
  for (const id of slaveSide) {
    const p = partOf(id), lk = linkOf.get(id)!;
    if (!p) continue;
    const ref = p.ref;
    tap(id, ref, p.at, p.flip, p.rot, 'req', lk.req);
    tap(id, ref, p.at, p.flip, p.rot, 'rsp', lk.rsp);
    if (fresh.some((r) => r.id === id)) tap(id, ref, p.at, p.flip, p.rot, 'clk', clkName);
  }
  // the pairs of new devices
  for (const [a, b, name] of pairLabels) for (const e of [a, b]) {
    const [pid, port] = e.split('.');
    const p = partOf(pid);
    tap(pid, p.ref, p.at, p.flip, p.rot, port, name);
  }
  // bus side: slave k at port s<k>
  [...order, { id: map.fallback.id } as Region].forEach((r, k) => {
    const lk = linkOf.get(r.id)!;
    tap(bus.id, newBus.ref, bus.at, bus.flip, bus.rot, `s${k}_req`, lk.req);
    tap(bus.id, newBus.ref, bus.at, bus.flip, bus.rot, `s${k}_rsp`, lk.rsp);
  });
  return { ...doc, parts: outParts, wires, labels };
}

// ---- the decoder, and the exports ---------------------------------------------------------------------------

/** The decoder of a map as a chip's definition: a select line per region (bus order), then the default slave's. */
export function decoderDef(map: MemMap): ComponentDef {
  const order = [...map.regions].sort((a, b) => a.base - b.base);
  const nm = names(map);
  return memmapDecoder(order.map((r) => ({ name: nm[map.regions.indexOf(r)], code: nibbleOf(r) })));
}

/** "a31' · a30 · a29' · a28" for a window's code. */
export function equation(nibble: number): string {
  return [3, 2, 1, 0].map((b) => `a${28 + b}${(nibble >> b) & 1 ? '' : '′'}`).join(' · ');
}
export const bits4 = (n: number) => n.toString(2).padStart(4, '0');

const C_TOKEN: Record<Kind, string> = { ram: 'RAM', flash: 'FLASH', dram: 'DRAM', screen: 'SCREEN', io: 'IO', dma: 'DMA', other: 'DEV' };
/** The C identifier of each region: RAM, FLASH, DRAM, SCREEN, IO, DMA; a second of a kind is RAM2. */
export function cNames(map: MemMap): string[] {
  const seen = new Map<Kind, number>();
  return map.regions.map((r) => { const n = (seen.get(r.kind) ?? 0) + 1; seen.set(r.kind, n); return C_TOKEN[r.kind] + (n > 1 ? n : ''); });
}
const hexw = (n: number) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}u`;

/** A C header: BASE and SIZE (the bytes the device answers) of every region, WINDOW once. */
export function cHeader(map: MemMap, chip: string): string {
  const nm = names(map), cn = cNames(map);
  const rows = map.regions.map((r, i) => ({ r, n: cn[i], label: nm[i] })).sort((a, b) => a.r.base - b.r.base);
  const w = Math.max(...rows.map((x) => x.n.length), 6);
  return [
    `/* Memory map of "${chip}": the bus decodes a[31:28], so every region owns a 256 MiB window.`,
    ' * Generated by the memory-map designer (MOSFET to RISC-V). SIZE is what the device answers. */',
    '#ifndef MEMORY_MAP_H',
    '#define MEMORY_MAP_H',
    '',
    `#define MMAP_WINDOW ${hexw(WINDOW)}`,
    '',
    ...rows.flatMap(({ r, n, label }) => [`/* ${label}${r.detail ? ` (${r.detail})` : ''} */`, `#define ${(n + '_BASE').padEnd(w + 5)} ${hexw(r.base)}`, `#define ${(n + '_SIZE').padEnd(w + 5)} ${hexw(r.used)}`]),
    '',
    '#endif',
    '',
  ].join('\n');
}

/** A linker script's MEMORY block for the regions that hold code and data, and PROVIDEd symbols for the devices. */
export function linkerScript(map: MemMap, chip: string): string {
  const cn = cNames(map);
  const rows = map.regions.map((r, i) => ({ r, n: cn[i] })).sort((a, b) => a.r.base - b.r.base);
  const mem = rows.filter(({ r }) => r.kind === 'ram' || r.kind === 'flash' || r.kind === 'dram');
  const len = (n: number) => (n >= 1024 && n % 1024 === 0 ? `${n / 1024}K` : `${n}`);
  const dev = rows.filter(({ r }) => !mem.some((m) => m.r === r));
  return [
    `/* Memory map of "${chip}" (memory-map designer): the regions with code and data. */`,
    'MEMORY',
    '{',
    ...mem.map(({ r, n }) => `  ${n.padEnd(8)} (${r.kind === 'flash' ? 'rx' : 'rwx'}) : ORIGIN = ${hexw(r.base).replace('u', '')}, LENGTH = ${len(r.used)}`),
    '}',
    '',
    ...(dev.length ? ['/* Devices: their first address, for the program. */', ...dev.map(({ r, n }) => `PROVIDE(__${n.toLowerCase()}_base = ${hexw(r.base).replace('u', '')});`), ''] : []),
  ].join('\n');
}
