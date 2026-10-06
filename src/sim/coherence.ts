// Snooping cache coherence (write-invalidate) for the multi-core chapter: MSI and MESI on a shared
// bus. Caches are modelled per block, without capacity limits, so that only the protocol shows.

export type LineState = 'M' | 'E' | 'S' | 'I';
export type Protocol = 'MSI' | 'MESI';
export type BusOp = 'BusRd' | 'BusRdX' | 'BusUpgr';

export interface CoherenceEvent {
  core: number;
  block: number;
  write: boolean;
  hit: boolean;
  bus: BusOp | null;
  /** A cache holding the block Modified supplied it and wrote it back. */
  flush: number | null;
  invalidated: number[];
  from: LineState;
  to: LineState;
}

export interface CoherenceStats { accesses: number; hits: number; bus: number; invalidations: number; writebacks: number; memReads: number }

export class Coherence {
  readonly state: LineState[][];
  stats: CoherenceStats = { accesses: 0, hits: 0, bus: 0, invalidations: 0, writebacks: 0, memReads: 0 };

  constructor(readonly cores: number, readonly protocol: Protocol, readonly blocks = 4) {
    this.state = Array.from({ length: cores }, () => Array.from({ length: blocks }, (): LineState => 'I'));
  }

  access(core: number, block: number, write: boolean): CoherenceEvent {
    const st = this.stats;
    st.accesses++;
    const from = this.state[core][block];
    const others = [...Array(this.cores).keys()].filter((c) => c !== core);
    const ev: CoherenceEvent = { core, block, write, hit: false, bus: null, flush: null, invalidated: [], from, to: from };
    const snoopFlush = () => {
      const owner = others.find((c) => this.state[c][block] === 'M');
      if (owner !== undefined) { ev.flush = owner; st.writebacks++; }
      return owner;
    };
    if (!write) {
      if (from !== 'I') { ev.hit = true; st.hits++; return ev; }
      ev.bus = 'BusRd';
      st.bus++;
      const owner = snoopFlush();
      if (owner === undefined) st.memReads++;
      const shared = others.some((c) => this.state[c][block] !== 'I');
      for (const c of others) if (this.state[c][block] !== 'I') this.state[c][block] = 'S';
      ev.to = this.protocol === 'MESI' && !shared ? 'E' : 'S';
    } else {
      if (from === 'M') { ev.hit = true; st.hits++; return ev; }
      if (from === 'E') { ev.hit = true; st.hits++; ev.to = 'M'; this.state[core][block] = 'M'; return ev; } // silent upgrade
      ev.bus = from === 'S' ? 'BusUpgr' : 'BusRdX';
      st.bus++;
      if (from === 'I') { if (snoopFlush() === undefined) st.memReads++; }
      for (const c of others) if (this.state[c][block] !== 'I') { this.state[c][block] = 'I'; ev.invalidated.push(c); st.invalidations++; }
      ev.to = 'M';
    }
    this.state[core][block] = ev.to;
    return ev;
  }
}
