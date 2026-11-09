// BGP between the networks of chapter pcie (net/internet.ts), in synchronous rounds. A path-vector protocol: a route is a prefix and the whole
// list of networks it crosses, so a network sees itself in a path and refuses it, which is what ends chapter errors's counting to infinity.
// Choice and export follow money, as in practice (Gao-Rexford): a route from a customer before a peer's before a provider's, then the
// shorter path, then the lower AS number; only your own and your customers' routes go to peers and providers. BGP's other attributes,
// sessions, timers and route reflectors are left out; the rounds are the simplest and kindest timing.

export type Relation = 'provider' | 'peer';
/** provider: a sells transit to b. peer: a and b carry each other's customers for nothing. */
export interface AsRelation { a: number; b: number; kind: Relation }

export interface BgpOptions {
  /** Off: every route goes to every neighbour and the shortest path wins, with no regard for who pays: what the protocol would do without policy. */
  policy?: boolean;
  /** A false announcement: this network claims a prefix that is not its own. */
  hijack?: { as: number; prefix: number; len: number };
}

export interface Announced { key: string; prefix: number; len: number; origin: number }
export interface BgpRoute { path: number[]; via: number; cls: number }

/** How a neighbour sits relative to `me`: 0 customer, 1 peer, 2 provider (the order of preference). */
export const CLS_CUSTOMER = 0, CLS_PEER = 1, CLS_PROVIDER = 2;
export const CLS_NAMES = ['customer', 'peer', 'provider'];
/** The networks' numbers: the tie-break, and their prefixes 10.<i + 1>.0.0/16. */
export const AS_COUNT = 8;

export class BgpNet {
  /** routes[as][prefix key]: what each network has chosen. */
  routes: Map<string, BgpRoute>[] = [];
  rounds = 0;
  messages = 0;
  /** Announcements refused because the path held the network itself. */
  refused = 0;
  private readonly policy: boolean;
  private readonly ann: Announced[];
  private settled = false;

  constructor(private readonly rel: readonly AsRelation[], o: BgpOptions = {}) {
    this.policy = o.policy ?? true;
    this.ann = Array.from({ length: AS_COUNT }, (_, i) => { const prefix = ((10 << 24) | ((i + 1) << 16)) >>> 0; return { key: keyOf(prefix, 16), prefix, len: 16, origin: i }; });
    if (o.hijack) this.ann.push({ key: keyOf(o.hijack.prefix, o.hijack.len), prefix: o.hijack.prefix, len: o.hijack.len, origin: o.hijack.as });
    this.reset();
  }

  /** Only each origin knows its own prefixes. */
  reset(): void {
    this.routes = Array.from({ length: AS_COUNT }, () => new Map<string, BgpRoute>());
    for (const a of this.ann) this.routes[a.origin].set(a.key, { path: [], via: a.origin, cls: -1 });
    this.rounds = 0; this.messages = 0; this.refused = 0; this.settled = false;
  }

  prefixes(): readonly Announced[] { return this.ann; }
  best(as: number, key: string): BgpRoute | undefined { return this.routes[as].get(key); }

  neighbours(as: number): { as: number; cls: number }[] {
    return this.rel.flatMap((r) => {
      if (r.a === as) return [{ as: r.b, cls: r.kind === 'peer' ? CLS_PEER : CLS_CUSTOMER }];
      if (r.b === as) return [{ as: r.a, cls: r.kind === 'peer' ? CLS_PEER : CLS_PROVIDER }];
      return [];
    });
  }

  /** Would `as` tell neighbour class `to` about this route? Your own and your customers' routes go to everyone; the rest only to customers. */
  private exports(route: BgpRoute, to: number): boolean {
    if (!this.policy) return true;
    return route.cls === -1 || route.cls === CLS_CUSTOMER || to === CLS_CUSTOMER;
  }

  /** Is `a` a better route than `b`? */
  private better(a: BgpRoute, b: BgpRoute | undefined): boolean {
    if (!b) return true;
    if (this.policy && a.cls !== b.cls) return a.cls < b.cls;
    if (a.path.length !== b.path.length) return a.path.length < b.path.length;
    return a.via < b.via;
  }

  /** One round: every network hears what each neighbour chose last round, and chooses again. False when nothing changed. */
  round(): boolean {
    const prev = this.routes;
    const next = prev.map(() => new Map<string, BgpRoute>());
    let changed = false;
    for (let me = 0; me < prev.length; me++) {
      for (const a of this.ann) {
        const old = prev[me].get(a.key);
        if (a.origin === me) { next[me].set(a.key, old!); continue; }
        let best: BgpRoute | undefined;
        for (const n of this.neighbours(me)) {
          const theirs = prev[n.as].get(a.key);
          // which class am I, seen from them? the opposite of what they are to me
          if (!theirs || !this.exports(theirs, n.cls === CLS_CUSTOMER ? CLS_PROVIDER : n.cls === CLS_PROVIDER ? CLS_CUSTOMER : CLS_PEER)) continue;
          if (theirs.path.includes(me)) { this.refused++; continue; }
          const r: BgpRoute = { path: [n.as, ...theirs.path], via: n.as, cls: n.cls };
          if (this.better(r, best)) best = r;
        }
        if (best) next[me].set(a.key, best);
        if (!samePath(best, old)) { changed = true; this.messages += this.neighbours(me).length; }
      }
    }
    this.routes = next;
    if (changed) this.rounds++;
    return changed;
  }

  settle(): number {
    if (this.settled) return this.rounds;
    let guard = 64;
    while (guard-- > 0 && this.round());
    this.settled = true;
    return this.rounds;
  }
}

export const keyOf = (prefix: number, len: number): string => `${prefix >>> 0}/${len}`;
const samePath = (a: BgpRoute | undefined, b: BgpRoute | undefined): boolean =>
  a === b || (!!a && !!b && a.path.length === b.path.length && a.path.every((x, i) => x === b.path[i]));
