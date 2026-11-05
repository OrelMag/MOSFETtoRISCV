// The communication capstones that are not circuits (learn/capstones.ts): Find the fault (cap_fault: the bench's view with nothing said until
// the attempt ends, comm/faults.ts) and A link that closes (cap_link: choices measured on the chapters' models, comm/linkdesign.ts). A pass
// is recorded under the capstone's id in the campaign progress, as a tier capstone's is.

import { attemptCases, ATTEMPT_CASES, FAULT_CASES, PASS_MARK, type FaultCase } from '../../comm/faults';
import { CARRIER_BITS, CARRIER_BRIEF, CARRIER_REFERENCE_RATE, carrierRate, CODES, EQUALIZERS, LINE_CODES, MODULATIONS, PASS_SHARE, runCarrier, runSerial, SERIAL_BRIEF, SERIAL_RATES, SERIAL_REFERENCE_RATE, type LinkResult } from '../../comm/linkdesign';
import { COMM_CAPSTONES } from '../../learn/capstones';
import { progress } from '../../campaign/progress';
import { h } from '../dom';
import { caseView } from '../../widgets/faultbench';
import { fmtRate } from '../../widgets/message';
import '../../styles/signals.css';

const ber = (b: number) => (b === 0 ? 'none counted' : b > 0.01 ? b.toFixed(2) : b.toExponential(1).replace('e-', ' × 10⁻').replace(/⁻(\d+)/, (_, e: string) => `⁻${[...e].map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(c)]).join('')}`));

interface Picked { c: FaultCase; pick: number | null }

export class CommCapstonePage {
  readonly kind = 'capstone';
  readonly el = h('div', { class: 'scroll' });
  private body = h('div', { class: 'cc-page' });
  private timer = 0;

  constructor(readonly nodeId: string) {
    const meta = COMM_CAPSTONES.find((c) => c.id === nodeId);
    this.el.append(this.body);
    this.body.append(h('p', { class: 'cc-crumb' }, h('a', { href: '#/path' }, 'My path'), ' › Communication capstone'), h('h1', null, meta?.title ?? 'Capstone'), h('p', null, meta?.brief ?? ''));
    const host = h('div');
    this.body.append(host);
    if (nodeId === 'cap_fault') this.fault(host);
    else this.link(host);
  }

  destroy(): void { clearTimeout(this.timer); }

  // ---- find the fault --------------------------------------------------------------------------------------------------------

  private fault(host: HTMLElement): void {
    const start = () => {
      const seed = Date.now() % 100000;
      const cases: Picked[] = attemptCases(seed).map(({ id, seed: s }) => ({ c: FAULT_CASES.find((x) => x.id === id)!.build(s), pick: null }));
      show(cases, 0, seed);
    };
    const show = (cases: Picked[], i: number, seed: number) => {
      const it = cases[i];
      const next = h('button', { type: 'button', class: 'btn primary' }, i + 1 < cases.length ? 'Next case' : 'Finish the attempt') as HTMLButtonElement;
      next.disabled = it.pick === null;
      next.addEventListener('click', () => { if (i + 1 < cases.length) show(cases, i + 1, seed); else finish(cases, seed); });
      const view = caseView(it.c, `${seed}:${i}`, { quiet: true, picked: it.pick, onPick: (_, k) => { it.pick = k; next.disabled = false; } });
      host.replaceChildren(h('p', { class: 'cc-count' }, `Case ${i + 1} of ${cases.length}`), view,
        h('div', { class: 'cc-nav' }, i > 0 ? h('button', { type: 'button', class: 'btn', onclick: () => show(cases, i - 1, seed) }, 'Back') : null, next));
      host.scrollIntoView?.({ block: 'start' });
    };
    const finish = (cases: Picked[], seed: number) => {
      const right = cases.filter((x) => x.pick === 0).length, passed = right >= PASS_MARK;
      if (passed) progress().solveCapstone('cap_fault', {}, () => [-right]);
      host.replaceChildren(
        h('h2', null, passed ? `Passed: ${right} of ${cases.length}` : `${right} of ${cases.length}: ${PASS_MARK} passes`),
        ...cases.map((x, i) => h('details', { class: 'cc-review', open: x.pick !== 0 },
          h('summary', null, `${x.pick === 0 ? '✓' : '✗'} Case ${i + 1}: ${x.c.options[0]}`),
          h('p', null, x.c.symptom), x.pick !== 0 && x.pick !== null ? h('p', null, h('b', null, `You chose: ${x.c.options[x.pick]}. `), x.c.against[x.pick - 1]) : null, h('p', null, x.c.why))),
        h('div', { class: 'cc-nav' }, h('button', { type: 'button', class: 'btn primary', onclick: start }, 'A new attempt, with new cases')));
      void seed;
    };
    host.append(h('p', null, `${ATTEMPT_CASES} cases, drawn at random, each a real fault in one of the book's models. Nothing is said about any answer until the end. ${PASS_MARK} right passes, and a new attempt draws new cases.`),
      h('button', { type: 'button', class: 'btn primary', onclick: start }, 'Start'));
  }

  // ---- a link that closes -----------------------------------------------------------------------------------------------------

  private link(host: HTMLElement): void {
    let carrier: LinkResult | null = null, serial: LinkResult | null = null;
    const mod = h('select', { 'aria-label': 'Modulation' }, ...MODULATIONS.map((m, i) => h('option', { value: String(i) }, m.name))) as HTMLSelectElement;
    const code = h('select', { 'aria-label': 'Code' }, ...CODES.map((c, i) => h('option', { value: String(i) }, c.name))) as HTMLSelectElement;
    const line = h('select', { 'aria-label': 'Line code' }, ...LINE_CODES.map((c, i) => h('option', { value: String(i) }, c))) as HTMLSelectElement;
    const eq = h('select', { 'aria-label': 'Equalizer' }, ...EQUALIZERS.map((c, i) => h('option', { value: String(i) }, c.name))) as HTMLSelectElement;
    const rate = h('select', { 'aria-label': 'Bit rate' }, ...SERIAL_RATES.map((r, i) => h('option', { value: String(i) }, `${r} Gb/s`))) as HTMLSelectElement;
    const cOut = h('div', { class: 'cc-out', 'aria-live': 'polite' }), sOut = h('div', { class: 'cc-out', 'aria-live': 'polite' }), verdict = h('div', { class: 'cc-verdict', 'aria-live': 'polite' });
    const say = (el: HTMLElement, r: LinkResult, ref: number, unit: (v: number) => string, target: number) => el.replaceChildren(
      h('span', null, 'Rate ', h('b', null, unit(r.rate))), h('span', null, 'Error rate ', h('b', null, ber(r.ber))), h('span', null, 'Target ', h('b', null, ber(target))),
      h('b', { class: r.closes ? 'good' : 'bad' }, r.closes ? (r.rate >= ref ? 'Closes, at the best rate there is' : `Closes, at ${Math.round((100 * r.rate) / ref)} % of the best`) : 'Does not close'));
    const judge = () => {
      const c = carrier?.closes && carrier.rate >= PASS_SHARE * CARRIER_REFERENCE_RATE, s = serial?.closes && serial.rate >= PASS_SHARE * SERIAL_REFERENCE_RATE;
      if (c && s) { progress().solveCapstone('cap_link', {}, () => [-(carrier!.rate / CARRIER_REFERENCE_RATE + serial!.rate / SERIAL_REFERENCE_RATE)]); verdict.textContent = 'Both links close, near enough to the best: passed.'; }
      else verdict.textContent = `To pass, both links must close at ${Math.round(PASS_SHARE * 100)} % of the best rate or more.`;
    };
    const measureC = h('button', { type: 'button', class: 'btn primary', onclick: () => {
      const c = { mod: Number(mod.value), code: Number(code.value) };
      cOut.textContent = `Sending ${CARRIER_BITS.toLocaleString('en')} bits through it…`;
      this.timer = window.setTimeout(() => { carrier = runCarrier(CARRIER_BRIEF, c, CARRIER_BITS); say(cOut, carrier, CARRIER_REFERENCE_RATE, fmtRate, CARRIER_BRIEF.target); judge(); }, 30);
    } }, 'Measure');
    const measureS = h('button', { type: 'button', class: 'btn primary', onclick: () => {
      serial = runSerial(SERIAL_BRIEF, { line: Number(line.value) as 0 | 1, eq: Number(eq.value), rate: Number(rate.value) });
      say(sOut, serial, SERIAL_REFERENCE_RATE, (v) => `${v} Gb/s`, SERIAL_BRIEF.target);
      judge();
    } }, 'Measure');
    const rateNow = h('span', { class: 'cc-hint' });
    const paintRate = () => { rateNow.textContent = `This choice would run at ${fmtRate(carrierRate(CARRIER_BRIEF, { mod: Number(mod.value), code: Number(code.value) }))}.`; };
    mod.addEventListener('change', paintRate); code.addEventListener('change', paintRate); paintRate();
    host.append(
      h('section', { class: 'cc-brief' }, h('h2', null, 'A carrier'), h('p', null, `${CARRIER_BRIEF.name}. At most ${ber(CARRIER_BRIEF.target)} of the data bits may be wrong, after decoding. Bits really go through the encoder, the constellation, the noise and the Viterbi decoder.`),
        h('div', { class: 'cc-row' }, mod, code, measureC), rateNow, cOut),
      h('section', { class: 'cc-brief' }, h('h2', null, 'A board trace'), h('p', null, `${SERIAL_BRIEF.name}. At most ${ber(SERIAL_BRIEF.target)} of the bits may be wrong. Read from the same eye and noise model as the chapter on fast serial links.`),
        h('div', { class: 'cc-row' }, line, eq, rate, measureS), sOut),
      verdict);
  }
}
