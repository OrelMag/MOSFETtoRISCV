// The communication parts' palette group and property sections (commparts.ts): the line (its delay, its live levels, what
// it stands for) and the UART core / slave (divisor and bit time, the status flags, the pins, read live from the simulation).
// More parts (the NIC, the switch) are added to COMM_PARTS; nothing here changes for them but a section if they have one.

import { MAX_LINE_DELAY } from '../lib/uart';
import { PORTS, type SwitchOpts } from '../comm/ethswitch';
import type { HierNode } from '../sim/flatten';
import { formatBits, pack } from '../sim/values';
import { h } from '../ui/dom';
import { bitCycles, bitNamed, bitsNamed, COMM_PARTS, commPartOf, headSteps, lineDelayOf, lineRef, lineStateOf, nicFlags, nicView, switchOptsOfRef, switchRef, switchTable, TABLE_LIVE, uartFlags } from './commparts';
import type { EdgeHook } from './runtime';
import type { Editor } from './editor';
import type { PartDoc, PartRef } from './model';
import { setRef } from './ops';
import { registerPaletteGroup } from './palette';
import { registerPropsSection } from './props';

registerPaletteGroup({
  id: 'comm', title: 'Communication', order: 57, collapsed: true,
  items: () => COMM_PARTS.map((c) => ({ id: c.id, name: c.name, tag: c.tag, title: c.title, place: { part: c.ref } })),
});

/** Run `f` once per frame while `el` is on the page (it starts detached: give it a moment). */
function live(el: HTMLElement, f: () => void): void {
  let seen = false, waited = 0;
  const tick = () => {
    if (el.isConnected) {
      seen = true;
      f();
    } else if (seen || ++waited > 120) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const row = (label: string, ctl: Node, hint?: string) => h('label', { class: 'sb-row', title: hint ?? null }, h('span', null, label), ctl);
const set = (e: HTMLElement, t: string) => { if (e.textContent !== t) e.textContent = t; };

function selectedPart(ed: Editor): PartDoc | null {
  if (ed.selCount !== 1 || !ed.sel.parts?.length) return null;
  return ed.doc.parts.find((p) => p.id === ed.sel.parts![0]) ?? null;
}

function setPartRef(ed: Editor, id: string, ref: PartRef): void {
  const r = setRef(ed.doc, id, ref, ed.defOf);
  if (r.reason) return void ed.toast(r.reason, 'err');
  ed.edit(() => r.doc);
}

const nodeOf = (ed: Editor, id: string): HierNode | null => ed.sim.sim?.design.root.children?.get(id) ?? null;

/** The UART core at or below a node (the slave holds it one level down). */
function coreIn(n: HierNode, depth = 0): HierNode | null {
  if (n.def.id === 'uart_full') return n;
  if (depth > 3) return null;
  for (const c of n.children?.values() ?? []) {
    const r = coreIn(c, depth + 1);
    if (r) return r;
  }
  return null;
}

registerPropsSection({
  id: 'comm', order: 22,
  render(ed) {
    const p = selectedPart(ed);
    if (!p) return null;
    const part = commPartOf(p.ref);
    if (!part) return null;
    switch (part.id) {
      case 'line': return lineProps(ed, p);
      case 'uart': case 'uart_bus': return uartProps(ed, p, part.id === 'uart');
      case 'nic': return nicProps(ed, p);
      case 'switch': return switchProps(ed, p);
      case 'spi': return spiProps(ed, p);
      case 'mac_rx': case 'mac_tx': return macProps(part.id === 'mac_rx');
      default: return null;
    }
  },
});

function lineProps(ed: Editor, p: PartDoc): HTMLElement {
  const delay = lineDelayOf(p.ref)!;
  const input = h('input', { type: 'number', value: String(delay), min: '1', max: String(MAX_LINE_DELAY), step: '1', 'aria-label': 'Line delay in clock cycles' }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isInteger(v) && v >= 1 && v <= MAX_LINE_DELAY) setPartRef(ed, p.id, lineRef(v));
    else input.value = String(delay);
  });
  const d = h('code'), noise = h('code'), q = h('code'), inflight = h('code');
  const out = h('section', { class: 'sb-sec-props sb-io-props' }, h('h3', null, 'Line'),
    row('Delay', input, `1–${MAX_LINE_DELAY} cycles of the sender's clock (wire clk to the sender's clock)`),
    row('d (sent)', d), row('noise', noise, 'Held at 1 over a clock edge it flips the level that edge samples'), row('q (arrives)', q),
    row('In flight', inflight, 'The levels sampled at the last edges, oldest first (q shows the first next)'),
    h('p', { class: 'sb-sum' }, 'q is d as it was delay − 1 sender edges ago; idle is 1 (a pulled-up line), and a reset puts idle back on the whole wire.'),
    h('p', { class: 'sb-sum' }, 'This box is a model, not a circuit: a transmission line is chapter 41\'s physics (double-click for its panel), not transistors. It costs nothing. Verilog leaves a comment; the FPGA export turns d into an output and q into an input of the top module, to be joined with a wire on the board. The delay and the noise input belong to the model and are not exported.'));
  live(out, () => {
    const node = nodeOf(ed, p.id), sim = ed.sim.sim;
    if (!node || !sim) { for (const e of [d, noise, q, inflight]) set(e, '–'); return; }
    set(d, formatBits(sim.getBits(node.ports.d), ed.view.radix));
    set(noise, formatBits(sim.getBits(node.ports.noise), ed.view.radix));
    set(q, formatBits(sim.getBits(node.ports.q), ed.view.radix));
    const st = node.leafIndex !== undefined ? lineStateOf(sim.leafState(node.leafIndex)) : null;
    set(inflight, st ? st.buf.join(' ') : '–');
  });
  return out;
}

function uartProps(ed: Editor, p: PartDoc, isCore: boolean): HTMLElement {
  const flags = h('div', { class: 'sb-btns' });
  const div = h('code'), bit = h('code'), tx = h('code'), rx = h('code'), irq = h('code'), ie = h('code');
  const out = h('section', { class: 'sb-sec-props sb-io-props' }, h('h3', null, isCore ? 'UART core' : 'UART slave'),
    row('Divisor', div, 'The register at +8 (core: wval with divWe). A baud tick every divisor clock cycles; a bit is 16 ticks'),
    row('A bit lasts', bit, 'Clock cycles per bit = 16 · max(1, divisor); a frame (start, 8 data, stop) is ten bits'),
    row('Interrupt enables', ie, 'bit 0 receive FIFO not empty, bit 1 transmit FIFO empty'),
    row('tx', tx, 'The line this UART drives (idle 1)'), row('rx', rx, 'The line it listens to, through a 2-flop synchronizer'), row('irq', irq),
    h('p', { class: 'sb-sum' }, 'Status flags (live):'), flags,
    h('p', { class: 'sb-sum' }, isCore
      ? 'Reset is all zeros: the divisor starts at 0, a tick every cycle until it is written. A framing error or an overrun stays set until a write of 1 to its bit (clrWe).'
      : 'Registers: +0 data (store: send; load: the oldest received byte), +4 status (write 1 to bit 3 or 4 to clear it), +8 divisor, +12 interrupt enables. Open it to see the core: its FIFOs, the baud generator, the transmitter and the receiver, down to NAND gates.'));
  live(out, () => {
    const node = nodeOf(ed, p.id), sim = ed.sim.sim, core = node ? coreIn(node) : null;
    if (!node || !sim || !core) { for (const e of [div, bit, tx, rx, irq, ie]) set(e, '–'); flags.replaceChildren(); delete flags.dataset.st; return; }
    const dv = pack(sim.getBits(core.ports.div)), st = pack(sim.getBits(core.ports.status)), iev = pack(sim.getBits(core.ports.ie));
    set(div, dv < 0 ? 'X' : String(dv));
    set(bit, dv < 0 ? '–' : `${bitCycles(dv)} cycles${dv < 2 ? ' (divisor 0 or 1)' : ''}`);
    set(ie, iev < 0 ? 'X' : iev.toString(2).padStart(2, '0'));
    set(tx, formatBits(sim.getBits(core.ports.tx), ed.view.radix));
    set(rx, formatBits(sim.getBits(core.ports.rx), ed.view.radix));
    set(irq, formatBits(sim.getBits(core.ports.irq), ed.view.radix));
    const key = String(st);
    if (flags.dataset.st !== key) {
      flags.dataset.st = key;
      flags.replaceChildren(...(st < 0 ? [h('span', null, 'status unknown (X)')] : uartFlags(st).map((f) => h('span', { class: f.on ? 'btn sm on' : 'btn sm', 'aria-pressed': String(f.on), style: 'pointer-events:none' }, f.name))));
    }
  });
  return out;
}

// ---- the NIC -----------------------------------------------------------------------------------------------------------

/** The first node at or below `n` (a few levels) whose definition has this id: the bundled parts hold the real one a level down. */
function findDef(n: HierNode, id: string, depth = 0): HierNode | null {
  if (n.def.id === id) return n;
  if (depth > 2) return null;
  for (const c of n.children?.values() ?? []) { const r = findDef(c, id, depth + 1); if (r) return r; }
  return null;
}

/** Run `f` each frame while `el` is on the page, and `done` once when it has left it (or never arrived). */
function liveUntil(el: HTMLElement, f: () => void, done: () => void): void {
  let seen = false, waited = 0;
  const tick = () => {
    if (el.isConnected) { seen = true; f(); } else if (seen || ++waited > 120) return done();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const hex = (v: number, w: number) => (v < 0 ? 'X' : '0x' + v.toString(16).padStart(w, '0'));

function nicProps(ed: Editor, p: PartDoc): HTMLElement {
  const flags = h('div', { class: 'sb-btns' });
  const en = h('code'), mac = h('code'), rxb = h('code'), txb = h('code'), ie = h('code'), rxh = h('code'), txh = h('code'), txs = h('code'), rxs = h('code'), irq = h('code'), txd = h('code'), rxc = h('code'), txc = h('code');
  const out = h('section', { class: 'sb-sec-props sb-io-props' }, h('h3', null, 'NIC'),
    row('Enable', en, 'CTRL at +0: bit 0 enables the engines (clear: both held in reset), bit 1 promiscuous (accept every destination)'),
    row('MAC address', mac, 'MACL at +20 holds the first four bytes (least significant byte first), MACH at +24 the last two'),
    row('Receive ring', rxb, 'RXBASE at +12: eight descriptors of two words (buffer address, then OWN in bit 31 and the length), 64-byte aligned'),
    row('Transmit ring', txb, 'TXBASE at +16'),
    row('Receive head', rxh, 'The descriptor the NIC fills next (0–7); it moves when a good frame is committed'),
    row('Transmit head', txh, 'The descriptor the NIC sends next (0–7); it moves when the frame has left and the descriptor is handed back'),
    row('Receiving', rxs), row('Transmitter', txs, 'Which step of a send the engine is in'),
    row('Interrupt enables', ie, 'IE at +8: bit 0 frame received, bit 1 frame sent'), row('irq', irq),
    row('txd', txd, 'The serial pair: one bit every four clocks, with txen (carrier) beside it'),
    row('Frames in', rxc, 'Receive head steps since this panel opened (counted at every clock edge)'), row('Frames out', txc, 'Transmit head steps since this panel opened'),
    h('p', { class: 'sb-sum' }, 'STATUS at +4 (write 1 to clear a bit), live:'), flags,
    h('p', { class: 'sb-sum' }, 'A bus slave with eight registers at +0 … +28 (CTRL, STATUS, IE, RXBASE, TXBASE, MACL, MACH, KICK) and a bus master that walks two rings of descriptors in RAM: put its master link on a master port of the interconnect, beside the CPU\'s, and its slave link on a slave code. Open it for the receive and transmit engines and the two MACs, down to gates. The rings themselves are in the computer\'s RAM: open the RAM part.'));
  const es = ed.sim;
  let prevRx = -1, prevTx = -1, nrx = 0, ntx = 0;
  const nicOf = (): HierNode | null => { const n = es.sim?.design.root.children?.get(p.id); return n ? findDef(n, 'nic') : null; };
  const hook: EdgeHook = {
    after: () => {
      const sim = es.sim, nic = nicOf(), v = sim && nic ? nicView(sim, nic) : null;
      if (!v) return;
      nrx += headSteps(prevRx, v.rxHead); ntx += headSteps(prevTx, v.txHead);
      prevRx = v.rxHead; prevTx = v.txHead;
    },
  };
  es.edgeHooks.add(hook);
  liveUntil(out, () => {
    const nic = nicOf(), sim = es.sim, v = nic && sim ? nicView(sim, nic) : null;
    if (!nic || !sim || !v) { for (const e of [en, mac, rxb, txb, ie, rxh, txh, txs, rxs, irq, txd, rxc, txc]) set(e, '–'); flags.replaceChildren(); delete flags.dataset.st; return; }
    set(en, v.en < 0 ? 'X' : v.en === 1 ? (v.promisc === 1 ? 'on, promiscuous' : 'on') : 'off (held in reset)');
    set(mac, v.mac); set(rxb, hex(v.rxbase, 4)); set(txb, hex(v.txbase, 4));
    set(rxh, v.rxHead < 0 ? 'X' : String(v.rxHead)); set(txh, v.txHead < 0 ? 'X' : String(v.txHead));
    set(rxs, v.rxActive === 1 ? 'a frame is arriving' : 'idle'); set(txs, v.txStage ?? 'idle');
    set(ie, v.ie < 0 ? 'X' : v.ie.toString(2).padStart(2, '0'));
    set(irq, formatBits(sim.getBits(nic.ports.irq), ed.view.radix)); set(txd, formatBits(sim.getBits(nic.ports.txd), ed.view.radix));
    set(rxc, String(nrx)); set(txc, String(ntx));
    const key = String(v.status);
    if (flags.dataset.st !== key) {
      flags.dataset.st = key;
      flags.replaceChildren(...(v.status < 0 ? [h('span', null, 'status unknown (X)')] : nicFlags(v.status).map((f) => h('span', { class: f.on ? 'btn sm on' : 'btn sm', 'aria-pressed': String(f.on), style: 'pointer-events:none' }, f.name))));
    }
  }, () => es.edgeHooks.delete(hook));
  return out;
}

function macProps(isRx: boolean): HTMLElement {
  return h('section', { class: 'sb-sec-props sb-io-props' }, h('h3', null, isRx ? 'MAC receiver' : 'MAC transmitter'),
    h('p', { class: 'sb-sum' }, isRx
      ? 'Chapter 48\'s receiver: it hunts the preamble and SFD in the bit stream (rxd, with crs high while a frame is on the cable), delivers the frame as bytes without preamble and FCS, checks the FCS and the length, and filters by destination (addr, or promisc = 1). err on the last byte tells the consumer to discard the frame. A switch port takes these bytes: join data, valid, last and err to its rxData, rxValid, rxLast, rxErr of the same port, and tie ready to 1 (a wire cannot be stopped).'
      : 'Chapter 48\'s transmitter: it takes a frame\'s bytes from a stream (data, valid, last; it raises ready when it wants the next byte), sends the preamble and SFD, pads to 64 bytes, appends the FCS from a CRC-32 unit, then leaves the gap: one bit every four clocks on txd, with txen (carrier) beside it. Tie crs and col low for the full-duplex link a switch gives. A switch port feeds it: join txData, txValid, txLast to data, valid, last, and ready back to the switch\'s txReady.'));
}

// ---- the switch --------------------------------------------------------------------------------------------------------

function selectRow(label: string, hint: string, opts: [string, string][], cur: string, on: (v: string) => void): HTMLElement {
  const sel = h('select', { 'aria-label': label }, ...opts.map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;
  sel.value = cur;
  sel.addEventListener('change', () => on(sel.value));
  return row(label, sel, hint);
}

function switchProps(ed: Editor, p: PartDoc): HTMLElement {
  const o = switchOptsOfRef(p.ref)!;
  const change = (patch: Partial<SwitchOpts>) => setPartRef(ed, p.id, switchRef({ ...o, ...patch }));
  const totals = h('code'), tbl = h('table', { class: 'sb-mini' }), ports = h('table', { class: 'sb-mini' }), note = h('p', { class: 'sb-sum' });
  const out = h('section', { class: 'sb-sec-props sb-io-props' }, h('h3', null, 'Switch'),
    selectRow('Cell size', 'A frame is written into one cell of its input buffer: the longest frame it can carry. A cell of 2048 bytes holds any legal frame (1514) and makes the part large',
      [5, 6, 7, 8, 9, 10, 11].map((k) => [String(k), `${2 ** k} bytes`] as [string, string]), String(o.cellK), (v) => change({ cellK: +v })),
    selectRow('Cells a port', 'Frames an input can hold at once; a frame that finds none free is dropped (counted)', [2, 4, 8, 16].map((n) => [String(n), String(n)] as [string, string]), String(o.cells), (v) => change({ cells: +v })),
    selectRow('Forwarding', 'Store-and-forward queues a frame at its last byte (a bad FCS never leaves); cut-through starts the output as soon as the table has answered', [['s', 'store-and-forward'], ['c', 'cut-through']], o.cut ? 'c' : 's', (v) => change({ cut: v === 'c' })),
    selectRow('Queues', 'One FIFO per input (only the oldest frame competes for an output), or one queue per output (virtual output queues: no head-of-line blocking)', [['f', 'one FIFO'], ['v', 'per output']], o.voq ? 'v' : 'f', (v) => change({ voq: v === 'v' })),
    h('p', { class: 'sb-sum' }, 'Per port (live):'), ports,
    row('Table', totals, 'Learned: new sources stored; evicted: a live entry replaced by another address that hashes to the same slot; flooded: frames sent to every other port (miss or group address); filtered: frames whose destination is on the port they came from'),
    h('p', { class: 'sb-sum' }, `The learned table (${2 ** o.tableK} slots, an address hashed to one; an entry stays live ${TABLE_LIVE} ticks of ${2 ** o.tickLog2} clocks and is refreshed whenever the address is seen as a source):`), tbl, note,
    h('p', { class: 'sb-sum' }, 'Each port is a byte stream in and out, not a cable: join a MAC RX (its data, valid, last, err to rxData, rxValid, rxLast, rxErr) and a MAC TX (txData, txValid, txLast to its data, valid, last, and its ready back to txReady) to every port you use; tie an unused port\'s rxValid, rxLast, rxErr low and its txReady high. Open the switch for the input buffers, the table port and table, the crossbar and the output arbiters, down to gates.'));
  let lastTbl: string | null = null, lastPorts = '';
  liveUntil(out, () => {
    const node = nodeOf(ed, p.id), sim = ed.sim.sim;
    if (!node || !sim || !node.def.id.startsWith('ethswitch_')) { set(totals, '–'); return; }
    const num = (n: string) => { const v = pack(sim.getBits(node.ports[n])); return v < 0 ? 'X' : String(v); };
    set(totals, `${num('learned')} learned · ${num('evicted')} evicted · ${num('flooded')} flooded · ${num('filtered')} filtered`);
    const pk = Array.from({ length: PORTS }, (_, i) => [num(`frames${i}`), num(`drops${i}`), num(`bad${i}`)]);
    const pkey = pk.flat().join(',');
    if (pkey !== lastPorts) {
      lastPorts = pkey;
      ports.replaceChildren(h('tr', null, ...['Port', 'sent', 'dropped (no cell)', 'bad (FCS)'].map((t) => h('th', null, t))), ...pk.map((r, i) => h('tr', null, h('td', null, String(i)), ...r.map((x) => h('td', null, x)))));
    }
    const rows = switchTable(sim, node);
    const key = rows ? rows.map((r) => `${r.slot}${r.mac}${r.port}${r.live ? 1 : 0}${Math.floor(r.age / 4)}`).join('|') : 'x';
    if (key !== lastTbl) {
      lastTbl = key;
      tbl.replaceChildren(...(rows && rows.length
        ? [h('tr', null, ...['MAC address', 'port', 'age', 'slot'].map((t) => h('th', null, t))), ...rows.map((r) => h('tr', { class: r.live ? '' : 'stale' }, h('td', null, h('code', null, r.mac)), h('td', null, String(r.port)), h('td', null, r.age < 0 ? '–' : `${r.age}${r.live ? '' : ' (stale)'}`), h('td', null, String(r.slot))))]
        : []));
      set(note, rows ? (rows.length ? '' : 'Empty: nothing has been learned since power-on.') : 'The table is not readable here (the switch was not built as a gate-level design).');
    }
  }, () => undefined);
  return out;
}

// ---- the SPI controller ------------------------------------------------------------------------------------------------

function spiProps(ed: Editor, p: PartDoc): HTMLElement {
  const mode = h('code'), hold = h('code'), ie = h('code'), busy = h('code'), done = h('code'), rx = h('code'), pins = h('code');
  const out = h('section', { class: 'sb-sec-props sb-io-props' }, h('h3', null, 'SPI controller'),
    row('Mode', mode, 'CTRL bits 0 (CPOL: SCLK idles high) and 1 (CPHA: data changes on the leading edge). Chapter 44\'s memory is a mode 0 part'),
    row('Hold CS', hold, 'CTRL bit 2: CS stays low between bytes, for a transaction of several. Drop it while the last byte is under way'),
    row('Interrupt enable', ie, 'CTRL bit 3: irq follows the done flag'),
    row('Busy', busy, 'STATUS bit 0: a byte is being shifted'), row('Done', done, 'STATUS bit 1: the last byte has ended; the next store to DATA, or a write of 1 to this bit, clears it'),
    row('Last byte in', rx, 'DATA at +0 on a load: what MISO delivered while the last byte went out'),
    row('sclk mosi cs_n', pins),
    h('p', { class: 'sb-sum' }, 'Registers: +0 DATA (store: send a byte, ignored while busy; load: the byte received), +4 STATUS, +8 CTRL. One SCLK edge every two clocks. Open it for the master of chapter 44: prescaler, edge counter and one shift register both ways, down to gates.'));
  live(out, () => {
    const node = nodeOf(ed, p.id), sim = ed.sim.sim, core = node ? findDef(node, 'axi_spi') : null, regs = core?.children?.get('regs');
    if (!core || !sim || !regs?.nets) { for (const e of [mode, hold, ie, busy, done, rx, pins]) set(e, '–'); return; }
    const b = (n: string) => bitNamed(sim, regs, n);
    const cpol = b('ctl0'), cpha = b('ctl1'), m = core.children?.get('spi');
    set(mode, cpol < 0 || cpha < 0 ? 'X' : `${2 * cpol + cpha} (CPOL ${cpol}, CPHA ${cpha})`);
    set(hold, b('ctl2') < 0 ? 'X' : b('ctl2') ? 'yes' : 'no'); set(ie, b('ctl3') < 0 ? 'X' : b('ctl3') ? 'on' : 'off');
    set(busy, m ? (bitNamed(sim, m, 'busy') ? 'yes' : 'no') : '–'); set(done, b('done_q') < 0 ? 'X' : b('done_q') ? 'yes' : 'no');
    set(rx, m ? hex(bitsNamed(sim, m, 'sh', 8), 2) : '–');
    set(pins, ['sclk', 'mosi', 'cs_n'].map((n) => formatBits(sim.getBits(core.ports[n]), ed.view.radix)).join('  '));
  });
  return out;
}
