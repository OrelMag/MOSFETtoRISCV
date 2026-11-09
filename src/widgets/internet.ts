// Chapter pcie's explorers on the invented network of net/internet.ts: the map with any router's table, BGP in rounds, DNS with its bytes, traceroute,
// a frame carried hop by hop through the gates of chapter errors's fast path, one packet's delays, and a whole page.

import '../styles/router.css';
import '../styles/internet.css';
import { pcapFile, type Captured } from '../comm/pcap';
import { routerFastPath } from '../lib/router';
import { saveFile } from '../view/image';
import { slider } from './mosparts';
import { CAUSE_NAMES, C_FORWARD, FastPathModel, S_RX, type FpIn } from '../net/fastpath';
import { AS_FERN, AS_QUIL, AS_SABLE, ASES, asPrefix, hostFrame, hostId, hostIp, HOSTS, Internet, linkKey, LINKS, linksOf, loadWrites, probeFrame, RELATIONS, routerIp, ROUTERS, routersOf, TCP_ACK, TCP_PSH, tcpSegment, traceroute, type Journey, type TraceRow } from '../net/internet';
import { BgpNet, CLS_NAMES, keyOf, type BgpOptions } from '../net/internetbgp';
import { fetchMs, fetchPhases, journeyDelays, LAN, type LinkQueue, oneWayMs, pageOver, propMs, sampledMs, serMs, type StackName, queueMs } from '../net/internetdelay';
import { decodeDns, RCODE_NXDOMAIN, Resolver, SITE, TTL_A, type Resolution } from '../net/internetdns';
import { ipText, parseIp, PROTO_TCP, PROTO_UDP } from '../net/ipv4';
import { routeMatches, TRIE_NODES, walkTrie } from '../net/trie';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { numOf } from '../chapters/order';
import { groupNum } from '../sim/numfmt';

const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls, title, type: 'button' }, label); b.addEventListener('click', f); return b; };
const hex2 = (v: number) => v.toString(16).padStart(2, '0');
const hexText = (b: readonly number[]) => b.map(hex2).join(' ');
const ms2 = (v: number) => (v > 0 && v < 0.001 ? '<0.001' : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3));
const n0 = (x: number) => groupNum(Math.round(x));
const pick = (label: string, options: [string, string][], value: string, f: (v: string) => void) => {
  const e = h('select', { class: 'mc-sel', 'aria-label': label }, ...options.map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;
  e.value = value;
  e.addEventListener('change', () => f(e.value));
  return e;
};
const check = (label: string, on: boolean, f: (v: boolean) => void) => {
  const i = h('input', { type: 'checkbox' }) as HTMLInputElement;
  i.checked = on;
  i.addEventListener('change', () => f(i.checked));
  return h('label', { class: 'err-lab-in' }, i, label);
};
const hostOptions = (): [string, string][] => HOSTS.map((x, i) => [String(i), `${x.name} (${ipText(hostIp(i))})`]);

export const LAPTOP = hostId('laptop'), WWW = hostId('www');

// ---- the map --------------------------------------------------------------------------------------------------------------------

const W = 760, H = 300;
interface MapPaint { down: ReadonlySet<string>; lit: readonly number[]; litLinks: readonly number[]; sel?: number; onLink?: (i: number) => void; onRouter?: (r: number) => void }

function netMap() {
  const el = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'rt-net in-map', role: 'group', 'aria-label': 'The invented network: eight networks, sixteen routers' });
  return {
    el,
    paint(p: MapPaint) {
      const kids: SVGElement[] = [];
      ASES.forEach((a, i) => {
        const rs = ROUTERS.filter((r) => r.as === i);
        // the name has a row of its own under the routers, centred, where no link passes
        const half = a.name.length * 2.9 + 6, xa = Math.min(...rs.map((r) => r.at[0])), xb = Math.max(...rs.map((r) => r.at[0])), mid = (xa + xb) / 2;
        const x0 = Math.min(xa - 26, mid - half), x1 = Math.max(xb + 26, mid + half), y0 = Math.min(...rs.map((r) => r.at[1])) - 20, y1 = Math.max(...rs.map((r) => r.at[1])) + 32;
        const g = s('g', { class: 'in-as', style: `--as-h:${a.hue}` });
        g.append(s('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 10 }), s('text', { x: mid, y: y1 - 5, 'text-anchor': 'middle' }, a.name));
        kids.push(g);
      });
      LINKS.forEach((l, i) => {
        const a = ROUTERS[l.a].at, b = ROUTERS[l.b].at, off = p.down.has(linkKey(i)), lit = p.litLinks.includes(i);
        const g = s('g', { class: `rt-link${off ? ' off' : ''}${lit ? ' hi' : ''}`, role: 'button', tabindex: 0, 'aria-label': `Link ${ROUTERS[l.a].name} to ${ROUTERS[l.b].name}, ${l.km} km, ${l.note}: ${off ? 'failed, press to repair' : 'press to fail'}` });
        g.append(s('line', { class: 'hit', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }), s('line', { class: 'ln', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }));
        if (p.onLink) {
          const act = () => p.onLink!(i);
          g.addEventListener('click', act);
          g.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') { e.preventDefault(); act(); } });
        }
        kids.push(g);
      });
      ROUTERS.forEach((r, i) => {
        const g = s('g', { class: `rt-router${p.lit.includes(i) ? ' done' : ''}${p.sel === i ? ' dst' : ''}`, role: 'button', tabindex: 0, 'aria-label': `Router ${r.name} of ${ASES[r.as].name}: show its table` });
        g.append(s('circle', { cx: r.at[0], cy: r.at[1], r: 13 }), s('text', { x: r.at[0], y: r.at[1] + 4, 'text-anchor': 'middle', class: 'in-rname' }, r.name));
        if (p.onRouter) {
          const act = () => p.onRouter!(i);
          g.addEventListener('click', act);
          g.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') { e.preventDefault(); act(); } });
        }
        kids.push(g);
      });
      el.replaceChildren(...kids);
    },
  };
}

const asPathText = (j: Journey): string => {
  const out: number[] = [];
  for (const r of routersOf(j)) { const a = ROUTERS[r].as; if (out[out.length - 1] !== a) out.push(a); }
  return out.map((a) => ASES[a].name).join(' → ');
};
const endText = (j: Journey): string => {
  const e = j.end;
  if (e.kind === 'host') return `arrives at ${HOSTS[e.host].name}`;
  if (e.kind === 'noroute') return `stops at ${ROUTERS[e.router].name}: no route. A real router sends ICMP "unreachable" back, traceroute's !N; this model only drops it`;
  if (e.kind === 'router') return `ends inside ${ROUTERS[e.router].name}, in ${ASES[ROUTERS[e.router].as].name}`;
  if (e.kind === 'expired') return `TTL runs out at ${ROUTERS[e.router].name}`;
  return 'is lost';
};

const routeSource = (r: number, prefix: number, len: number): string => {
  if (len === 32) return prefix === routerIp(r) ? 'this router' : 'a host on its wire';
  if (len === 24) return 'inside: link state';
  return 'between networks: BGP';
};

/** The map, a pair of hosts, and any router's table: where chapter errors's trie gets its contents. */
export function networkWidget(): Widget {
  const down = new Set<string>();
  let from = LAPTOP, to = WWW, sel = 0;
  const map = netMap(), path = h('div', { class: 'err-verdict ok' }), chips = h('div', { class: 'mc-status' }), table = h('div', { class: 'rt-table' }), head = h('div', { class: 'cpu-sec' });
  const paint = () => {
    const net = new Internet({ down }), j = net.send(from, hostFrame(from, hostIp(to), 64, PROTO_UDP, new Array<number>(20).fill(0)));
    map.paint({ down, lit: routersOf(j), litLinks: linksOf(j), sel, onLink: (i) => { const k = linkKey(i); if (down.has(k)) down.delete(k); else down.add(k); paint(); }, onRouter: (r) => { sel = r; paint(); } });
    path.className = `err-verdict ${j.end.kind === 'host' ? 'ok' : 'bad'}`;
    path.textContent = `${asPathText(j)}: ${endText(j)}.`;
    const km = linksOf(j).reduce((a, i) => a + LINKS[i].km, 0);
    chips.replaceChildren(h('span', null, 'routers ', h('b', null, String(j.hops.length))), h('span', null, 'fibre ', h('b', null, `${n0(km)} km`)), h('span', null, 'light alone, one way ', h('b', null, `${ms2(linksOf(j).reduce((a, i) => a + propMs(LINKS[i]), 0))} ms`)));
    const t = net.tableOf(sel), ip = hostIp(to), w = walkTrie(t.trie, ip);
    head.textContent = `${ROUTERS[sel].name}, ${ASES[ROUTERS[sel].as].name}: ${t.routes.length} routes, ${t.trie.length} trie nodes of ${TRIE_NODES}, ${w.reads} reads for ${ipText(ip)}`;
    const dest = (hop: number) => { const x = t.to[hop]; return x === 'self' ? 'the slow path' : x.host !== undefined ? HOSTS[x.host].name : ROUTERS[x.router!].name; };
    const sorted = [...t.routes].sort((a, b) => b.len - a.len || a.prefix - b.prefix);
    table.replaceChildren(...sorted.map((r) => h('div', { class: `rt-route${r.hop === w.hop && routeMatches(r, ip) ? ' best' : ''}` }, h('code', null, `${ipText(r.prefix)}/${r.len}`), h('span', null, `→ ${dest(r.hop)}`), h('em', null, routeSource(sel, r.prefix, r.len)))));
  };
  paint();
  return {
    el: h('div', { class: 'widget rt-w' },
      h('div', { class: 'ln-presets' },
        h('span', null, 'From ', pick('From host', hostOptions(), String(from), (v) => { from = +v; paint(); })),
        h('span', null, 'to ', pick('To host', hostOptions(), String(to), (v) => { to = +v; paint(); }))),
      h('div', { class: 'in-scroll' }, map.el), path, chips, head, table,
      h('p', { class: 'sub' }, 'The network is invented: no name, number or address here belongs to anyone. Click a link to fail or repair it, a router to read its table.')),
  };
}

// ---- BGP --------------------------------------------------------------------------------------------------------------------------

/** Rounds of BGP, watched from one prefix's point of view. */
export function bgpWidget(): Widget {
  let policy = true, hijack = false, dest = AS_QUIL, from = AS_FERN;
  const www = hostIp(WWW), claim = { as: AS_SABLE, prefix: (www & 0xffffff00) >>> 0, len: 24 };
  const opts = (): BgpOptions => ({ policy, hijack: hijack ? claim : undefined });
  let b = new BgpNet(RELATIONS, opts());
  const rows = h('div', { class: 'rt-table' }), chips = h('div', { class: 'mc-status' }), verdict = h('div', { class: 'err-verdict' });
  const keyNow = () => (hijack && dest === AS_QUIL ? keyOf(claim.prefix, claim.len) : keyOf(asPrefix(dest), 16));
  const paint = () => {
    const k = keyNow();
    rows.replaceChildren(...ASES.map((a, i) => {
      const r = b.best(i, k);
      const text = !r ? '—' : r.path.length === 0 ? 'its own' : r.path.map((x) => ASES[x].name.split(' ')[0]).join(' → ');
      return h('div', { class: `rt-route${i === from ? ' best' : ''}${r ? ' match' : ''}` }, h('code', null, `AS${a.asn}`), h('span', { class: 'in-as-name' }, a.name), h('span', null, text), h('em', null, r && r.path.length ? `via a ${CLS_NAMES[r.cls]}` : ''));
    }));
    chips.replaceChildren(h('span', null, 'rounds ', h('b', null, String(b.rounds))), h('span', null, 'updates ', h('b', null, String(b.messages))), h('span', null, 'refused, own number in the path ', h('b', null, String(b.refused))));
    const net = new Internet({ policy, hijack: hijack ? claim : undefined }), j = net.send(LAPTOP, hostFrame(LAPTOP, dest === AS_QUIL ? hostIp(WWW) : routerIp(ROUTERS.findIndex((x) => x.as === dest)), 64, PROTO_UDP, new Array<number>(20).fill(0)));
    verdict.className = `err-verdict ${j.end.kind === 'host' ? 'ok' : 'bad'}`;
    verdict.textContent = `Settled, a packet from the laptop goes ${asPathText(j)} and ${endText(j)}.`;
  };
  const restart = () => { b = new BgpNet(RELATIONS, opts()); paint(); };
  paint();
  return {
    el: h('div', { class: 'widget rt-w' },
      h('div', { class: 'ln-presets' },
        h('span', null, 'Routes to ', pick('Destination network', ASES.map((a, i) => [String(i), a.name]), String(dest), (v) => { dest = +v; paint(); })),
        h('span', null, 'watch ', pick('Network to mark', ASES.map((a, i) => [String(i), a.name]), String(from), (v) => { from = +v; paint(); }))),
      h('div', { class: 'ln-presets' },
        btn('Round', 'Every network tells its neighbours what it chose', () => { b.round(); paint(); }, 'btn sm primary'),
        btn('Until settled', 'Rounds until no choice changes', () => { let g = 32; while (g-- > 0 && b.round()); paint(); }),
        btn('Start over', 'Only each origin knows its prefix', restart),
        check('Policy: follow the money', policy, (v) => { policy = v; restart(); }),
        check(`Sable claims ${ipText(claim.prefix)}/24`, hijack, (v) => { hijack = v; restart(); })),
      chips, rows, verdict,
      h('p', { class: 'sub' }, `Kept: a customer's route over a peer's over a provider's, then the shorter path, then the lower number. Sent on: your own and your customers' routes to everyone, the rest only to customers.`)),
  };
}

// ---- DNS --------------------------------------------------------------------------------------------------------------------------

/** One name, asked through a resolver with a memory. */
export function dnsWidget(): Widget {
  const net = new Internet();
  let res = new Resolver(net), now = 0, name = SITE, last: Resolution | null = null, sel = 0;
  const steps = h('div', { class: 'rt-table' }), bytes = h('div', { class: 'in-hex' }), chips = h('div', { class: 'mc-status' }), cache = h('div', { class: 'rt-table' }), detail = h('p', { class: 'sub' });
  const paint = () => {
    chips.replaceChildren(h('span', null, 'clock ', h('b', null, `${n0(now)} s`)), ...(last ? [h('span', null, 'questions to servers ', h('b', null, String(last.lookups))), h('span', null, 'messages ', h('b', null, String(last.steps.length))), h('span', null, 'one after another ', h('b', null, `${ms2(last.ms)} ms`)), h('span', null, 'answer ', h('b', null, last.answer !== null ? ipText(last.answer) : last.rcode === RCODE_NXDOMAIN ? 'no such name' : '—'))] : []));
    steps.replaceChildren(...(last ? last.steps : []).map((x, i) => h('button', { type: 'button', class: `rt-route in-step${i === sel ? ' best' : ''}`, 'aria-pressed': String(i === sel), onclick: () => { sel = i; paint(); } }, h('code', null, `${HOSTS[x.from].name} → ${HOSTS[x.to].name}`), h('span', null, x.note), h('em', null, `${ms2(x.ms)} ms`))));
    const st = last?.steps[sel];
    if (st) {
      const m = decodeDns(st.frame.slice(42));
      const rr = [...m.answer, ...m.authority, ...m.additional].map((r) => `${r.name || '.'} ${r.type === 1 ? `A ${ipText(r.data as number)}` : `NS ${r.data}`} (TTL ${n0(r.ttl)})`);
      detail.textContent = `${m.qr ? 'Response' : 'Query'}, id 0x${m.id.toString(16)}, ${m.qr ? (m.aa ? 'authoritative' : 'not authoritative') : m.rd ? 'recursion desired' : 'no recursion'}, for ${m.qname}. ${rr.join('; ')}`;
      const dnsLen = ((st.frame[16] << 8) | st.frame[17]) - 28;
      bytes.textContent = hexText(st.frame.slice(42, 42 + dnsLen));
    } else { detail.textContent = ''; bytes.textContent = ''; }
    const c = res.cached(now);
    cache.replaceChildren(...(c.length ? c : []).map((x) => h('div', { class: 'rt-route' }, h('code', null, x.rr.name), h('span', null, x.rr.type === 1 ? ipText(x.rr.data as number) : `NS ${x.rr.data}`), h('em', null, `${n0(x.left)} s left`))));
    if (!c.length) cache.replaceChildren(h('div', { class: 'sub' }, 'Empty, or all expired.'));
  };
  paint();
  return {
    el: h('div', { class: 'widget rt-w' },
      h('div', { class: 'ln-presets' },
        pick('Name', [[SITE, SITE], ['nope.quillon.example', 'nope.quillon.example']], name, (v) => { name = v; }),
        btn('Look up', 'The laptop asks its resolver', () => { last = res.resolve(LAPTOP, name, now); sel = 0; paint(); }, 'btn sm primary'),
        btn(`Wait ${TTL_A + 1} s`, 'Past the address record\'s TTL', () => { now += TTL_A + 1; paint(); }),
        btn('Wait 3 days', 'Past every TTL', () => { now += 3 * 86_400; paint(); }),
        btn('Empty the cache', 'A resolver just started', () => { res = new Resolver(net); last = null; now = 0; paint(); })),
      chips, steps, detail, h('div', { class: 'cpu-sec' }, 'The DNS message, RFC 1035'), bytes, h('div', { class: 'cpu-sec' }, 'The resolver\'s cache'), cache),
  };
}

// ---- traceroute -----------------------------------------------------------------------------------------------------------------------

/** The bytes of a capture: every probe and its reply, timed as the model times them. */
export function traceCapture(rows: readonly TraceRow[]): Captured[] {
  let us = 0;
  const out: Captured[] = [];
  for (const r of rows) {
    const probe = r.forward.hops[0].frameIn;
    out.push({ us, bytes: probe });
    const back = r.back.end.kind === 'host' ? r.back.end.frame : null;
    if (back) out.push({ us: us + Math.round((oneWayMs(r.forward, probe.length) + oneWayMs(r.back, back.length)) * 1000), bytes: back });
    us += 1_000_000;
  }
  return out;
}

export function tracerouteWidget(): Widget {
  const down = new Set<string>();
  let to = WWW, shown = 0, sel = 0, seed = 1;
  const map = netMap(), rowsEl = h('div', { class: 'in-scroll' }), detail = h('p', { class: 'sub' }), bytes = h('div', { class: 'in-hex' });
  let rows: TraceRow[] = [], times: number[][] = [];
  const compute = () => {
    const net = new Internet({ down });
    rows = traceroute(net, LAPTOP, hostIp(to));
    const queues = new Map<number, LinkQueue>();
    times = rows.map((r) => [0, 1, 2].map(() => {
      const f = r.forward.hops[0].frameIn.length, b = r.back.end.kind === 'host' ? r.back.end.frame.length : 60;
      return sampledMs(r.forward, f, queues, seed) + sampledMs(r.back, b, queues, seed);
    }));
  };
  const paint = () => {
    const vis = rows.slice(0, shown), cur = vis[Math.min(sel, vis.length - 1)];
    map.paint({ down, lit: cur ? routersOf(cur.forward) : [], litLinks: cur ? linksOf(cur.forward) : [], onLink: (i) => { const k = linkKey(i); if (down.has(k)) down.delete(k); else down.add(k); compute(); shown = 0; sel = 0; paint(); } });
    const table = h('table', { class: 'in-table' }, h('thead', null, h('tr', null, h('th', null, 'TTL'), h('th', null, 'Who answered'), h('th', null, 'Network'), h('th', { class: 'r' }, '1st, ms'), h('th', { class: 'r' }, '2nd'), h('th', { class: 'r' }, '3rd'))),
      h('tbody', null, ...vis.map((r, i) => h('tr', { class: i === sel ? 'on' : '', tabindex: 0, onclick: () => { sel = i; paint(); }, onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') { sel = i; paint(); } } },
        h('td', null, String(r.ttl)), h('td', null, h('code', null, r.router !== undefined ? ROUTERS[r.router].name : HOSTS[r.host!].name), ` ${ipText(r.from)}`), h('td', null, ASES[r.router !== undefined ? ROUTERS[r.router].as : ROUTERS[HOSTS[r.host!].router].as].name),
        ...times[i].map((t) => h('td', { class: 'r' }, ms2(t)))))));
    rowsEl.replaceChildren(table);
    if (cur) {
      const ip = parseIp(cur.forward.hops[0].frameIn.slice(14));
      detail.textContent = `The probe left with TTL ${ip.ttl}. ${cur.reached ? 'The far host has nothing on that port: ICMP type 3, code 3, port unreachable, and that is how traceroute knows it arrived.' : `${ROUTERS[cur.router!].name} would have to pass on a TTL of 0: its fast path sends the frame up, and the slow path sends ICMP type 11, time exceeded, from its own address.`} Routers on the reply's way back: ${cur.back.hops.length}.`;
      bytes.textContent = hexText(cur.reply);
    } else {
      detail.textContent = rows.length ? 'Press Next probe.' : 'No route from here: the first router has nothing for this address.';
      bytes.textContent = '';
    }
  };
  compute(); paint();
  const save = () => saveFile('traceroute.pcap', new Blob([pcapFile(traceCapture(rows)).slice().buffer]), 'application/vnd.tcpdump.pcap');
  return {
    el: h('div', { class: 'widget rt-w' },
      h('div', { class: 'ln-presets' },
        h('span', null, 'From the laptop to ', pick('Destination', hostOptions().filter(([v]) => +v !== LAPTOP), String(to), (v) => { to = +v; compute(); shown = 0; sel = 0; paint(); })),
        btn('Next probe', 'One more TTL', () => { if (shown < rows.length) { shown++; sel = shown - 1; paint(); } }, 'btn sm primary'),
        btn('All', 'Run it out', () => { shown = rows.length; sel = shown - 1; paint(); }),
        btn('Probe again', 'Three more probes per TTL, with different luck in the queues', () => { seed = (seed + 1) >>> 0; compute(); paint(); }),
        btn('Save capture', 'A .pcap of one probe and reply per line, for Wireshark', save)),
      h('div', { class: 'in-scroll' }, map.el), rowsEl, detail, h('div', { class: 'cpu-sec' }, 'The reply\'s ICMP message'), bytes,
      h('p', { class: 'sub' }, 'No packet leaves your machine. This is the model\'s network, and its times are the model\'s: light, bits and seeded queues. The capture holds one probe a line, at the mean delays, not these samples. Click a link to fail it.')),
  };
}

// ---- a frame through the gates, hop by hop --------------------------------------------------------------------------------------------

export const PATH_DEF = routerFastPath(new Array<number>(TRIE_NODES).fill(0), new Array<number>(128).fill(0), '_path');
const PATH_INPUTS = { rxd: 0, rxv: 0, rxl: 0, txr: 1, cfg_we: 0, cfg_t: 0, cfg_a: 0, cfg_d: 0 };

const GET = Array.from(`GET / HTTP/1.1\r\nHost: ${SITE}\r\n\r\n`, (c) => c.charCodeAt(0));
const www = () => hostIp(WWW), lap = () => hostIp(LAPTOP);
export const PATH_FRAMES: { name: string; frame: () => number[] }[] = [
  { name: `The page's request (TCP, ${GET.length} bytes of HTTP)`, frame: () => hostFrame(LAPTOP, www(), 64, PROTO_TCP, tcpSegment(lap(), www(), 49200, 80, 1, 1, TCP_ACK | TCP_PSH, GET)) },
  { name: 'A traceroute probe, TTL 64', frame: () => probeFrame(LAPTOP, www(), 64) },
  { name: 'A traceroute probe, TTL 3', frame: () => probeFrame(LAPTOP, www(), 3) },
];

export interface PathStatus { hops: number; total: number; same: boolean; agree: boolean; arrived: boolean; cycles: number; lastCause: number }
export const pathApi = new WeakMap<Stage, { status(): PathStatus; next(): void; all(): void; choose(i: number): void }>();

export function pathScene(start = 0): Scene {
  return { root: PATH_DEF, inputs: { ...PATH_INPUTS }, clock: 'clk', autoClock: false, memory: false, hiddenInputs: Object.keys(PATH_INPUTS), panels: [pathPanel(start)] };
}

function pathPanel(start: number): ScenePanel {
  return (stage: Stage): Widget => {
    const net = new Internet();
    const blank = () => new FastPathModel(new Array<number>(TRIE_NODES).fill(0), new Array<number>(128).fill(0));
    let m = blank(), choice = start, j = net.send(LAPTOP, PATH_FRAMES[start].frame()), hop = 0;
    let writes: ReturnType<typeof loadWrites> = [], wi = 0, frame: number[] = [], i = 0, out: number[] = [], lastCause = -1;
    let cycles = 0, agree = true, wrong = '', same = true, doneHops = 0, loadCycles = 0, frameCycles = 0, raf = 0, timer = 0;
    const inputsNow = (): FpIn => {
      if (wi < writes.length) return { rxd: 0, rxv: 0, rxl: 0, txr: 1, ...writes[wi] };
      const v = i < frame.length && m.s === S_RX;
      return { rxd: v ? frame[i] : 0, rxv: v ? 1 : 0, rxl: v && i === frame.length - 1 ? 1 : 0, txr: 1 };
    };
    const drive = () => { const x = inputsNow(); stage.setInputs({ rxd: x.rxd, rxv: x.rxv, rxl: x.rxl, cfg_we: x.cfgWe ?? 0, cfg_t: x.cfgT ?? 0, cfg_a: x.cfgA ?? 0, cfg_d: x.cfgD ?? 0 }); };
    const hook = {
      before: () => {
        const x = inputsNow(), o = m.outputs();
        for (const [k, v] of Object.entries(o)) if (stage.value(k) !== v && agree) { agree = false; wrong = `${k}: gates ${stage.value(k)}, model ${v}, cycle ${cycles}`; }
        if (wi < writes.length) { wi++; loadCycles++; } else {
          if (x.rxv) i++;
          if (o.txv) { out.push(o.txd); if (o.txl) lastCause = o.cause; }
          frameCycles++;
        }
        m.step(x);
        cycles++;
      },
      after: () => { drive(); schedule(); },
    };
    stage.edgeHooks.add(hook);
    const clear = () => { m = blank(); j = net.send(LAPTOP, PATH_FRAMES[choice].frame()); hop = 0; writes = []; wi = 0; frame = []; i = 0; out = []; lastCause = -1; cycles = 0; agree = true; wrong = ''; same = true; doneHops = 0; loadCycles = 0; frameCycles = 0; };
    stage.resetHooks.add(() => { stopAll(); clear(); drive(); schedule(); });
    const snap = () => ({ buf: m.buf.slice(), trie: m.trie.slice(), adj: m.adj.slice(), rest: { ...m, buf: undefined, trie: undefined, adj: undefined }, choice, j, hop, writes, wi, frame, i, out: [...out], lastCause, cycles, agree, wrong, same, doneHops, loadCycles, frameCycles });
    stage.historyHooks.add({
      save: snap,
      restore: (v) => {
        stopAll();
        const x = v as ReturnType<typeof snap>;
        Object.assign(m, x.rest, { buf: x.buf.slice(), trie: x.trie.slice(), adj: x.adj.slice() });
        out = [...x.out];
        ({ choice, j, hop, writes, wi, frame, i, lastCause, cycles, agree, wrong, same, doneHops, loadCycles, frameCycles } = x);
        sel.value = String(choice);
        schedule();
      },
    });
    /** The hop's table through the cfg port, then its frame through the fast path, then the bytes held against the model's. */
    const runHop = (): boolean => {
      if (hop >= j.hops.length) return false;
      const x = j.hops[hop];
      writes = loadWrites(net.tableOf(x.router)); wi = 0; loadCycles = 0; frameCycles = 0; frame = x.frameIn; i = 0; out = []; lastCause = -1;
      drive();
      let guard = 8000;
      while (guard-- > 0) {
        stage.runCycles(1);
        if (wi >= writes.length && i >= frame.length && m.s === S_RX && m.i === 0) break;
      }
      const want = x.result.kind === 'forward' ? x.result.frame : x.result.kind === 'expired' ? x.frameIn : null;
      if (want && (want.length !== out.length || want.some((b, k) => b !== out[k]))) same = false;
      hop++; doneHops++;
      return true;
    };
    const act = (f: () => void) => { stage.checkpoint(); f(); stage.refresh(); schedule(); };
    const stopAll = () => { if (timer) { clearTimeout(timer); timer = 0; } };
    const all = () => { if (timer) return; stage.checkpoint(); const go = () => { timer = 0; if (runHop()) { stage.refresh(); schedule(); timer = window.setTimeout(go, 0); } else { stage.refresh(); schedule(); } }; go(); };
    const choose = (n: number) => { stopAll(); stage.checkpoint(); choice = n; sel.value = String(n); j = net.send(LAPTOP, PATH_FRAMES[n].frame()); hop = 0; doneHops = 0; same = true; writes = []; wi = 0; frame = []; i = 0; out = []; lastCause = -1; drive(); stage.refresh(); schedule(); };

    const sel = pick('Frame to carry', PATH_FRAMES.map((f, n) => [String(n), f.name]), String(start), (v) => choose(+v));
    const list = h('div', { class: 'in-hops' }), status = h('div', { class: 'mc-status' }), lamp = h('div', { class: 'sr-lock' }), bytes = h('div');
    const row = (label: string, b: readonly number[], other: readonly number[] | null) => h('div', { class: 'rt-row' }, h('span', { class: 'rt-lab' }, label),
      h('div', { class: 'rt-bytes' }, ...b.slice(0, 38).map((v, k) => h('span', { class: other && other[k] !== undefined && other[k] !== v ? 'chg' : '', title: `byte ${k}` }, hex2(v)))));
    const update = () => {
      list.replaceChildren(...j.hops.map((x, k) => h('span', { class: `in-hop${k < hop ? ' done' : ''}${k === hop - 1 ? ' now' : ''}`, title: ASES[ROUTERS[x.router].as].name }, ROUTERS[x.router].name)));
      const cur = hop > 0 ? j.hops[hop - 1] : null;
      status.replaceChildren(
        h('span', null, 'router ', h('b', null, cur ? ROUTERS[cur.router].name : '—')),
        h('span', null, 'table writes ', h('b', null, String(loadCycles))),
        h('span', null, 'frame cycles ', h('b', null, String(frameCycles))),
        h('span', null, 'reads ', h('b', null, cur ? String(cur.result.reads) : '—')),
        h('span', null, 'all cycles ', h('b', null, n0(cycles))));
      bytes.replaceChildren(row('In', frame, null), row('Out', out, frame));
      const arrived = hop === j.hops.length;
      lamp.className = `sr-lock ${agree && same ? (hop ? 'ok' : '') : 'bad'}`;
      lamp.textContent = !agree ? `Gates and model differ: ${wrong}.` : !same ? 'The gates\' frame differs from the network model\'s.'
        : !hop ? 'Each hop: the router\'s table goes in through the cfg port, then the frame through the gates. The output is the next hop\'s input.'
        : arrived ? (j.end.kind === 'host' ? `At ${HOSTS[j.end.host].name}. ${doneHops} routers on gates, every byte equal to the network model's, every output every clock equal to the fast path's model.` : `${CAUSE_NAMES[lastCause] ?? 'stopped'} at ${ROUTERS[j.hops[hop - 1].router].name}: the frame goes up to the slow path unchanged, and an ICMP error starts back.`)
        : `${CAUSE_NAMES[lastCause === C_FORWARD ? 0 : lastCause] ?? ''} by ${ROUTERS[j.hops[hop - 1].router].name}; the Out row is the next router's In.`;
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); };
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel rt-panel', 'data-dock': 'right', 'data-phone': 'flow' },
      h('h4', null, 'One frame, router by router', h('span', { class: 'fold-hint' })),
      h('div', { class: 'mc-row' }, sel), list,
      h('div', { class: 'dram-ops' },
        btn('Next router', 'Load its table, then send the frame through', () => act(() => { runHop(); }), 'btn sm primary'),
        btn('All the way', 'Every router on the path, one after another', all)),
      lamp, status, bytes,
      h('p', { class: 'sub' }, 'One engine, its memories rewritten at each hop: the whole path shares these gates, so what you open is the router the frame is in.'));
    update();
    pathApi.set(stage, {
      status: () => ({ hops: hop, total: j.hops.length, same, agree, arrived: hop === j.hops.length, cycles, lastCause }),
      next: () => act(() => { runHop(); }),
      all: () => act(() => { while (runHop()); }),
      choose,
    });
    return { el, update, destroy: () => { stopAll(); stage.edgeHooks.delete(hook); pathApi.delete(stage); if (raf) cancelAnimationFrame(raf); } };
  };
}

// ---- one packet, all the way -----------------------------------------------------------------------------------------------------------

export const ACCESS_LINK = 0;
/** The default on the sliders, which the chapter quotes. */
export const PACKET0 = 1500, LOAD0 = 50;

export function onePacketWidget(): Widget {
  const net = new Internet();
  let bytes = PACKET0, load = LOAD0 / 100;
  const body = h('tbody'), read = h('div', { class: 'err-verdict ok' });
  const dst = hostIp(WWW);
  const paint = () => {
    const f = hostFrame(LAPTOP, dst, 64, PROTO_UDP, new Array<number>(bytes - 20).fill(0)), j = net.send(LAPTOP, f), n = f.length;
    const loadOf = (i: number, l: typeof LINKS[number]) => (i === ACCESS_LINK ? load : l.load);
    const d = journeyDelays(j, n, loadOf), rows = traceroute(net, LAPTOP, dst);
    let t = propMs(LAN) + serMs(LAN, n), sumP = propMs(LAN), sumS = serMs(LAN, n), sumQ = 0, sumE = 0;
    body.replaceChildren(...d.map((x, k) => {
      const l = x.link!, back = rows[k + 1]?.back ?? rows[rows.length - 1].back, backLen = back.end.kind === 'host' ? back.end.frame.length : 60;
      t += x.total; sumP += x.prop; sumS += x.ser; sumQ += x.queue; sumE += x.engine;
      const rtt = t + oneWayMs(back, backLen, loadOf), nextName = k + 1 < d.length ? ROUTERS[d[k + 1].router].name : HOSTS[WWW].name;
      return h('tr', null, h('td', null, String(k + 2)), h('td', null, h('code', null, `${ROUTERS[x.router].name} → ${nextName}`)), h('td', { class: 'in-link' }, `${l.note}, ${l.km < 1 ? l.km : n0(l.km)} km, ${l.mbps >= 1000 ? `${l.mbps / 1000} Gb/s` : `${l.mbps} Mb/s`}`),
        h('td', { class: 'r' }, ms2(x.prop)), h('td', { class: 'r' }, ms2(x.ser)), h('td', { class: 'r' }, ms2(x.queue)), h('td', { class: 'r' }, ms2(x.engine)), h('td', { class: 'r' }, ms2(rtt)));
    }));
    read.textContent = `One way, ${ms2(t)} ms: light ${ms2(sumP)}, bits ${ms2(sumS)}, queues ${ms2(sumQ)}, ${d.length} engines ${ms2(sumE)}. The access line's queue alone: ${ms2(queueMs(LINKS[ACCESS_LINK], load))} ms at ${Math.round(load * 100)} % load.`;
  };
  const sb = slider('IP packet', 64, 1500, 4, bytes, (v) => `${v} bytes`, (v) => { bytes = v; paint(); });
  const sl = slider('Access line load', 0, 95, 1, LOAD0, (v) => `${v} %`, (v) => { load = v / 100; paint(); });
  paint();
  return {
    el: h('div', { class: 'widget rt-w' }, sb.el, sl.el,
      h('div', { class: 'in-scroll' }, h('table', { class: 'in-table' },
        h('thead', null, h('tr', null, h('th', null, 'TTL'), h('th', null, 'Hop'), h('th', { class: 'in-link' }, 'Link'), h('th', { class: 'r' }, 'Light, ms'), h('th', { class: 'r' }, 'Bits'), h('th', { class: 'r' }, 'Queue'), h('th', { class: 'r' }, 'Engine'), h('th', { class: 'r' }, 'Round trip so far'))), body)),
      read,
      h('p', { class: 'sub' }, 'TTL: the first that gets an answer from past this link. Round trip: there at this size, back as a small ICMP reply. Queue: M/M/1, the traffic an assumption; the lengths and rates are invented, of the usual size.')),
  };
}

// ---- a whole page ----------------------------------------------------------------------------------------------------------------------

export function fetchWidget(): Widget {
  const net = new Internet();
  let kb = 100, dnsCached = false, near = false, tls = true;
  const bar = h('div', { class: 'in-bar', role: 'img' }), rows = h('div', { class: 'rt-table' }), read = h('div', { class: 'err-verdict ok' });
  const paint = () => {
    const server = near ? hostId('cache') : WWW, ip = hostIp(server);
    const res = new Resolver(net);
    if (dnsCached) res.resolve(LAPTOP, SITE, 0);
    const dnsMs = res.resolve(LAPTOP, SITE, 1).ms;
    const f = probeFrame(LAPTOP, ip, 64), go = net.send(LAPTOP, f), back = net.send(server, hostFrame(server, hostIp(LAPTOP), 64, PROTO_UDP, new Array<number>(26).fill(0)));
    const rttMs = oneWayMs(go, f.length) + oneWayMs(back, f.length);
    const narrow = Math.min(...linksOf(go).map((i) => LINKS[i].mbps * (1 - LINKS[i].load)));
    const spec = { dnsMs, rttMs, pageBytes: kb * 1000, bottleneckMbps: narrow, tls };
    const ph = fetchPhases(spec), total = fetchMs(spec);
    bar.setAttribute('aria-label', `The page takes ${ms2(total)} ms`);
    bar.replaceChildren(...ph.map((p, i) => h('span', { class: `in-seg in-seg${i}`, style: `flex-grow:${p.ms}`, title: `${p.name}: ${ms2(p.ms)} ms` })));
    rows.replaceChildren(...ph.map((p, i) => h('div', { class: 'rt-route' }, h('i', { class: `in-dot in-seg${i}` }), h('code', null, p.name), h('span', null, p.what), h('em', null, `${ms2(p.ms)} ms`))));
    const waiting = ph.filter((p) => !p.name.startsWith('Response')).reduce((a, p) => a + p.ms, 0);
    read.textContent = `${ms2(total)} ms for ${kb} kB: round trip ${ms2(rttMs)} ms, narrowest link ${n0(narrow)} Mb/s free. ${Math.round((waiting / total) * 100)} % of the time passes before the first byte of the page. A link ten times faster would change only the serialization part of the last line.${near ? ' The name is looked up as before: a real content network usually answers that from nearby too, which this model leaves out.' : ''}`;
  };
  const sk = slider('Page', 1, 2000, 1, kb, (v) => `${v} kB`, (v) => { kb = v; paint(); });
  paint();
  return {
    el: h('div', { class: 'widget rt-w' }, sk.el,
      h('div', { class: 'ln-presets' }, check('Name already in the resolver\'s cache', dnsCached, (v) => { dnsCached = v; paint(); }), check('A copy of the site at the access provider', near, (v) => { near = v; paint(); }), check('TLS', tls, (v) => { tls = v; paint(); })),
      bar, rows, read,
      h('p', { class: 'sub' }, 'No loss, one connection, one object. A real page is many objects, and ', h('a', { href: '#/c/tcp' }, `chapter ${numOf('tcp')}`), ' is what happens when a segment is lost.')),
  };
}

const STACKS: [StackName, string, string][] = [
  ['h1', 'HTTP/1.1', 'TCP + TLS, one object at a time'],
  ['h2', 'HTTP/2', 'TCP + TLS, every object on one connection'],
  ['h3', 'HTTP/3', 'QUIC over UDP, every object on one connection'],
];
/** The same page and the same network through three stacks, the handshakes included. */
export function stacksWidget(): Widget {
  const net = new Internet(), f = probeFrame(LAPTOP, hostIp(WWW), 64), go = net.send(LAPTOP, f);
  const back = net.send(WWW, hostFrame(WWW, hostIp(LAPTOP), 64, PROTO_UDP, new Array<number>(26).fill(0)));
  const rttMs = oneWayMs(go, f.length) + oneWayMs(back, f.length), bottleneckMbps = Math.min(...linksOf(go).map((i) => LINKS[i].mbps * (1 - LINKS[i].load)));
  let objects = 8, kb = 30, loss = false;
  const rows = h('div', { class: 'rt-table' }), read = h('div', { class: 'err-verdict ok' });
  const paint = () => {
    const spec = { objects, objectBytes: kb * 1000, rttMs, bottleneckMbps, loss };
    const runs = STACKS.map(([k]) => pageOver(k, spec)), max = Math.max(...runs.map((r) => r.totalMs));
    rows.replaceChildren(...STACKS.map(([, name, how], i) => {
      const r = runs[i], late = loss ? ` ${r.stalled} of ${objects} held up.` : '';
      return h('div', { class: 'in-stack' },
        h('div', { class: 'rt-route' }, h('code', null, name), h('span', null, how), h('em', null, `${ms2(r.totalMs)} ms`)),
        h('div', { class: 'in-bar', role: 'img', style: `width:${(r.totalMs / max) * 100}%`, 'aria-label': `${name}: first request after ${ms2(r.setupMs)} ms, first byte at ${ms2(r.firstByteMs)} ms, all of it at ${ms2(r.totalMs)} ms.${late}` },
          h('span', { class: 'in-seg in-seg0', style: `flex-grow:${r.setupMs}`, title: `Handshakes: ${ms2(r.setupMs)} ms` }),
          h('span', { class: 'in-seg in-seg1', style: `flex-grow:${r.firstByteMs - r.setupMs}`, title: `Request, to first byte: ${ms2(r.firstByteMs - r.setupMs)} ms` }),
          h('span', { class: 'in-seg in-seg2', style: `flex-grow:${r.totalMs - r.firstByteMs}`, title: `The objects, with any further requests: ${ms2(r.totalMs - r.firstByteMs)} ms` })));
    }));
    const [a, b, c] = runs;
    read.textContent = loss
      ? `One packet of the middle object lost. On HTTP/2, ${b.heldPackets} packets arrive and wait for it, from ${b.stalled} of ${objects} objects, because TCP hands over nothing past the gap. On HTTP/3 only that object is held up, with ${c.heldPackets} packets waiting. HTTP/1.1 holds up ${a.stalled}: that object and any requested after it. The last byte of an interleaved page may hardly move; the cost is what could have been shown in the meantime.`
      : `Round trip ${ms2(rttMs)} ms, narrowest link ${n0(bottleneckMbps)} Mb/s free. HTTP/2 saves ${ms2(a.totalMs - b.totalMs)} ms over HTTP/1.1 by not asking one object at a time, and QUIC ${ms2(b.totalMs - c.totalMs)} ms more: its round trip less before the first request.`;
  };
  const so = slider('Objects', 1, 40, 1, objects, (v) => String(v), (v) => { objects = v; paint(); });
  const sk = slider('Each', 1, 200, 1, kb, (v) => `${v} kB`, (v) => { kb = v; paint(); });
  paint();
  return {
    el: h('div', { class: 'widget rt-w' }, so.el, sk.el,
      h('div', { class: 'ln-presets' }, check('Lose one packet', loss, (v) => { loss = v; paint(); })),
      h('p', { class: 'sub in-keys' }, h('i', { class: 'in-dot in-seg0' }), 'Handshakes ', h('i', { class: 'in-dot in-seg1' }), 'Request, to first byte ', h('i', { class: 'in-dot in-seg2' }), 'The objects, with any further requests'),
      rows, read,
      h('p', { class: 'sub' }, 'From the first packet of the connection, the name already known. A model, with the same packets for all three: not a measurement of any browser.')),
  };
}
