// Behavioural cache model for the memory-hierarchy explorer: configurable size, line size,
// associativity, replacement and write policy, with every miss classified by the "three Cs"
// (compulsory, capacity, conflict; Hill 1987).

export type Replacement = 'lru' | 'fifo' | 'random';
export type WritePolicy = 'wb' | 'wt';

export interface CacheConfig {
  /** Total data capacity in bytes. */
  size: number;
  /** Line (block) size in bytes. */
  line: number;
  /** Ways per set; size / line for fully associative. */
  ways: number;
  replacement: Replacement;
  /** 'wb': write-back + write-allocate. 'wt': write-through + no write-allocate. */
  write: WritePolicy;
}

export type MissKind = 'compulsory' | 'capacity' | 'conflict';

export interface AccessResult {
  hit: boolean;
  set: number;
  way: number;
  tag: number;
  kind?: MissKind;
  /** A dirty line was written back to make room. */
  writeback?: boolean;
}

interface Line { valid: boolean; tag: number; dirty: boolean; stamp: number; loaded: number }

export interface CacheStats {
  accesses: number; hits: number; misses: number;
  compulsory: number; capacity: number; conflict: number;
  /** Words moved between cache and memory (fills, write-backs, write-through stores). */
  wordsRead: number; wordsWritten: number;
}

export class CacheModel {
  readonly cfg: CacheConfig;
  readonly sets: number;
  readonly lines: Line[][];
  stats: CacheStats;
  private clock = 0;
  private seen = new Set<number>();
  /** Fully associative LRU shadow of the same capacity, to tell capacity from conflict misses. */
  private shadow: number[] = [];
  private seed = 1;

  constructor(cfg: CacheConfig) {
    this.cfg = cfg;
    const nLines = cfg.size / cfg.line;
    this.sets = Math.max(1, nLines / cfg.ways);
    this.lines = Array.from({ length: this.sets }, () => Array.from({ length: cfg.ways }, () => ({ valid: false, tag: 0, dirty: false, stamp: 0, loaded: 0 })));
    this.stats = { accesses: 0, hits: 0, misses: 0, compulsory: 0, capacity: 0, conflict: 0, wordsRead: 0, wordsWritten: 0 };
  }

  /** Split a byte address into (tag, set index, byte offset). */
  split(addr: number): { tag: number; set: number; offset: number } {
    const block = Math.floor(addr / this.cfg.line);
    return { tag: Math.floor(block / this.sets), set: block % this.sets, offset: addr % this.cfg.line };
  }

  access(addr: number, write = false): AccessResult {
    const { cfg, stats } = this;
    const block = Math.floor(addr / cfg.line);
    const { tag, set } = this.split(addr);
    const lineWords = cfg.line / 4;
    stats.accesses++;
    this.clock++;
    // shadow fully-associative LRU
    const si = this.shadow.indexOf(block);
    const shadowHit = si >= 0;
    if (shadowHit) this.shadow.splice(si, 1);
    this.shadow.push(block);
    if (this.shadow.length > cfg.size / cfg.line) this.shadow.shift();

    const ways = this.lines[set];
    const w = ways.findIndex((l) => l.valid && l.tag === tag);
    if (w >= 0) {
      stats.hits++;
      const l = ways[w];
      l.stamp = this.clock;
      if (write) {
        if (cfg.write === 'wb') l.dirty = true;
        else stats.wordsWritten++;
      }
      return { hit: true, set, way: w, tag };
    }
    stats.misses++;
    const kind: MissKind = !this.seen.has(block) ? 'compulsory' : shadowHit ? 'conflict' : 'capacity';
    stats[kind]++;
    this.seen.add(block);
    if (write && cfg.write === 'wt') {
      // no write-allocate: the store goes to memory only
      stats.wordsWritten++;
      return { hit: false, set, way: -1, tag, kind };
    }
    // choose a victim: an invalid way first, else by policy
    let v = ways.findIndex((l) => !l.valid);
    if (v < 0) {
      if (cfg.replacement === 'random') {
        this.seed = (this.seed * 1103515245 + 12345) >>> 0;
        v = this.seed % cfg.ways;
      } else {
        const key = (l: Line) => (cfg.replacement === 'lru' ? l.stamp : l.loaded);
        v = 0;
        for (let i = 1; i < ways.length; i++) if (key(ways[i]) < key(ways[v])) v = i;
      }
    }
    const victim = ways[v];
    const writeback = victim.valid && victim.dirty;
    if (writeback) stats.wordsWritten += lineWords;
    stats.wordsRead += lineWords;
    ways[v] = { valid: true, tag, dirty: write && cfg.write === 'wb', stamp: this.clock, loaded: this.clock };
    return { hit: false, set, way: v, tag, kind, writeback };
  }
}
