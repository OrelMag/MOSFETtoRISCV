// The USB half of the chapter "PCIe and USB": the packet explainer (fields, bits, stuffing, NRZI on the J / K line, the CRC computed
// live, a click flips a bit time of the line) and the gate-level scene: the host model enumerates the device of lib/usb.ts through the
// stage's own simulation while the model of comm/usb.ts steps beside it. Every number comes from comm/usb.ts and the netlist.

import {
  BIT_CLOCKS, CLOCK_NS, DEV_STATE, MAX_PACKET, PID, PID_NAME, REQ, UsbDevice, UsbHost, UsbMonitor, bytesBits, crc16, crc5Of, dataBytes, handshakeBytes, lsbBits, nrziSymbols,
  packetSymbols, parsePacket, resolveBus, setupData, stuffedBits, symbolClocks, tokenBytes, type LogEntry,
} from '../comm/usb';
import { usbCosts, usbDevice } from '../lib/usb';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { frameRun } from './slowctl';
import '../styles/usb.css';

const hx = (v: number, n = 2) => v.toString(16).padStart(n, '0').toUpperCase();
const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls, title, type: 'button' }, label); b.addEventListener('click', f); return b; };

/** The costs the prose quotes: NANDs of the whole device and of each block, from the netlist. */
export const usbBlockCosts = usbCosts;

// ---- the line as a strip -------------------------------------------------------------------------------------------------------

type Sym = 'J' | 'K' | '_';
const Y: Record<Sym, number> = { J: 6, K: 30, _: 18 };

/** J high, K low, SE0 between (dashed): one cell per symbol; `onClick(i)` makes the cell a button. */
export function lineStrip(syms: readonly string[], cw = 12, onClick?: (i: number) => void, flipped?: ReadonlySet<number>, aria = 'The line'): SVGSVGElement {
  const W = syms.length * cw + 4, svg = s('svg', { viewBox: `0 0 ${W} 38`, width: W, height: 38, class: 'usb-strip', role: 'group', 'aria-label': aria }) as SVGSVGElement;
  let d = '';
  syms.forEach((c, i) => {
    const y = Y[c as Sym] ?? 18, x = 2 + i * cw;
    d += i === 0 ? `M${x},${y}` : `L${x},${y}`;
    d += `L${x + cw},${y}`;
    if (c === '_') svg.append(s('line', { x1: x, x2: x + cw, y1: y, y2: y, class: 'usb-se0' }));
  });
  svg.append(s('path', { d, class: 'usb-tr' }));
  syms.forEach((c, i) => {
    const x = 2 + i * cw;
    if (i % 4 === 0) svg.append(s('line', { x1: x, x2: x, y1: 2, y2: 36, class: 'usb-grid' }));
    if (flipped?.has(i)) svg.append(s('rect', { x, y: 2, width: cw, height: 34, class: 'usb-flip' }));
    if (onClick && i < syms.length) {
      const g = s('g', { role: 'button', tabindex: 0, 'aria-label': `bit time ${i}, level ${c === 'J' ? 'J' : c === 'K' ? 'K' : 'SE0'}; flip it`, class: 'usb-hit' }, s('rect', { x, y: 0, width: cw, height: 38, fill: 'transparent' }));
      g.addEventListener('click', () => onClick(i));
      g.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') { e.preventDefault(); onClick(i); } });
      svg.append(g);
    }
  });
  return svg;
}

// ---- 1. a packet: fields, bits, stuffing, NRZI, CRC ---------------------------------------------------------------------------

interface Kind { id: string; name: string; build(a: PktInput): number[] }
interface PktInput { addr: number; ep: number; payload: number[] }
const KINDS: Kind[] = [
  { id: 'setup', name: 'SETUP token', build: (a) => tokenBytes(PID.SETUP, a.addr, a.ep) },
  { id: 'in', name: 'IN token', build: (a) => tokenBytes(PID.IN, a.addr, a.ep) },
  { id: 'data0', name: 'DATA0', build: (a) => dataBytes(PID.DATA0, a.payload) },
  { id: 'data1', name: 'DATA1', build: (a) => dataBytes(PID.DATA1, a.payload) },
  { id: 'ack', name: 'ACK', build: () => handshakeBytes(PID.ACK) },
];
const GET_DEVICE = setupData(0x80, REQ.GET_DESCRIPTOR, 0x0100, 0, 64);

interface Field { name: string; bits: number; cls: string }
/** The fields of a packet in transmission order (SYNC first), as widths in bits before stuffing. */
function fieldsOf(wire: number[]): Field[] {
  const f: Field[] = [{ name: 'SYNC', bits: 8, cls: 'sync' }, { name: 'PID', bits: 8, cls: 'pid' }];
  const p = wire[0] & 3;
  if (p === 1) f.push({ name: 'ADDR', bits: 7, cls: 'f1' }, { name: 'ENDP', bits: 4, cls: 'f2' }, { name: 'CRC5', bits: 5, cls: 'crc' });
  else if (p === 3) {
    for (let i = 1; i < wire.length - 2; i++) f.push({ name: `byte ${i - 1}`, bits: 8, cls: i % 2 ? 'f1' : 'f2' });
    f.push({ name: 'CRC16', bits: 16, cls: 'crc' });
  }
  return f;
}

export function usbPacketWidget(): Widget {
  let kind = 'data0', addr = 5, ep = 0, payloadText = hexText(GET_DEVICE);
  const flipped = new Set<number>();
  const out = h('div'), bitsBox = h('div'), strip = h('div', { class: 'usb-scroll' }), verdict = h('div', { class: 'usb-verdict' });
  const addrIn = h('input', { type: 'number', min: 0, max: 127, value: String(addr), class: 'sr-in usb-num', 'aria-label': 'Device address' }) as HTMLInputElement;
  const epIn = h('input', { type: 'number', min: 0, max: 15, value: String(ep), class: 'sr-in usb-num', 'aria-label': 'Endpoint' }) as HTMLInputElement;
  const payIn = h('input', { type: 'text', value: payloadText, class: 'sr-in', 'aria-label': 'Data bytes in hex', spellcheck: 'false' }) as HTMLInputElement;
  const row = (label: string, ...c: (HTMLElement | null)[]) => h('label', { class: 'mos-sl sr-field' }, h('span', null, label), ...c.filter((x): x is HTMLElement => !!x));
  const fAddr = row('Address', addrIn), fEp = row('Endpoint', epIn), fPay = row('Data (hex)', payIn);

  const paint = () => {
    const spec = KINDS.find((k) => k.id === kind)!;
    const payload = payloadText.split(/[\s,]+/).filter((t) => /^[0-9a-f]{1,2}$/i.test(t)).slice(0, 12).map((t) => parseInt(t, 16));
    const wire = spec.build({ addr: Math.min(127, Math.max(0, addr | 0)), ep: Math.min(15, Math.max(0, ep | 0)), payload });
    const isTok = (wire[0] & 3) === 1, isData = (wire[0] & 3) === 3;
    fAddr.hidden = fEp.hidden = !isTok; fPay.hidden = !isData;
    const bits = stuffedBits(wire), syms = [...nrziSymbols(bits), '_', '_', 'J'];
    const sent = [...syms].map((c, i) => (flipped.has(i) && i < bits.length ? (c === 'J' ? 'K' : 'J') : c));
    // the bits with their fields; a stuffed 0 is drawn between
    const fields = fieldsOf(wire);
    const chips: HTMLElement[] = [];
    let bi = 0, ones = 0, raw = 0;
    const rawBits = [...lsbBits(0x80, 8), ...bytesBits(wire)];
    const legend: HTMLElement[] = [];
    for (const f of fields) {
      const group: HTMLElement[] = [];
      for (let k = 0; k < f.bits; k++, raw++) {
        const b = rawBits[raw];
        const mk = (v: number, stuffed: boolean) => {
          const i = bi++;
          const c = h('button', { class: `usb-bit ${stuffed ? 'stuff' : f.cls}${flipped.has(i) ? ' flipped' : ''}`, type: 'button', title: stuffed ? 'stuffed 0: after six 1s the sender inserts a 0' : `${f.name}, bit ${k}`, 'aria-label': `${stuffed ? 'stuffed ' : ''}bit ${v} of ${f.name}; click to flip this bit time on the line` }, String(v));
          c.addEventListener('click', () => toggle(i));
          group.push(c);
        };
        mk(b, false);
        ones = b ? ones + 1 : 0;
        if (ones === 6) { mk(0, true); ones = 0; }
      }
      chips.push(h('span', { class: 'usb-field' }, h('span', { class: 'usb-fname' }, f.name), h('span', { class: 'usb-fbits' }, ...group)));
    }
    bitsBox.replaceChildren(...chips);
    void legend;
    // the line
    strip.replaceChildren(lineStrip(sent, 10, (i) => { if (i < bits.length) toggle(i); }, flipped, 'The packet on the line, J high, K low'));
    // what the receiver makes of it
    const mon = new UsbMonitor();
    for (const [dp, dm] of [...Array(9).fill([1, 0]), ...symbolClocks(sent.join('')), ...Array(9).fill([1, 0])] as [number, number][]) mon.push(dp, dm);
    const seen = mon.seen[0];
    const notes: HTMLElement[] = [];
    const line = (cls: string, text: string) => notes.push(h('div', { class: `usb-note ${cls}` }, text));
    const same = bits.length === 0 || !seen ? false : seen.wire.length === wire.length && seen.wire.every((v, i) => v === wire[i]);
    if (!seen) line('bad', 'The receiver never saw a SYNC: the line did not go from J to K at the start, so there is no packet.');
    else {
      const p = parsePacket(seen.wire);
      if (!seen.syncOk) line('bad', 'SYNC is not KJKJKJKK: the receiver cannot find the bit boundaries.');
      if (seen.stuffError) line('bad', 'Bit stuff error: a 1 came where a stuffed 0 belongs. Six 1s in a row mean the line was disturbed.');
      if (!seen.byteAligned) line('bad', 'The bits do not make a whole number of bytes.');
      if (!p.pidOk) line('bad', `PID check fails: the high nibble ${hx(seen.wire[0] >> 4, 1)} is not the complement of the low ${hx(seen.wire[0] & 15, 1)}.`);
      else line('ok', `PID ${PID_NAME[p.pid] ?? hx(p.pid, 1)}: the high nibble is the complement of the low one.`);
      if (p.kind === 'token' || p.kind === 'sof') {
        const v = (seen.wire[1] | (seen.wire[2] << 8)) & 0x7ff, got = (seen.wire[1] | (seen.wire[2] << 8)) >> 11, want = crc5Of(v);
        line(got === want ? 'ok' : 'bad', `CRC5 sent ${hx(got)}, computed over the 11 bits that arrived (address ${v & 0x7f}, endpoint ${v >> 7}) ${hx(want)}: ${got === want ? 'good' : 'the token is dropped'}.`);
      } else if (p.kind === 'data') {
        const n = seen.wire.length, got = seen.wire[n - 2] | (seen.wire[n - 1] << 8), want = crc16(seen.wire.slice(1, n - 2));
        line(got === want ? 'ok' : 'bad', `CRC16 sent ${hx(got, 4)}, computed over the ${n - 3} data byte${n === 4 ? '' : 's'} that arrived ${hx(want, 4)}: ${got === want ? 'good' : 'the packet is dropped, no handshake is sent'}.`);
      }
    }
    if (!flipped.size) line('', `${bits.length} bit times of ${BIT_CLOCKS} clocks, ${bits.length - rawBits.length} of them stuffed; then SE0 for two bit times and J.`);
    else if (same) line('ok', 'The flipped bit time left the packet as it was.');
    verdict.replaceChildren(...notes);
    out.replaceChildren(bitsBox, h('p', { class: 'sub' }, 'Click a bit (or the line below) to flip that bit time on the wire. NRZI makes a flip two decoded errors: the level it changes and the transition after it.'), strip, verdict);
  };
  const toggle = (i: number) => { if (flipped.has(i)) flipped.delete(i); else flipped.add(i); paint(); };
  const choose = (id: string) => { kind = id; flipped.clear(); paint(); };
  const kindBtns = KINDS.map((k) => btn(k.name, `Send a ${k.name}`, () => choose(k.id), 'btn sm'));
  addrIn.addEventListener('input', () => { addr = Number(addrIn.value); flipped.clear(); paint(); });
  epIn.addEventListener('input', () => { ep = Number(epIn.value); flipped.clear(); paint(); });
  payIn.addEventListener('input', () => { payloadText = payIn.value; flipped.clear(); paint(); });
  const el = h('div', { class: 'widget mos sr-w usb-w' },
    h('div', { class: 'ln-presets' }, ...kindBtns, btn('Unflip', 'Put every bit time back', () => { flipped.clear(); paint(); }, 'btn sm ghost')),
    h('div', { class: 'mos-row' }, fAddr, fEp, fPay), out);
  paint();
  return { el };
}
const hexText = (b: ArrayLike<number>) => Array.from(b, (x) => hx(x)).join(' ');

// ---- 2. the gate-level scene -----------------------------------------------------------------------------------------------------

export interface UsbStatus {
  state: number; stateName: string; addr: number; tog: number; armed: number; stall: number; rem: number;
  /** Clocks run since power-on. */
  clocks: number; transactions: number; done: boolean; failed: string | null; configured: boolean;
  /** Gates and model compared after every clock: clocks compared, and clocks that differed. */
  compared: number; mismatches: number;
  errors: number; naks: number; corrupted: number; corruptArmed: boolean; clashes: number;
  log: string[];
}
export interface UsbApi {
  status(): UsbStatus;
  step(): void;
  run(): void;
  replug(): void;
  corrupt(): void;
  busy(on: boolean): void;
  cycles(n: number): void;
}
export const usbApi = new WeakMap<Stage, UsbApi>();

const STRIP = 120;
type Ev = { clock: number; what: 'replug' | 'corrupt' | 'busy'; on?: boolean };

/** Host, model and line behind the stage's gates. All of it is deterministic from the events, so Back replays it. */
export class UsbRig {
  host = new UsbHost();
  model = new UsbDevice();
  clock = 0;
  events: Ev[] = [];
  compared = 0; mismatches = 0; clashes = 0;
  nak = 0;
  line: Sym[] = [];
  /** The inputs of the clock in flight. */
  private applied = { rst: 1, dp: 1, dm: 0, nak: 0 };
  private marker: LogEntry[] = [];
  reset(): void { Object.assign(this, { host: new UsbHost(), model: new UsbDevice(), clock: 0, events: [], compared: 0, mismatches: 0, clashes: 0, nak: 0, line: [] }); }
  event(e: Ev): void {
    this.events.push(e);
    if (e.what === 'replug') { const old = this.host; this.host = new UsbHost(); this.marker = old.log; this.host.log.push({ clock: this.clock, kind: 'info', text: 'replugged: the host starts over' }); }
    else if (e.what === 'corrupt') this.host.corruptNext = true;
    else this.nak = e.on ? 1 : 0;
  }
  before(st: Stage): void {
    const sim = st.sim!;
    const o = { oe: st.value('oe'), odp: st.value('odp'), odm: st.value('odm') };
    const bus = resolveBus(this.host.out, o);
    if (bus.clash) this.clashes++;
    this.applied = { rst: this.clock < 4 ? 1 : 0, dp: bus.dp, dm: bus.dm, nak: this.nak };
    for (const [k, v] of Object.entries(this.applied)) sim.setInput(k, v);
    sim.settle();
  }
  after(st: Stage | null): void {
    const a = this.applied;
    this.model.step(a);
    this.host.step({ dp: a.dp, dm: a.dm });
    this.line.push(a.dp && !a.dm ? 'J' : !a.dp && a.dm ? 'K' : '_');
    if (this.line.length > STRIP) this.line.shift();
    this.clock++;
    if (st) {
      this.compared++;
      const m = this.model;
      const want = [m.odp, m.odm, m.oe, m.st, m.addr, m.tog, m.armed, m.stall, m.rem];
      const got = ['odp', 'odm', 'oe', 'state', 'addr', 'tog', 'armed', 'stall', 'rem'].map((k) => st.value(k));
      if (got.some((v, i) => v !== want[i])) this.mismatches++;
    }
  }
  /** The state at clock `n` of the same history: events applied in order, model and host only (the stage restores the gates). */
  replayTo(n: number, events: Ev[]): void {
    this.reset();
    const todo = [...events];
    while (this.clock < n) {
      while (todo.length && todo[0].clock === this.clock) this.event(todo.shift()!);
      // the model alone: inputs from the host and the model's own outputs, as the gates would see them
      const bus = resolveBus(this.host.out, { oe: this.model.oe, odp: this.model.odp, odm: this.model.odm });
      this.applied = { rst: this.clock < 4 ? 1 : 0, dp: bus.dp, dm: bus.dm, nak: this.nak };
      this.after(null);
    }
    while (todo.length && todo[0].clock === this.clock) this.event(todo.shift()!);
  }
  save(): { clock: number; events: Ev[] } { return { clock: this.clock, events: this.events.map((e) => ({ ...e })) }; }
  logLines(): LogEntry[] { return this.marker.length ? [...this.marker.slice(-3), ...this.host.log] : this.host.log; }
}

export function usbScene(): Scene {
  return {
    root: usbDevice(),
    inputs: { dp: 1, dm: 0, nak: 0, rst: 1 },
    clock: 'clk', autoClock: false, hiddenInputs: ['dp', 'dm', 'nak', 'rst'],
    panels: [usbPanel()],
  };
}

export function usbPanel(): ScenePanel {
  return (stage: Stage): Widget => {
    const rig = new UsbRig();
    let stopRun: (() => void) | null = null, raf = 0;
    const hook = { before: () => rig.before(stage), after: () => { rig.after(stage); schedule(); } };
    stage.edgeHooks.add(hook);
    stage.resetHooks.add(() => { stopRun?.(); rig.reset(); schedule(); });
    stage.historyHooks.add({
      save: () => rig.save(),
      restore: (v) => { const x = v as ReturnType<UsbRig['save']>; stopRun?.(); rig.replayTo(x.clock, x.events); schedule(); },
    });

    const act = (f: () => void) => { stopRun?.(); stage.checkpoint(); f(); stage.refresh(); schedule(); };
    const stepTransaction = () => act(() => {
      const t0 = rig.host.transactions;
      stage.runCycles(40000, () => rig.host.transactions > t0 || rig.host.done);
    });
    const runBtn = btn('Run enumeration', 'Run the clock as fast as the page can draw until the host has finished', () => (stopRun ? stopRun() : start()), 'btn sm primary');
    runBtn.setAttribute('aria-pressed', 'false');
    const start = () => {
      stage.checkpoint();
      runBtn.textContent = 'Pause'; runBtn.setAttribute('aria-pressed', 'true');
      stopRun = frameRun(stage, () => rig.host.done, () => { stopRun = null; runBtn.textContent = 'Run enumeration'; runBtn.setAttribute('aria-pressed', 'false'); schedule(); });
    };
    const corrupt = btn('Corrupt next packet', 'Flip a bit in the next packet the host sends: its CRC (or PID check) fails and the device ignores it', () => act(() => rig.event({ clock: rig.clock, what: 'corrupt' })));
    let busyOn = false;
    const busy = h('label', { class: 'usb-chk' }, h('input', { type: 'checkbox' }) as HTMLInputElement, h('span', null, 'Device busy (NAK)'));
    (busy.firstChild as HTMLInputElement).addEventListener('change', () => act(() => { busyOn = (busy.firstChild as HTMLInputElement).checked; rig.event({ clock: rig.clock, what: 'busy', on: busyOn }); }));

    const stateBox = h('div', { class: 'usb-states', role: 'group', 'aria-label': 'Device state' }), facts = h('div', { class: 'mc-status' });
    const stripBox = h('div', { class: 'usb-scroll' }), logBox = h('ol', { class: 'usb-log' }), lock = h('div', { class: 'sr-lock' });
    const update = () => {
      const st = status();
      stateBox.replaceChildren(...DEV_STATE.map((n, i) => h('span', { class: `usb-state${i === st.state ? ' on' : ''}`, 'aria-current': i === st.state ? 'true' : null }, n)));
      facts.replaceChildren(
        h('span', null, 'address ', h('b', null, String(st.addr))), h('span', null, 'toggle ', h('b', null, `DATA${st.tog}`)),
        h('span', null, 'bytes left ', h('b', null, String(st.rem))), h('span', null, 'clocks ', h('b', null, String(st.clocks))),
        h('span', null, 'errors / NAKs ', h('b', null, `${st.errors} / ${st.naks}`)));
      const strip = [...Array(Math.max(0, STRIP - rig.line.length)).fill('J'), ...rig.line];
      stripBox.replaceChildren(lineStrip(strip, 6, undefined, undefined, `The last ${STRIP} clocks of the line`));
      stripBox.scrollLeft = stripBox.scrollWidth;
      logBox.replaceChildren(...rig.logLines().slice(-12).map((l) => h('li', { class: `usb-l ${l.kind}` }, l.text)));
      lock.className = `sr-lock ${st.mismatches ? 'bad' : st.compared ? 'ok' : ''}`;
      lock.textContent = st.mismatches ? `The gates differ from the model in ${st.mismatches} of ${st.compared} clocks.` : st.compared ? `Gates equal the model: all outputs compared after each of ${st.compared} clocks.` : 'Nothing compared yet.';
      corrupt.classList.toggle('on', rig.host.corruptNext);
      corrupt.textContent = rig.host.corruptNext ? 'Next packet is corrupt' : 'Corrupt next packet';
    };
    const status = (): UsbStatus => ({
      state: stage.value('state'), stateName: DEV_STATE[stage.value('state')] ?? '?', addr: stage.value('addr'), tog: stage.value('tog'), armed: stage.value('armed'), stall: stage.value('stall'), rem: stage.value('rem'),
      clocks: rig.clock, transactions: rig.host.transactions, done: rig.host.done, failed: rig.host.failed, configured: rig.host.configured,
      compared: rig.compared, mismatches: rig.mismatches, errors: rig.host.errors, naks: rig.host.naks, corrupted: rig.host.corrupted, corruptArmed: rig.host.corruptNext, clashes: rig.clashes,
      log: rig.logLines().map((l) => l.text),
    });
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); };
    const replug = () => act(() => rig.event({ clock: rig.clock, what: 'replug' }));
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel sr-panel usb-panel', 'data-dock': 'right', 'data-phone': 'flow' },
      h('h4', null, 'USB enumeration', h('span', { class: 'fold-hint' })),
      stateBox, facts,
      h('div', { class: 'dram-ops' }, btn('Step transaction', 'Run the clock until the host finishes one transaction', stepTransaction), runBtn, btn('Replug (bus reset)', 'The host starts over: SE0 for 48 bit times, then GET_DESCRIPTOR at address 0', replug), corrupt, busy),
      stripBox, h('div', { class: 'cpu-sec' }, 'Transactions'), logBox, lock,
      h('p', { class: 'sub' }, `${BIT_CLOCKS} clocks a bit at ${CLOCK_NS} ns is ${(1000 / (CLOCK_NS * BIT_CLOCKS)).toFixed(0)} Mb/s: the gates' speed. Real full speed is 12 Mb/s, and a full-speed device needs about ${MAX_PACKET}-byte packets on its control pipe.`));
    update();
    usbApi.set(stage, {
      status,
      step: stepTransaction,
      run: () => { if (!stopRun) start(); },
      replug,
      corrupt: () => act(() => rig.event({ clock: rig.clock, what: 'corrupt' })),
      busy: (on) => act(() => { (busy.firstChild as HTMLInputElement).checked = on; rig.event({ clock: rig.clock, what: 'busy', on }); }),
      cycles: (n) => act(() => { stage.runCycles(n); }),
    });
    return { el, update, destroy: () => { stopRun?.(); stage.edgeHooks.delete(hook); usbApi.delete(stage); if (raf) cancelAnimationFrame(raf); } };
  };
}
void packetSymbols;
