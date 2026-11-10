// The virtual-memory CPU's panel (chapter 'vmem'): console, privilege level, satp, the trap registers, the walker's state,
// the translation counters and the two TLBs' entries, read from the gates of systemCpu(…, { vm: true }). Beside the CPU panel
// (widgets/cpupanel.ts, cpuScene({ vm: true })), which keeps the golden model in lock step and counts the model's translated
// accesses into the shared VmLink.

import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { pack } from '../sim/values';
import { h } from '../ui/dom';
import type { ScenePanel, Stage, Widget } from '../view/stage';
import '../styles/vmem.css';

/** What the CPU panel (golden model) and this panel (gates) hand each other. */
export interface VmLink {
  /** Translated accesses the golden model made (every fetch and every load / store while Sv32 is on). */
  accesses: number;
}
export const newVmLink = (): VmLink => ({ accesses: 0 });

const hex = (v: number, d = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');
const MODE: Record<number, string> = { 0: 'U (user)', 1: 'S (supervisor)', 3: 'M (machine)' };
const CAUSES: Record<number, string> = {
  1: 'instruction access fault', 2: 'illegal instruction', 4: 'misaligned load', 5: 'load access fault', 6: 'misaligned store',
  7: 'store access fault', 8: 'ecall from U', 9: 'ecall from S', 11: 'ecall from M', 12: 'instruction page fault', 13: 'load page fault', 15: 'store page fault',
};
/** The walker's states, as the state bits (s1 s0) read. */
const WALKER = ['idle', 'reading the root table (level 1)', 'reading the leaf table (level 0)', 'fault'];

/** Value of a named net inside an instance (-1: not found). */
export function netValue(sim: Sim, node: HierNode | undefined, name: string): number {
  if (!node?.nets) return -1;
  const i = node.def.netlist!().nets.findIndex((x) => x.name === name);
  return i < 0 ? -1 : sim.get(node.nets[i][0]);
}

/** Bits lo .. lo + n of a bit array (least significant first) as a number; X reads as 0. */
const field = (bits: ArrayLike<number>, lo: number, n: number): number => {
  let v = 0;
  for (let i = 0; i < n; i++) v += (bits[lo + i] === 1 ? 1 : 0) * 2 ** i;
  return v;
};

export interface TlbRow { valid: boolean; vpn: number; ppn: number; flags: string }
/** The entries of the instruction TLB (flags x u) or the data TLB (r w x u d), read from their registers. */
export function readTlb(sim: Sim, tlb: HierNode, kind: 'i' | 'd'): TlbRow[] {
  const names = kind === 'i' ? ['x', 'u'] : ['r', 'w', 'x', 'u', 'd'];
  const rows: TlbRow[] = [];
  for (let i = 0; i < 4; i++) {
    const e = tlb.children?.get(`e${i}`), v = tlb.children?.get(`v${i}`);
    if (!e || !v) break;
    const bits = sim.getBits(e.ports.q);
    rows.push({
      valid: pack(sim.getBits(v.ports.q)) === 1,
      vpn: field(bits, 0, 20), ppn: field(bits, 20, 22),
      flags: names.map((n, k) => (bits[42 + k] === 1 ? n : '·')).join(''),
    });
  }
  return rows;
}

export function vmPanel(link: VmLink): ScenePanel {
  return (stage: Stage): Widget => {
    let text = '';
    const walks = { i: 0, d: 0 };
    const con = h('pre', { class: 'console' });
    const facts = h('div', { class: 'cpu-mem' });
    const tlbs = h('div', { class: 'vm-tlbs' });
    const walker = h('div', { class: 'vm-walker', role: 'status' });
    stage.edgeHooks.add({
      before: () => {
        const sim = stage.sim, root = stage.rootCtx?.node;
        if (!sim || !root?.children) return;
        if (sim.getBits(root.ports.consoleValid)[0] === 1) text += String.fromCharCode(pack(sim.getBits(root.ports.consoleData)) & 0xff);
        // a walk starts in the cycle the walker is idle and the stall is already up (the `go` cycle)
        const mmu = root.children.get('mmu');
        if (mmu) {
          const st = sim.getBits(mmu.ports.stall)[0] === 1, idle = sim.getBits(mmu.ports.idle)[0] === 1;
          if (st && idle) { if (netValue(sim, mmu, 'iMiss') === 1) walks.i++; else walks.d++; }
        }
      },
    });
    stage.historyHooks.add({
      save: () => ({ text, walks: { ...walks }, accesses: link.accesses }),
      restore: (v) => { const s = v as { text: string; walks: { i: number; d: number }; accesses: number }; text = s.text; walks.i = s.walks.i; walks.d = s.walks.d; link.accesses = s.accesses; },
    });
    const title = h('h4', null, 'Privilege, translation & TLBs', h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel io-panel vm-panel', 'data-dock': 'left', 'data-fold': 'narrow', 'data-phone': 'flow' }, title,
      h('div', { class: 'io-cols' },
        h('div', null, h('div', { class: 'cpu-sec' }, 'Console', h('span', { class: 'cpu-sec-hint' }, 'memory-mapped at 0x8000_0000')), con, walker, h('div', { class: 'cpu-sec' }, 'Translation'), facts),
        h('div', null, tlbs)));
    const update = () => {
      const sim = stage.sim, root = stage.rootCtx?.node;
      if (!sim || !root?.children) return;
      if (stage.cycles === 0) { text = ''; walks.i = walks.d = 0; link.accesses = 0; }
      con.textContent = text || ' ';
      con.scrollTop = con.scrollHeight;
      const csr = root.children.get('csr')!, mmu = root.children.get('mmu')!;
      const q = (name: string) => pack(sim.getBits(csr.children!.get(name)!.ports.q)) >>> 0;
      const priv = (~q('privN')) & 3, satp = q('satp'), cause = q('mcause');
      const mode = (satp >>> 31) === 1, root22 = satp & 0x3fffff;
      const state = pack(sim.getBits(mmu.children!.get('wk')!.children!.get('s1')!.ports.q)) * 2 + pack(sim.getBits(mmu.children!.get('wk')!.children!.get('s0')!.ports.q));
      const stalled = sim.getBits(mmu.ports.stall)[0] === 1;
      walker.className = `vm-walker${stalled ? ' on' : ''}`;
      walker.textContent = stalled ? `Walker: ${WALKER[state] === 'idle' ? 'a TLB missed, the walk starts' : WALKER[state]}; the CPU is stalled` : `Walker: ${WALKER[state]}`;
      const n = walks.i + walks.d;
      const rows: [string, string][] = [
        ['mode', MODE[priv] ?? String(priv)],
        ['satp', mode ? `Sv32 on, root table at ${hex(root22 * 4096)}` : `off (${hex(satp)})`],
        ['mcause', `${hex(cause)} ${CAUSES[cause] ?? (cause === 0 && q('mepc') === 0 ? '(no trap yet)' : '')}`],
        ['mtval', hex(q('mtval'))],
        ['mepc', hex(q('mepc') * 4)],
        ['accesses', `${link.accesses} translated`],
        ['walks', `${n} (${walks.i} fetch, ${walks.d} load / store)`],
        ['TLB hit rate', link.accesses ? `${Math.max(0, Math.round((100 * (link.accesses - n)) / link.accesses))} %` : '-'],
      ];
      facts.replaceChildren(...rows.map(([k, v]) => h('div', { class: 'm' }, h('span', { class: 'n' }, k), h('span', { class: 'v' }, v))));
      const pcVpn = pack(sim.getBits(mmu.ports.pc)) >>> 12, vaVpn = pack(sim.getBits(mmu.ports.va)) >>> 12;
      const table = (label: string, node: HierNode | undefined, kind: 'i' | 'd', now: number) => {
        const t = node ? readTlb(sim, node, kind) : [];
        return h('div', { class: 'vm-tlb' }, h('div', { class: 'cpu-sec' }, label),
          h('table', { class: 'data vm-tlbtab' },
            h('tr', null, ...['', 'virtual page', 'physical page', kind === 'i' ? 'x u' : 'r w x u d'].map((x) => h('th', null, x))),
            ...t.map((r, i) => h('tr', { class: r.valid && r.vpn === now ? 'hit' : '' },
              h('td', null, String(i)),
              h('td', null, r.valid ? hex(r.vpn, 5) : 'empty'),
              h('td', null, r.valid ? hex(r.ppn, 6) : ''),
              h('td', null, r.valid ? r.flags : '')))));
      };
      tlbs.replaceChildren(table('Instruction TLB', mmu.children!.get('itlb'), 'i', pcVpn), table('Data TLB', mmu.children!.get('dtlb'), 'd', vaVpn));
    };
    update();
    return { el, update };
  };
}
