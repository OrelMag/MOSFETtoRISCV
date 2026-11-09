// Chapter 'vmem' (Virtual memory): the explainers beside the gate-level scenes. Every value comes from a model that the gates are
// held to: the Sv32 walk is the golden model's ISS.walk on a page table built in its memory (step 4), the permission rules are
// sim/pteinfo.ts (held equal to ISS.walk by tests/content-vmem.test.ts), the TLB is sim/tlbmodel.ts (held equal to the gates'
// stalls by tests/vm-chapter.test.ts) and the NANDs are counted from lib/vm.ts's own generators.

import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { ISS, type Walk } from '../riscv/iss';
import { BENCHMARKS, benchSource } from '../riscv/benchprograms';
import { assemble } from '../riscv/asm';
import { ACCESSES, PTE_BITS, faultCause, leafOutcome, type Access } from '../sim/pteinfo';
import { type Pattern, TlbModel, missesOf, pagesOf } from '../sim/tlbmodel';
import { SUPER_CYCLES, WALK_CYCLES, vmPte, VM_A, VM_D, VM_R, VM_U, VM_V, VM_W, VM_X } from '../riscv/vmprograms';
import { tlb } from '../lib/vm';
import { stats } from '../sim/stats';
import { systemCpu } from '../lib/system';
import { withoutParts } from '../lib/tech';
import { groupDigits } from '../sim/numfmt';
import '../styles/vmem.css';

const hex = (v: number, d = 0) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');
const hexg = (v: number) => { const t = (v >>> 0).toString(16).toUpperCase().padStart(8, '0'); return `0x${t.slice(0, 4)}_${t.slice(4)}`; };

function seg<T extends string | number>(opts: [T, string][], get: () => T, set: (v: T) => void, label: string) {
  const g = h('span', { class: 'seg', role: 'group', 'aria-label': label });
  const btns = opts.map(([v, l]) => {
    const b = h('button', { type: 'button' }, l);
    b.addEventListener('click', () => set(v));
    g.append(b);
    return [v, b] as const;
  });
  return { el: g, sync: () => btns.forEach(([v, b]) => { b.classList.toggle('on', v === get()); b.setAttribute('aria-pressed', String(v === get())); }) };
}

// ---- step 1: two programs, one memory -------------------------------------------------------------------------------------

const FRAMES = 8;
type Scheme = 'none' | 'base' | 'paging';

/**
 * Where program A (3 pages), program B (2 pages) and then program C (3 pages) land in eight 4 KiB frames, with no translation, with
 * a base register (each program one contiguous block) and with pages (any free frame). A and B are already running and have
 * left frames behind; C needs room.
 */
export function placement(scheme: Scheme, withC: boolean): { frames: (string | null)[]; fits: boolean; note: string } {
  const frames: (string | null)[] = new Array(FRAMES).fill(null);
  if (scheme === 'none') {
    // both are linked to start at address 0: B's pages are A's frames
    ['A', 'A', 'A'].forEach((p, i) => (frames[i] = p));
    ['B', 'B'].forEach((p, i) => (frames[i] = p));
    return { frames, fits: !withC, note: 'Both programs were linked to start at address 0, so B\'s two pages are the first two frames of A: whoever wrote last owns them.' };
  }
  // A in frames 0-2, B in 4-5 after a program of frame 3 (gone now) sat between them; 6-7 free at the end
  ['A', 'A', 'A'].forEach((p, i) => (frames[i] = p));
  ['B', 'B'].forEach((p, i) => (frames[4 + i] = p));
  if (!withC) return { frames, fits: true, note: scheme === 'base' ? 'Each program is one contiguous block; a base register added to every address puts it there.' : 'Each page of each program sits in any frame; the page table says which.' };
  if (scheme === 'base') {
    // contiguous 3 frames needed: the free frames are 3, 6, 7
    return { frames, fits: false, note: 'Three frames are free (3, 6 and 7) but no three in a row: C does not fit, though there is room.' };
  }
  [3, 6, 7].forEach((f) => (frames[f] = 'C'));
  return { frames, fits: true, note: 'C takes the three free frames wherever they are; its page table hides that its pages are not in a row.' };
}

export function spacesWidget(): Widget {
  let scheme: Scheme = 'none', withC = false;
  const out = h('div', { class: 'vm-spaces' });
  const segs = [
    seg([['none', 'Same addresses'], ['base', 'Base register'], ['paging', 'Pages']] as [Scheme, string][], () => scheme, (v) => { scheme = v; update(); }, 'How programs share memory'),
    seg([[0, 'A and B'], [1, 'Add C (3 pages)']] as [number, string][], () => (withC ? 1 : 0), (v) => { withC = v === 1; update(); }, 'Programs'),
  ];
  const update = () => {
    segs.forEach((x) => x.sync());
    const p = placement(scheme, withC);
    const strip = h('div', { class: 'vm-frames' }, ...p.frames.map((f, i) => h('div', { class: `vm-frame ${f ? `p${f}` : 'free'}` }, h('b', null, f ?? ''), h('span', null, `frame ${i}`), h('span', { class: 'a' }, hex(i * 4096, 4)))));
    const writes = scheme === 'none'
      ? h('p', { class: 'sub' }, 'Both programs run ', h('code', null, 'sw 0(zero)'), ' with their own data: A stores 7, then B stores 9 at address 0. Reading address 0, A now finds ', h('b', { class: 'bad' }, '9'), '.')
      : h('p', { class: 'sub' }, 'Both run ', h('code', null, 'sw 0(zero)'), ': A\'s address 0 is frame 0 (', h('code', null, hex(0, 4)), '), B\'s is frame 4 (', h('code', null, hex(4 * 4096, 4)), '). A reads back its own ', h('b', { class: 'good' }, '7'), '.');
    out.replaceChildren(strip, writes, h('p', { class: p.fits ? 'sub' : 'sub bad' }, p.fits ? '' : 'Does not fit. ', p.note),
      h('div', { class: 'legend rb-legend' }, ...[['pA', 'program A'], ['pB', 'program B'], ['pC', 'program C'], ['free', 'free']].map(([c, l]) => h('span', null, h('i', { class: `vm-frame ${c}` }), l))));
  };
  const el = h('div', { class: 'widget vm-widget' }, h('div', { class: 'rb-ctl' }, ...segs.map((x) => x.el)), out);
  update();
  return { el };
}

// ---- step 2: an address is a page number and an offset --------------------------------------------------------------------

export function vaWidget(): Widget {
  let va = 0x00403a2c;
  const bits = h('div', { class: 'vm-bits', role: 'group', 'aria-label': '32 address bits: click a bit to flip it' });
  const input = h('input', { type: 'text', class: 'vm-in', value: hexg(va), 'aria-label': 'virtual address in hexadecimal', spellcheck: 'false' }) as HTMLInputElement;
  const info = h('div', { class: 'vm-info' });
  const presets: [string, number][] = [['0x0040_3A2C', 0x00403a2c], ['0x0000_1004', 0x1004], ['0x8000_0000', 0x80000000], ['0xFFFF_FFFC', 0xfffffffc]];
  const setVa = (v: number) => { va = v >>> 0; input.value = hexg(va); update(); };
  input.addEventListener('change', () => {
    const t = input.value.replace(/[_\s]/g, '').replace(/^0x/i, '');
    const v = /^[0-9a-f]{1,8}$/i.test(t) ? parseInt(t, 16) : NaN;
    if (Number.isNaN(v)) input.value = hexg(va); else setVa(v);
  });
  let hot = '';
  const update = () => {
    const vpn1 = va >>> 22, vpn0 = (va >>> 12) & 0x3ff, off = va & 0xfff;
    bits.replaceChildren(...Array.from({ length: 32 }, (_, i) => {
      const b = 31 - i, f = b >= 22 ? 'v1' : b >= 12 ? 'v0' : 'of';
      const el = h('button', { type: 'button', class: `vm-bit ${f}${hot === f ? ' hot' : ''}`, 'aria-label': `bit ${b}: ${(va >>> b) & 1}`, onclick: () => setVa((va ^ (1 << b)) >>> 0) }, String((va >>> b) & 1));
      el.addEventListener('mouseenter', () => { hot = f; mark(); });
      el.addEventListener('mouseleave', () => { hot = ''; mark(); });
      return el;
    }));
    const row = (cls: string, name: string, v: string, what: string) => h('div', { class: `vm-fld ${cls}${hot === cls ? ' hot' : ''}`, 'data-f': cls }, h('b', null, name), h('code', null, v), h('span', null, what));
    info.replaceChildren(
      row('v1', 'VPN[1]  bits 31:22', `${vpn1}`, `entry ${vpn1} of the root table, at root + ${vpn1} × 4 = root + ${hex(vpn1 * 4)}`),
      row('v0', 'VPN[0]  bits 21:12', `${vpn0}`, `entry ${vpn0} of the second table, at its start + ${hex(vpn0 * 4)}`),
      row('of', 'offset  bits 11:0', hex(off), 'the byte inside the page: copied to the physical address unchanged'),
      h('p', { class: 'sub' }, `A table has 2`, h('sup', null, '10'), ` = ${1 << 10} entries of 4 bytes = ${(1 << 10) * 4} bytes: exactly one page. The page number is ${groupDigits(2 ** 20)} values wide, so one flat table would need ${groupDigits(2 ** 20)} × 4 bytes = ${2 ** 20 * 4 / 2 ** 20} MiB for every program; two levels keep only the tables that are in use.`));
  };
  const mark = () => {
    bits.querySelectorAll('.vm-bit').forEach((b) => b.classList.toggle('hot', hot !== '' && b.classList.contains(hot)));
    info.querySelectorAll('.vm-fld').forEach((b) => b.classList.toggle('hot', hot === (b as HTMLElement).dataset.f));
  };
  const el = h('div', { class: 'widget vm-widget' },
    h('div', { class: 'rb-ctl' }, h('label', null, 'Virtual address ', input), ...presets.map(([l, v]) => h('button', { type: 'button', class: 'btn sm', onclick: () => setVa(v) }, l))),
    bits, info);
  update();
  return { el };
}

// ---- step 3: the page-table entry -----------------------------------------------------------------------------------------

const BIT_WHAT: Record<string, string> = {
  V: 'valid: 0 means the entry is empty and any access faults',
  R: 'readable', W: 'writable (needs R as well)', X: 'executable',
  U: 'user: 1 = a user page (user mode may use it, supervisor mode may not fetch from it); 0 = supervisor only',
  G: 'global: kept by every address space (this chapter\'s hardware ignores it)',
  A: 'accessed: this hardware never sets it, so software sets it, or the first access faults',
  D: 'dirty: software sets it; a store to a page with D = 0 faults',
};

export function pteWidget(): Widget {
  let flags = VM_V | VM_R | VM_W | VM_U | VM_A | VM_D, ppn = 0x2;
  const bitsRow = h('div', { class: 'vm-pte' });
  const table = h('div', { class: 'scroll' });
  const note = h('p', { class: 'sub' });
  const input = h('input', { type: 'text', class: 'vm-in', value: hex(ppn), 'aria-label': 'physical page number in hexadecimal', spellcheck: 'false' }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const v = parseInt(input.value.replace(/^0x/i, ''), 16);
    if (Number.isFinite(v) && v >= 0 && v < 2 ** 22) ppn = v;
    input.value = hex(ppn);
    update();
  });
  const preset = (l: string, f: number) => h('button', { type: 'button', class: 'btn sm', onclick: () => { flags = f; update(); } }, l);
  const update = () => {
    const pte = vmPte(ppn * 4096, flags);
    bitsRow.replaceChildren(
      h('div', { class: 'vm-pte-ppn' }, h('b', null, 'PPN'), h('span', null, 'bits 31:10'), h('code', null, hex(ppn)), h('span', null, `→ frame at ${hex(ppn * 4096)}`)),
      h('div', { class: 'vm-pte-rsw' }, h('b', null, 'RSW'), h('span', null, 'bits 9:8'), h('code', null, '00'), h('span', null, 'for software')),
      ...[...PTE_BITS].map((n, i) => ({ n, i })).reverse().map(({ n, i }) => h('button', { type: 'button', class: `vm-pbit${(flags >> i) & 1 ? ' on' : ''}`, title: `${n}: ${BIT_WHAT[n]}`, 'aria-pressed': String(!!((flags >> i) & 1)), onclick: () => { flags ^= 1 << i; update(); } }, h('b', null, n), h('code', null, String((flags >> i) & 1)), h('span', null, `bit ${i}`))));
    const rows: Access[] = ACCESSES;
    const cell = (priv: 0 | 1, a: Access) => { const o = leafOutcome(flags, priv, a); return h('td', { class: o.ok ? 'ok' : 'no', title: o.why }, o.ok ? 'allowed' : `fault ${faultCause(a)}`); };
    table.replaceChildren(h('table', { class: 'data vm-perm' },
      h('tr', null, h('th', null, ''), h('th', null, 'user mode'), h('th', null, 'supervisor mode')),
      ...rows.map((a) => h('tr', null, h('th', null, a === 'fetch' ? 'fetch an instruction' : a === 'load' ? 'load' : 'store'), cell(0, a), cell(1, a)))));
    const why = leafOutcome(flags, 0, 'store');
    note.replaceChildren(`The entry as a word: ${hexg(pte)}. A fault is cause 12 (fetch), 13 (load) or 15 (store); hover a cell for the rule. Store from user mode: ${why.ok ? 'allowed' : why.why}.`);
  };
  const el = h('div', { class: 'widget vm-widget' },
    h('div', { class: 'rb-ctl' }, h('label', null, 'Physical page number ', input),
      preset('Data, read / write', VM_V | VM_R | VM_W | VM_U | VM_A | VM_D), preset('Code', VM_V | VM_R | VM_X | VM_U | VM_A), preset('Read-only', VM_V | VM_R | VM_U | VM_A | VM_D), preset('Kernel data', VM_V | VM_R | VM_W | VM_A | VM_D), preset('Not yet touched', VM_V | VM_R | VM_W | VM_U)),
    bitsRow, table, note);
  update();
  return { el };
}

// ---- step 4: the walk ------------------------------------------------------------------------------------------------------

/** A page table in a golden model's memory: root at PPN 0x10, second table at 0x11, a few leaves, a superpage and a supervisor page. */
export function walkWorld(): ISS {
  const iss = new ISS([], { system: true, vm: true, dmemWords: 2 ** 16 });
  const put = (pa: number, v: number) => { iss.dmem[pa >>> 2] = v >>> 0; };
  const ROOT = 0x10 * 4096, SECOND = 0x11 * 4096, OTHER = 0x12 * 4096;
  put(ROOT + 4 * 1, vmPte(SECOND, VM_V)); // VPN1 = 1 -> the second table
  put(ROOT + 4 * 3, vmPte(OTHER, VM_V)); // VPN1 = 3 -> another second table
  put(ROOT + 4 * 2, vmPte(0x400000, VM_V | VM_R | VM_W | VM_U | VM_A | VM_D)); // VPN1 = 2: a 4 MiB superpage (physical 4 MiB, wraps in this memory)
  put(SECOND + 4 * 0, vmPte(0x28 * 4096, VM_V | VM_R | VM_W | VM_U | VM_A | VM_D));
  put(SECOND + 4 * 1, vmPte(0x29 * 4096, VM_V | VM_R | VM_W | VM_U | VM_A | VM_D));
  put(SECOND + 4 * 3, vmPte(0x2a * 4096, VM_V | VM_R | VM_W | VM_U | VM_A | VM_D));
  put(OTHER + 4 * 0, vmPte(0x30 * 4096, VM_V | VM_R | VM_W | VM_A | VM_D)); // a supervisor page
  iss.satp = (1 << 31) | 0x10;
  return iss;
}

export const WALK_CASES: { va: number; label: string; access: Access }[] = [
  { va: 0x00403a2c, label: 'a user page', access: 'load' },
  { va: 0x00402000 + 0x14, label: 'a hole in the second table (V = 0)', access: 'load' },
  { va: 0x00800123, label: 'a 4 MiB superpage', access: 'load' },
  { va: 0x00c00040, label: 'a supervisor page, from user mode', access: 'load' },
  { va: 0x0100_0000, label: 'no second table (V = 0 in the root)', access: 'store' },
];

export function walkWidget(): Widget {
  let iss = walkWorld(), ci = 0, step = 0;
  const bitsEl = h('div', { class: 'vm-bits' });
  const svgHost = h('div', { class: 'vm-walk' });
  const text = h('p', { class: 'sub', role: 'status', 'aria-live': 'polite' });
  const info = () => iss.walk(WALK_CASES[ci].va, WALK_CASES[ci].access, 0);
  const lastStep = (w: Walk) => w.ptes.length + 1; // reads, then the result
  const seg3 = seg(WALK_CASES.map((c, i) => [i, c.label] as [number, string]), () => ci, (v) => { ci = v; step = 0; update(); }, 'Address to translate');
  const back = h('button', { type: 'button', class: 'btn sm', onclick: () => { step = Math.max(0, step - 1); update(); } }, '◀ Back');
  const next = h('button', { type: 'button', class: 'btn sm primary', onclick: () => { step = Math.min(lastStep(info()), step + 1); update(); } }, 'Next read ▶');
  const update = () => {
    seg3.sync();
    const c = WALK_CASES[ci], w = info(), va = c.va;
    const vpn1 = va >>> 22, vpn0 = (va >>> 12) & 0x3ff, off = va & 0xfff;
    bitsEl.replaceChildren(...Array.from({ length: 32 }, (_, i) => { const b = 31 - i; return h('span', { class: `vm-bit ${b >= 22 ? 'v1' : b >= 12 ? 'v0' : 'of'}` }, String((va >>> b) & 1)); }),
      h('span', { class: 'vm-bl a' }, `VPN[1] = ${vpn1}`), h('span', { class: 'vm-bl b' }, `VPN[0] = ${vpn0}`), h('span', { class: 'vm-bl c' }, `offset = ${hex(off)}`));
    const reads = Math.min(step, w.ptes.length);
    const done = step > w.ptes.length;
    // the table cells around the touched entry, from the model's own memory
    const W = 560, ROWH = 22;
    const tableBox = (x: number, y: number, title: string, base: number, idx: number, shown: boolean, hit: boolean) => {
      const g = s('g', { class: shown ? '' : 'dim' });
      g.append(s('text', { x, y: y - 6, class: 'vm-t' }, `${title} @ ${hex(base)}`));
      const first = Math.max(0, idx - 1);
      for (let k = 0; k < 3; k++) {
        const i = first + k, pte = iss.dmem[(base + 4 * i) >>> 2] >>> 0;
        const sel = i === idx && hit;
        const desc = (pte & 1) === 0 ? 'V = 0' : `→ ${hex(pte >>> 10)}  ${PTE_BITS.filter((_, b) => b > 0 && b !== 5 && (pte >> b) & 1).join(' ')}`;
        g.append(s('rect', { x, y: y + k * ROWH, width: 190, height: ROWH, class: `vm-cell${sel ? ' sel' : ''}` }), s('text', { x: x + 8, y: y + k * ROWH + 15, class: 'vm-c' }, `[${i}]  ${desc}`));
      }
      g.append(s('text', { x, y: y + 3 * ROWH + 14, class: 'vm-t' }, '… 1024 entries'));
      return g;
    };
    const svg = s('svg', { viewBox: `0 0 ${W} 190`, class: 'vm-svg', role: 'group', 'aria-label': 'The walk: satp points at the root table, the root entry at a second table, its entry holds the physical page' });
    const root = (iss.satp & 0x3fffff) * 4096;
    svg.append(
      s('rect', { x: 4, y: 20, width: 96, height: 40, rx: 6, class: 'vm-cell' }), s('text', { x: 12, y: 36, class: 'vm-c' }, 'satp'), s('text', { x: 12, y: 52, class: 'vm-t' }, `PPN ${hex(iss.satp & 0x3fffff)}`));
    const e1 = w.ptes[0], e0 = w.ptes[1];
    svg.append(tableBox(130, 28, 'root table', root, vpn1, reads >= 1, reads >= 1));
    if (e1 && (e1.pte & 1) && !(((e1.pte >> 1) & 1) || ((e1.pte >> 3) & 1))) svg.append(tableBox(350, 28, 'second table', (e1.pte >>> 10) * 4096, vpn0, reads >= 2, reads >= 2));
    if (reads >= 1) svg.append(s('path', { d: 'M100 40 C 115 40 115 ' + (28 + ROWH * (vpn1 > 0 ? 1.5 : 0.5)) + ' 128 ' + (28 + ROWH * (vpn1 > 0 ? 1.5 : 0.5)), class: 'vm-arrow' }));
    if (reads >= 2 && e0) svg.append(s('path', { d: `M320 ${28 + ROWH * (vpn1 > 0 ? 1.5 : 0.5)} C 335 ${28 + ROWH * 1.5} 335 ${28 + ROWH * (vpn0 > 0 ? 1.5 : 0.5)} 348 ${28 + ROWH * (vpn0 > 0 ? 1.5 : 0.5)}`, class: 'vm-arrow' }));
    if (done && w.pa !== undefined) {
      const ppn = Math.floor(w.pa / 4096);
      svg.append(s('rect', { x: 130, y: 128, width: 240, height: 28, rx: 6, class: 'vm-pp' }), s('text', { x: 140, y: 146, class: 'vm-w' }, `PPN ${hex(ppn)}`),
        s('rect', { x: 370, y: 128, width: 150, height: 28, rx: 6, class: 'vm-of' }), s('text', { x: 380, y: 146, class: 'vm-w' }, `offset ${hex(off)}`));
    }
    svgHost.replaceChildren(svg);
    const last = w.ptes[reads - 1];
    text.replaceChildren(
      step === 0 ? `The program ${c.access === 'store' ? 'stores to' : 'loads from'} ${hexg(va)} (${c.label}), in user mode. Nothing has been read yet.`
        : !done ? `Read ${reads} of ${w.ptes.length}: the word at ${hexg(last.addr)} (${last.level === 1 ? 'root' : 'second'} table entry ${last.level === 1 ? vpn1 : vpn0}) is ${hexg(last.pte)}.`
          : w.fault !== undefined ? `Page fault: cause ${w.fault}, and mtval = ${hexg(va)}. No physical address; the trap handler decides what to do (step 7).`
            : `Physical address ${hexg(w.pa!)}${w.superpage ? ': a 4 MiB superpage, so the walk ends after one read and VPN[0] joins the offset' : ''}. ${w.ptes.length} read${w.ptes.length === 1 ? '' : 's'} before the access itself: ${w.superpage ? SUPER_CYCLES : WALK_CYCLES} cycles of walk on the gates.`);
    back.disabled = step === 0;
    next.disabled = step > w.ptes.length;
  };
  const el = h('div', { class: 'widget vm-widget' },
    h('div', { class: 'rb-ctl' }, seg3.el), bitsEl, svgHost, text, h('div', { class: 'rb-ctl' }, back, next, h('button', { type: 'button', class: 'btn sm', onclick: () => { iss = walkWorld(); step = 0; update(); } }, 'Start over')));
  update();
  return { el };
}

// ---- step 9: what it costs --------------------------------------------------------------------------------------------------

/** Both TLBs of 2^k entries: NANDs of the pair, from lib/vm.ts's generators. */
export const tlbNands = (k: number): number => stats(tlb('i', k)).nands + stats(tlb('d', k)).nands;
/** The whole virtual-memory CPU without its program ROM (data memory 2^5 words, the system CPU's default). */
let coreMemo = 0;
export const vmCoreNands = (): number => coreMemo || (coreMemo = stats(withoutParts(systemCpu([], { vm: true }), ['imem'])).nands);

export interface BenchPages { id: string; name: string; instructions: number; accesses: number; codePages: number; dataPages: number; misses: number }
const benchMemo = new Map<string, BenchPages>();
/** A benchmark run on the golden model, its fetch and data pages (identity mapped) through two 4-entry TLBs. */
export function benchPages(id: string): BenchPages {
  let r = benchMemo.get(id);
  if (r) return r;
  const b = BENCHMARKS.find((x) => x.id === id)!;
  const iss = new ISS(assemble(benchSource(b)).words, { dmemWords: 64, imemWords: 128 });
  iss.memTrace = [];
  const it = new TlbModel(4), dt = new TlbModel(4), code = new Set<number>(), data = new Set<number>();
  let n = 0;
  for (; n < 200000 && !iss.halted; n++) { const pc = iss.pc; iss.step(); it.access(pc >>> 12); code.add(pc >>> 12); }
  for (const a of iss.memTrace) { dt.access(a.addr >>> 12); data.add(a.addr >>> 12); }
  r = { id, name: b.name, instructions: n, accesses: iss.memTrace.length, codePages: code.size, dataPages: data.size, misses: it.misses + dt.misses };
  benchMemo.set(id, r);
  return r;
}
/** Loads and stores per instruction over the benchmark programs that run on RV32I. */
export const accessesPerInstruction = (): number => {
  const rs = BENCHMARKS.filter((b) => !b.needs).map((b) => benchPages(b.id));
  return rs.reduce((a, r) => a + r.accesses, 0) / rs.reduce((a, r) => a + r.instructions, 0);
};

const PATTERNS: [Pattern, string, string][] = [
  ['sequential', 'Sequential', 'a loop over an array of words, 1 024 words to a page'],
  ['stride', 'One page at a time', 'every access in the next page, round and round: a column of a wide matrix'],
  ['random', 'Random', 'any page of the working set, as often as any other'],
];
const SIZES = [1, 2, 3, 4, 5];

export function costWidget(): Widget {
  let pattern: Pattern = 'stride', pages = 8;
  const out = h('div', { class: 'vm-cost' });
  const segs = [
    seg(PATTERNS.map(([v, l]) => [v, l] as [Pattern, string]), () => pattern, (v) => { pattern = v; update(); }, 'Access pattern'),
    seg([4, 8, 16, 32, 64].map((p) => [p, `${p} pages`] as [number, string]), () => pages, (v) => { pages = v; update(); }, 'Working set'),
  ];
  const update = () => {
    segs.forEach((x) => x.sync());
    const per = accessesPerInstruction(), core = vmCoreNands();
    const N = 20000;
    const rows = SIZES.map((k) => {
      const e = 2 ** k, m = missesOf(pagesOf(pattern, pages, N), e);
      const cpi = 1 + per * m.rate * WALK_CYCLES;
      return { e, m, cpi, nands: tlbNands(k), ours: k === 2 };
    });
    const rel = (n: number) => `${n >= 0 ? '+' : '−'}${groupDigits(Math.abs(n))}`;
    const base = tlbNands(2);
    out.replaceChildren(
      h('p', { class: 'sub' }, `${PATTERNS.find((p) => p[0] === pattern)![2].replace(/^./, (c) => c.toUpperCase())}; ${pages} pages = ${pages * 4} KiB of data. ${groupDigits(N)} data accesses through the entries' round-robin replacement; each miss costs one walk of ${WALK_CYCLES} cycles on the gates. The benchmark programs make ${per.toFixed(2)} loads and stores per instruction.`),
      h('div', { class: 'scroll' }, h('table', { class: 'data vm-costtab' },
        h('tr', null, ['entries in each TLB', 'miss rate', 'cycles per instruction', 'NANDs, both TLBs', 'against 4 entries'].map((x) => h('th', null, x))),
        ...rows.map((r) => h('tr', { class: r.ours ? 'ours' : '' }, h('td', null, `${r.e}${r.ours ? ' (ours)' : ''}`), h('td', null, `${(100 * r.m.rate).toFixed(r.m.rate < 0.01 ? 2 : 1)} %`), h('td', null, r.cpi.toFixed(3)), h('td', null, groupDigits(r.nands)), h('td', null, r.ours ? '' : rel(r.nands - base))))
      )),
      h('p', { class: 'sub' }, `The whole virtual-memory CPU without its program ROM is ${groupDigits(core)} NANDs, so the pair of 4-entry TLBs (${groupDigits(base)}) is ${Math.round((100 * base) / core)} % of it; 32 entries would be ${Math.round((100 * tlbNands(5)) / core)} %. Cycles per instruction assume the instruction fetches stay in one page and add the data accesses only.`));
  };
  const el = h('div', { class: 'widget vm-widget' }, h('div', { class: 'cpu-sec' }, 'The benchmark programs'), benchTable().el, h('div', { class: 'cpu-sec' }, 'A working set that does not fit'), h('div', { class: 'rb-ctl' }, ...segs.map((x) => x.el)), out);
  update();
  return { el };
}

/** The benchmark programs' pages, as a table (step 9, above the widget). */
function benchTable(): Widget {
  const rs = BENCHMARKS.filter((b) => !b.needs).map((b) => benchPages(b.id));
  const el = h('div', { class: 'widget vm-widget' }, h('div', { class: 'scroll' }, h('table', { class: 'data vm-costtab' },
    h('tr', null, ['program', 'instructions', 'loads and stores', 'code pages', 'data pages', 'misses, 4 entries', 'extra cycles'].map((x) => h('th', null, x))),
    ...rs.map((r) => h('tr', null, h('td', null, r.name), h('td', null, groupDigits(r.instructions)), h('td', null, groupDigits(r.accesses)), h('td', null, String(r.codePages)), h('td', null, String(r.dataPages)), h('td', null, String(r.misses)), h('td', null, String(r.misses * WALK_CYCLES)))))));
  return { el };
}
