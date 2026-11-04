// Chapter 51's explorers: the IPv4 header's bytes, longest-prefix match as a walk down a trie, the fast path's scene with a frame sent through
// the gates beside its golden model, and the two routing protocols on the invented network of net/routing.ts.

import '../styles/router.css';
import { BROADCAST, ETHERTYPE_ARP, ETHERTYPE_IPV4, frameBody, type Mac } from '../comm/ethframe';
import { CYCLES_PER_BIT } from '../comm/serdes';
import { routerFastPath } from '../lib';
import { mkChips } from './line';
import { slider } from './mosparts';
import { CAUSE_NAMES, C_FORWARD, FastPathModel, posOf, STATE_NAMES, S_RX, S_TX, type FpIn } from '../net/fastpath';
import { checksum, IP_HEADER, ipOf, ipPacket, ipText, onesSum, PROTO_UDP, ttlChecksum } from '../net/ipv4';
import { CHAIN3, dijkstra, DistVec, floodAll, floodMessages, INFINITY, NET7, type Topology } from '../net/routing';
import { adjImage, buildTrie, lpmLinear, PORT_CPU, routeMatches, walkTrie, type NextHop, type Route } from '../net/trie';
import { h, keepFocus, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';

const hex2 = (v: number) => v.toString(16).padStart(2, '0');
const hex4 = (v: number) => v.toString(16).padStart(4, '0');
const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls, title, type: 'button' }, label); b.addEventListener('click', f); return b; };

// ---- the example tables ---------------------------------------------------------------------------------------------------------

export const CH_OWN: Mac = [0x02, 0, 0, 0, 0, 0xfe];
export const CH_HOST: Mac = [0x02, 0, 0, 0, 0, 0x01];
export const CH_HOPS: Record<number, NextHop> = {
  1: { mac: [0x02, 0, 0, 0, 1, 1], port: 0 }, 2: { mac: [0x02, 0, 0, 0, 2, 2], port: 1 }, 3: { mac: [0x02, 0, 0, 0, 3, 3], port: 2 }, 4: { mac: CH_OWN, port: PORT_CPU },
};
export const CH_ROUTES: Route[] = [
  { prefix: ipOf('0.0.0.0'), len: 0, hop: 1 }, { prefix: ipOf('10.0.0.0'), len: 8, hop: 1 }, { prefix: ipOf('10.1.0.0'), len: 16, hop: 2 },
  { prefix: ipOf('10.1.2.0'), len: 24, hop: 3 }, { prefix: ipOf('10.1.2.1'), len: 32, hop: 4 },
];
/** Without the default route: the fast path's scene, so that "no route" can happen. */
const SCENE_ROUTES = CH_ROUTES.filter((r) => r.len > 0);
export const CH_TRIE = buildTrie(SCENE_ROUTES), CH_ADJ = adjImage(CH_OWN, CH_HOPS);
export const ROUTER_SCENE_DEF = routerFastPath(CH_TRIE, CH_ADJ, '_ch');

// ---- 1. the header ---------------------------------------------------------------------------------------------------------------

const FIELDS: { from: number; to: number; name: string; note: string }[] = [
  { from: 0, to: 0, name: 'Version · IHL', note: '4, and the header length in 32-bit words. 0x45 means no options: every router on the path can find the fields by fixed offset.' },
  { from: 1, to: 1, name: 'TOS', note: 'Priority and congestion marks; a router may queue by it.' },
  { from: 2, to: 3, name: 'Length', note: 'Header and payload in bytes: Ethernet pads short frames, so only this says where the packet ends.' },
  { from: 4, to: 5, name: 'ID', note: 'Names a packet\'s fragments so they can be put back together.' },
  { from: 6, to: 7, name: 'Flags · offset', note: 'DF (0x4000) forbids a router from fragmenting: too big, and it reports back instead.' },
  { from: 8, to: 8, name: 'TTL', note: 'Every router lowers it by one, and at 0 the packet dies. What keeps a routing loop from running forever.' },
  { from: 9, to: 9, name: 'Protocol', note: 'Who takes the payload at the far end: 1 ICMP, 6 TCP, 17 UDP.' },
  { from: 10, to: 11, name: 'Checksum', note: 'Over the header only. It changes at every hop, because the TTL does.' },
  { from: 12, to: 15, name: 'Source', note: 'Where any reply goes. No router on the path needs it to forward.' },
  { from: 16, to: 19, name: 'Destination', note: 'The only field a router looks up.' },
];

export function ipHeaderWidget(): Widget {
  let pkt = ipPacket({ src: ipOf('10.9.9.9'), dst: ipOf('10.1.2.9'), ttl: 64, proto: PROTO_UDP, id: 0x1c46, payload: [] }), sel = 8;
  const flipped = new Set<number>();
  const grid = h('div', { class: 'rt-hdr', role: 'group', 'aria-label': 'The twenty header bytes' }), note = h('p', { class: 'sub' }), sum = h('div', { class: 'err-verdict' });
  const paint = () => {
    grid.replaceChildren(...Array.from({ length: IP_HEADER }, (_, i) => {
      const f = FIELDS.find((x) => i >= x.from && i <= x.to)!, active = sel >= f.from && sel <= f.to;
      const b = h('button', { type: 'button', class: `rt-byte${active ? ' on' : ''}${flipped.has(i) ? ' bad' : ''}`, title: f.name, 'aria-label': `Byte ${i}, ${f.name}: 0x${hex2(pkt[i])}`, 'aria-pressed': String(active) },
        h('i', null, String(i)), hex2(pkt[i]));
      b.addEventListener('click', () => keepFocus(b, () => { sel = i; paint(); }));
      return b;
    }));
    const f = FIELDS.find((x) => sel >= x.from && sel <= x.to)!;
    note.replaceChildren(h('strong', null, `${f.name}. `), f.note);
    const total = onesSum(pkt.slice(0, IP_HEADER)), ok = total === 0xffff;
    sum.className = `err-verdict ${ok ? 'ok' : 'bad'}`;
    sum.textContent = `One's-complement sum of the ten 16-bit words: 0x${hex4(total)}. ${ok ? 'All ones: a good header.' : 'Not all ones: the router drops it without a word to anyone.'}`;
  };
  const decTtl = btn('Lower the TTL, fix the checksum', 'What a router does: RFC 1624\'s update from the old checksum, no re-summing', () => {
    if (pkt[8] === 0) return;
    const old = (pkt[10] << 8) | pkt[11], c = ttlChecksum(old);
    pkt = [...pkt]; pkt[8]--; pkt[10] = c >> 8; pkt[11] = c & 255; sel = 8; paint();
  });
  const flip = btn('Flip a bit in the selected byte', 'A bit error in the header', () => { pkt = [...pkt]; pkt[sel] ^= 1; if (flipped.has(sel)) flipped.delete(sel); else flipped.add(sel); paint(); });
  const fresh = btn('Sum it again', 'Recompute the checksum from the whole header', () => {
    pkt = [...pkt.slice(0, 10), 0, 0, ...pkt.slice(12, 20)];
    const c = checksum(pkt); pkt[10] = c >> 8; pkt[11] = c & 255; flipped.clear(); paint();
  });
  paint();
  return { el: h('div', { class: 'widget rt-w' }, grid, note, sum, h('div', { class: 'ln-presets' }, decTtl, flip, fresh)) };
}

// ---- 2. longest-prefix match ---------------------------------------------------------------------------------------------------------

const routeText = (r: Route) => `${ipText(r.prefix)}/${r.len}`;

export function lpmWidget(): Widget {
  const words = buildTrie(CH_ROUTES);
  let ip = ipOf('10.1.2.9');
  const input = h('input', { class: 'err-in', value: ipText(ip), 'aria-label': 'Destination address', spellcheck: 'false', size: 16 }) as HTMLInputElement;
  const table = h('div', { class: 'rt-table' }), walk = h('div', { class: 'rt-walk', role: 'img' }), verdict = h('div', { class: 'err-verdict ok' });
  const paint = () => {
    const best = lpmLinear(CH_ROUTES, ip), matching = CH_ROUTES.filter((r) => routeMatches(r, ip)), longest = Math.max(...matching.map((r) => r.len), -1);
    table.replaceChildren(...CH_ROUTES.map((r) => h('div', { class: `rt-route${routeMatches(r, ip) ? ' match' : ''}${r.len === longest ? ' best' : ''}` },
      h('code', null, routeText(r)), h('span', null, r.hop === 4 ? 'this router' : `hop ${r.hop}, port ${CH_HOPS[r.hop].port}`), h('em', null, routeMatches(r, ip) ? (r.len === longest ? 'longest match' : 'matches') : ''))));
    const w = walkTrie(words, ip);
    walk.setAttribute('aria-label', `The walk: ${w.reads} reads, node numbers ${w.path.map((p) => p.node).join(', ')}`);
    walk.replaceChildren(...w.path.map((p, i) => h('span', { class: `rt-node${p.hop ? ' has' : ''}`, title: `Node ${p.node}: word 0x${p.word.toString(16).padStart(6, '0')}${p.hop ? `, route to hop ${p.hop}` : ''}` }, i < w.path.length - 1 ? String(p.bit) : '·')));
    verdict.textContent = `${ipText(ip)}: ${w.reads} reads of the trie; ${best === 0 ? 'no route' : best === 4 ? 'this router' : `next hop ${best}`}. A scan of the table agrees${lpmLinear(CH_ROUTES, ip) === w.hop ? '' : ' NOT'}.`;
  };
  input.addEventListener('input', () => { try { ip = ipOf(input.value.trim()); input.classList.remove('bad'); paint(); } catch { input.classList.add('bad'); } });
  const pick = (a: string) => btn(a, `Look up ${a}`, () => { input.value = a; ip = ipOf(a); paint(); });
  paint();
  return {
    el: h('div', { class: 'widget rt-w' },
      h('label', { class: 'err-lab-in' }, 'Destination', input),
      h('div', { class: 'ln-presets' }, pick('10.1.2.1'), pick('10.1.2.9'), pick('10.1.77.1'), pick('10.200.0.1'), pick('172.16.0.1')),
      table, h('div', { class: 'cpu-sec' }, 'The walk: one memory read per bit used; a filled square holds a route'), walk, verdict),
  };
}

// ---- what one engine carries ------------------------------------------------------------------------------------------------------

/** On the link of chapter 46's speed (decision 7): a byte is eight bits of 4 cycles. */
export const BYTE_CYCLES = 8 * CYCLES_PER_BIT;
export const FRAME_60 = 60;
/** On the wire beyond the stream: FCS, preamble and SFD, gap. */
const WIRE_EXTRA = 4 + 8 + 12;
export const wireCycles = (n: number) => (n + WIRE_EXTRA) * BYTE_CYCLES;
export const WIRE_60 = wireCycles(FRAME_60);
/** Bytes in, DECIDE, the walk, ADJ, bytes out. */
export const engineCycles = (n: number, reads: number) => n + 1 + reads + 1 + n;
export const portsServed = (n: number, reads: number) => Math.floor(wireCycles(n) / engineCycles(n, reads));

export function engineWidget(): Widget {
  let n = 60, len = 24;
  const chips = mkChips(4);
  const paint = () => {
    const reads = len + 1, e = engineCycles(n, reads), w = wireCycles(n);
    chips.set(0, String(e), `engine cycles: ${n} in, 1, ${reads} reads, 1, ${n} out`);
    chips.set(1, w.toLocaleString('en-US').replace(/,/g, '\u2009'), `cycles on one link, at ${BYTE_CYCLES} a byte`);
    chips.set(2, String(portsServed(n, reads)), 'ports one engine keeps up with');
    chips.set(3, `${(100 * e / w).toFixed(1)} %`, 'of one port\'s time the engine is busy');
  };
  const a = slider('Frame', 60, 1514, 2, n, (v) => `${v} bytes`, (v) => { n = v; paint(); }), b = slider('Prefix', 0, 32, 1, len, (v) => `/${v}`, (v) => { len = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos rt-w' }, h('div', { class: 'mos-row' }, a.el, b.el), chips.el, h('p', { class: 'sub' }, 'Assumes a route at the end of the walk, and no contention for the engine: each port would need its own buffer to wait in.')) };
}

// ---- 3. the fast path's scene ----------------------------------------------------------------------------------------------------------

export interface FpFrame { name: string; frame: () => number[] }
const udp = (dst: string, ttl = 64) => frameBody({ dst: CH_OWN, src: CH_HOST, type: ETHERTYPE_IPV4, payload: ipPacket({ src: ipOf('10.9.9.9'), dst: ipOf(dst), ttl, proto: PROTO_UDP, id: 0x1c46, payload: [0xde, 0xad, 0xbe, 0xef] }) });
export const FP_FRAMES: FpFrame[] = [
  { name: 'To 10.1.2.9: matches the /24', frame: () => udp('10.1.2.9') },
  { name: 'To 10.1.77.1: the /16', frame: () => udp('10.1.77.1') },
  { name: 'To 10.200.0.1: the /8', frame: () => udp('10.200.0.1') },
  { name: 'TTL of 1', frame: () => udp('10.1.2.9', 1) },
  { name: 'To 172.16.0.1: no route', frame: () => udp('172.16.0.1') },
  { name: 'To 10.1.2.1: this router', frame: () => udp('10.1.2.1') },
  { name: 'ARP, broadcast', frame: () => frameBody({ dst: BROADCAST, src: CH_HOST, type: ETHERTYPE_ARP, payload: new Array<number>(28).fill(0) }) },
  { name: 'A flipped bit in the header', frame: () => { const f = udp('10.1.2.9'); f[29] ^= 4; return f; } },
  { name: 'For another machine\'s MAC', frame: () => { const f = udp('10.1.2.9'); f[5] = 0x33; return f; } },
];

export interface RouterStatus { forwarded: number; punted: number; dropped: number; lastCause: number; lastTtl: number; agree: boolean; frames: number }
export const routerApi = new WeakMap<Stage, { status(): RouterStatus; send(i: number): void; run(): void }>();

export const FP_INPUTS = { rxd: 0, rxv: 0, rxl: 0, txr: 1, cfg_we: 0, cfg_t: 0, cfg_a: 0, cfg_d: 0 };

export function fastPathScene(start = 0): Scene {
  return { root: ROUTER_SCENE_DEF, inputs: { ...FP_INPUTS }, clock: 'clk', autoClock: false, memory: false, hiddenInputs: Object.keys(FP_INPUTS), panels: [fastPathPanel(start)] };
}

function fastPathPanel(start: number): ScenePanel {
  return (stage: Stage): Widget => {
    let m = new FastPathModel(CH_TRIE, CH_ADJ), frame: number[] = [], i = 0, sent: number[] = [], out: number[] = [], cycles = 0, agree = true, wrong = '';
    let forwarded = 0, punted = 0, dropped = 0, lastCause = -1, lastTtl = -1, frames = 0, raf = 0;
    const inputsNow = (): FpIn => {
      const v = i < frame.length && m.s === S_RX;
      return { rxd: v ? frame[i] : 0, rxv: v ? 1 : 0, rxl: v && i === frame.length - 1 ? 1 : 0, txr: 1 };
    };
    const drive = () => { const x = inputsNow(); stage.setInputs({ rxd: x.rxd, rxv: x.rxv, rxl: x.rxl }); };
    const hook = {
      before: () => {
        const x = inputsNow(), o = m.outputs();
        for (const [k, v] of Object.entries(o)) if (stage.value(k) !== v && agree) { agree = false; wrong = `${k}: gates ${stage.value(k)}, model ${v}, cycle ${cycles}`; }
        if (x.rxv) i++;
        if (o.txv) { out.push(o.txd); if (o.txl) { lastCause = o.cause; if (o.cause === C_FORWARD) { forwarded++; lastTtl = out[22]; } else punted++; } }
        const was = m.s;
        m.step(x);
        if (was !== S_TX && was !== S_RX && m.s === S_RX) { dropped++; lastCause = -2; }
        cycles++;
      },
      after: () => { drive(); schedule(); },
    };
    stage.edgeHooks.add(hook);
    const clear = () => { m = new FastPathModel(CH_TRIE, CH_ADJ); frame = []; i = 0; sent = []; out = []; cycles = 0; agree = true; wrong = ''; forwarded = punted = dropped = frames = 0; lastCause = lastTtl = -1; };
    stage.resetHooks.add(() => { clear(); drive(); schedule(); });
    const snap = () => ({ buf: m.buf.slice(), rest: { ...m, buf: undefined, trie: undefined, adj: undefined }, frame: [...frame], i, sent: [...sent], out: [...out], cycles, agree, wrong, forwarded, punted, dropped, lastCause, lastTtl, frames });
    stage.historyHooks.add({
      save: snap,
      restore: (v) => {
        const x = v as ReturnType<typeof snap>;
        Object.assign(m, x.rest, { buf: x.buf.slice(), trie: m.trie, adj: m.adj });
        frame = [...x.frame]; sent = [...x.sent]; out = [...x.out];
        ({ i, cycles, agree, wrong, forwarded, punted, dropped, lastCause, lastTtl, frames } = x);
        schedule();
      },
    });
    const act = (f: () => void) => { stage.checkpoint(); f(); stage.refresh(); schedule(); };
    const runFrame = () => { let guard = 8000; while (guard-- > 0) { stage.runCycles(1); if (i >= frame.length && m.s === S_RX && m.i === 0) break; } };
    const load = (n: number) => { if (i < frame.length || m.s !== S_RX || m.i !== 0) runFrame(); frame = FP_FRAMES[n].frame(); sent = [...frame]; out = []; i = 0; frames++; drive(); };
    
    const sel = h('select', { class: 'mc-sel', 'aria-label': 'Frame to send' }, ...FP_FRAMES.map((f, n) => h('option', { value: String(n) }, f.name))) as HTMLSelectElement;
    sel.value = String(start);
    const bytes = h('div'), status = h('div', { class: 'mc-status' }), lamp = h('div', { class: 'sr-lock' });
    const row = (label: string, b: number[], other: number[] | null, upto: number) => h('div', { class: 'rt-row' }, h('span', { class: 'rt-lab' }, label),
      h('div', { class: 'rt-bytes' }, ...b.slice(0, upto).map((v, k) => h('span', { class: `${other && other[k] !== undefined && other[k] !== v ? 'chg' : ''}${posOf(k).dst ? ' dst' : ''}`, title: `byte ${k}` }, hex2(v)))));
    const SHOW = 38;
    const update = () => {
      bytes.replaceChildren(row('In', sent, null, SHOW), row('Out', out, sent, SHOW));
      status.replaceChildren(
        h('span', null, 'state ', h('b', null, STATE_NAMES[m.s])), h('span', null, 'cycles ', h('b', null, String(cycles))),
        h('span', null, m.s === S_RX ? 'byte in ' : m.s === S_TX ? 'byte out ' : 'bits used ', h('b', null, String(m.s === S_RX || m.s === S_TX ? m.i : m.depth))),
        h('span', null, 'best hop ', h('b', null, String(m.best))),
        h('span', null, 'forwarded ', h('b', null, String(forwarded))), h('span', null, 'sent up ', h('b', null, String(punted))), h('span', null, 'dropped ', h('b', null, String(dropped))));
      lamp.className = `sr-lock ${agree ? (lastCause === -1 ? '' : 'ok') : 'bad'}`;
      lamp.textContent = !agree ? `Gates and model differ: ${wrong}.`
        : lastCause === -1 ? 'Pick a frame and send it. The gates and the golden model step together.'
        : lastCause === -2 ? `Dropped, with nothing sent to anyone. Gates and model agree over ${cycles} cycles.`
        : `${CAUSE_NAMES[lastCause]}, port ${m.port}${m.port === PORT_CPU ? ' (the slow path)' : ''}. Gates and model agree over ${cycles} cycles.`;
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); };
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel rt-panel', 'data-dock': 'right', 'data-phone': 'flow' },
      h('h4', null, 'A frame through the fast path', h('span', { class: 'fold-hint' })),
      h('div', { class: 'mc-row' }, sel),
      h('div', { class: 'dram-ops' },
        btn('Load', 'Put the frame on the stream: then Pulse or Step it through', () => act(() => load(Number(sel.value)))),
        btn('Send', 'The whole frame, until the engine is idle again', () => act(() => { load(Number(sel.value)); runFrame(); }), 'btn sm primary')),
      lamp, status, bytes,
      h('p', { class: 'sub' }, 'Changed bytes are marked on the Out row; the destination address is underlined on both.'));
    update();
    routerApi.set(stage, {
      status: () => ({ forwarded, punted, dropped, lastCause, lastTtl, agree, frames }),
      send: (n) => { sel.value = String(n); act(() => { load(n); runFrame(); }); },
      run: () => act(runFrame),
    });
    return { el, update, destroy: () => { stage.edgeHooks.delete(hook); routerApi.delete(stage); if (raf) cancelAnimationFrame(raf); } };
  };
}

// ---- 4 and 5. the routing protocols --------------------------------------------------------------------------------------------------

function netSvg(t: Topology, W = 600, H = 300): { el: SVGSVGElement; paint(o: { down?: ReadonlySet<string>; onLink?: (a: number, b: number) => void; hi?: Set<string>; label?: (n: number) => string; node?: (n: number) => string }): void } {
  const el = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'rt-net', role: 'group', 'aria-label': 'The invented network: click a link to fail or repair it' }) as SVGSVGElement;
  return {
    el,
    paint(o) {
      el.replaceChildren();
      for (const l of t.links) {
        const [x1, y1] = t.at[l.a], [x2, y2] = t.at[l.b], key = l.a < l.b ? `${l.a}-${l.b}` : `${l.b}-${l.a}`, off = o.down?.has(key);
        const g = s('g', { class: `rt-link${off ? ' off' : ''}${o.hi?.has(key) ? ' hi' : ''}`, 'data-k': key, role: 'button', tabindex: '0', 'aria-label': `Link ${t.names[l.a]} to ${t.names[l.b]}, cost ${l.cost}, ${off ? 'down' : 'up'}` });
        g.append(s('line', { x1, y1, x2, y2, class: 'hit' }), s('line', { x1, y1, x2, y2, class: 'ln' }), s('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 6, 'text-anchor': 'middle' }, off ? '✕' : String(l.cost)));
        // the repaint makes new links: the keyboard stays on this one
        const go = () => { o.onLink?.(l.a, l.b); (el.querySelector(`[data-k="${key}"]`) as SVGGElement | null)?.focus({ preventScroll: true }); };
        g.addEventListener('click', go);
        g.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') { e.preventDefault(); go(); } });
        el.append(g);
      }
      t.names.forEach((nm, n) => {
        const [x, y] = t.at[n];
        el.append(s('g', { class: `rt-router ${o.node?.(n) ?? ''}` }, s('circle', { cx: x, cy: y, r: 19 }), s('text', { x, y: y + 5, 'text-anchor': 'middle' }, nm), s('text', { x, y: y + 36, 'text-anchor': 'middle', class: 'rt-d' }, o.label?.(n) ?? '')));
      });
    },
  };
}

/** Distance vector: rounds, a link failing, and counting to infinity on the chain. */
export function distVecWidget(): Widget {
  let chain = false, poison = false, dv = new DistVec(NET7), dest = 6, history: number[] = [];
  const net = (() => netSvg(NET7))(), chainNet = netSvg(CHAIN3, 600, 160);
  const host = h('div'), tbl = h('div', { class: 'rt-table' }), note = h('div', { class: 'err-verdict' }), rounds = h('div', { class: 'mc-status' }), hist = h('div', { class: 'rt-bytes rt-hist', role: 'img' });
  const topo = () => (chain ? CHAIN3 : NET7);
  const paint = () => {
    const t = topo(), n = chain ? chainNet : net;
    host.replaceChildren(n.el);
    n.paint({
      down: dv.down,
      onLink: (a, b) => { const k = a < b ? `${a}-${b}` : `${b}-${a}`; if (dv.down.has(k)) dv.repair(a, b); else dv.fail(a, b); history = []; paint(); },
      label: (i) => (i === dest ? 'to here' : dv.dist[i][dest] >= INFINITY ? '∞' : `${dv.dist[i][dest]} via ${dv.via[i][dest] < 0 ? '–' : t.names[dv.via[i][dest]]}`),
      node: (i) => (i === dest ? 'dst' : dv.dist[i][dest] >= INFINITY ? 'lost' : ''),
    });
    tbl.replaceChildren(h('div', { class: 'rt-route' }, h('code', null, 'To'), ...t.names.map((nm, j) => h('button', { type: 'button', class: `rt-to${j === dest ? ' on' : ''}`, 'aria-pressed': String(j === dest), onclick: () => { dest = j; history = []; const k = t.names.indexOf(nm); paint(); (tbl.querySelectorAll('button')[k] as HTMLButtonElement | undefined)?.focus({ preventScroll: true }); } }, nm))));
    rounds.replaceChildren(h('span', null, 'rounds ', h('b', null, String(dv.rounds))), h('span', null, 'tables sent ', h('b', null, String(dv.messages))));
    hist.replaceChildren(...history.map((v) => h('span', null, v >= INFINITY ? '∞' : String(v))));
    hist.setAttribute('aria-label', `Cost at ${t.names[Math.max(0, t.names.length - 2)]} to the destination, round by round: ${history.join(', ')}`);
    const right = t.names.every((_, i) => { const d = dijkstra(t, i, dv.down).dist[dest]; return i === dest || (d === Infinity ? dv.dist[i][dest] >= INFINITY : dv.dist[i][dest] === d); });
    note.className = `err-verdict ${right ? 'ok' : ''}`;
    note.textContent = right ? 'Every router\'s cost to the destination equals Dijkstra\'s on the same links.' : 'Not settled: some router still believes a cost that no path has.';
  };
  const round = () => { const c = dv.round(); const t = topo(); history.push(dv.dist[t.names.length - 2][dest]); if (history.length > 22) history.shift(); paint(); return c; };
  const reset = () => { dv = new DistVec(topo(), poison); dest = topo().names.length - 1; history = []; dv.settle(); paint(); };
  const poisonBox = h('input', { type: 'checkbox', 'aria-label': 'Poison reverse' }) as HTMLInputElement;
  poisonBox.addEventListener('change', () => { poison = poisonBox.checked; reset(); });
  dv.settle();
  paint();
  return {
    el: h('div', { class: 'widget rt-w' }, host, tbl,
      h('div', { class: 'ln-presets' },
        btn('Round', 'Every router sends its table to its neighbours', () => { round(); }, 'btn sm primary'),
        btn('Until settled', 'Rounds until no table changes', () => { let g = 40; while (g-- > 0 && round()); }),
        btn('The chain', 'A - B - C: fail the link B - C, and count', () => { chain = true; reset(); }),
        btn('The network', 'Seven routers, ten links', () => { chain = false; reset(); }),
        h('label', { class: 'err-lab-in' }, poisonBox, 'Poison reverse')),
      rounds, h('div', { class: 'cpu-sec' }, 'Cost at the router before the last, round by round'), hist, note,
      h('p', { class: 'sub' }, 'The network is invented. Click a link to fail or repair it, then run rounds.')),
  };
}

/** Link state: flood every link, then Dijkstra one settled router at a time. */
export function linkStateWidget(): Widget {
  const down = new Set<string>();
  let src = 0, k = NET7.names.length;
  const n = netSvg(NET7), order = h('div', { class: 'mc-status' }), cost = h('div', { class: 'err-verdict ok' }), table = h('div', { class: 'rt-table' });
  const paint = () => {
    const r = dijkstra(NET7, src, down), done = new Set(r.order.slice(0, k));
    const tree = new Set<string>();
    for (const v of done) if (r.prev[v] >= 0) { const a = r.prev[v]; tree.add(a < v ? `${a}-${v}` : `${v}-${a}`); }
    n.paint({
      down, hi: tree,
      onLink: (a, b) => { const key = a < b ? `${a}-${b}` : `${b}-${a}`; if (down.has(key)) down.delete(key); else down.add(key); k = NET7.names.length; paint(); },
      label: (i) => (done.has(i) ? String(r.dist[i]) : ''), node: (i) => (i === src ? 'dst' : done.has(i) ? 'done' : ''),
    });
    order.replaceChildren(h('span', null, 'settled ', h('b', null, r.order.slice(0, k).map((v) => NET7.names[v]).join(' ') || 'none')));
    table.replaceChildren(h('div', { class: 'rt-route' }, h('code', null, 'From'), ...NET7.names.map((nm, j) => h('button', { type: 'button', class: `rt-to${j === src ? ' on' : ''}`, 'aria-pressed': String(j === src), onclick: () => { src = j; k = NET7.names.length; paint(); (table.querySelectorAll('button')[j] as HTMLButtonElement | undefined)?.focus({ preventScroll: true }); } }, nm))));
    const dv = new DistVec(NET7); dv.down = new Set(down); dv.settle();
    cost.textContent = `From nothing: flooding sends ${floodAll(NET7, down)} link reports (${floodMessages(NET7, src, down)} for ${NET7.names[src]}'s own), and each router runs Dijkstra alone. Distance vector, on the same links, sends ${dv.messages} whole tables over ${dv.rounds} rounds.`;
  };
  paint();
  return {
    el: h('div', { class: 'widget rt-w' }, n.el, table,
      h('div', { class: 'ln-presets' },
        btn('Start Dijkstra', 'No router settled', () => { k = 0; paint(); }),
        btn('Settle the next', 'The nearest router not yet settled', () => { k = Math.min(NET7.names.length, k + 1); paint(); }, 'btn sm primary'),
        btn('All', 'Run it out', () => { k = NET7.names.length; paint(); })),
      order, cost, h('p', { class: 'sub' }, 'The network is invented. Click a link to fail or repair it.')),
  };
}
