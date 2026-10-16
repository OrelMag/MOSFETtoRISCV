// Appendix B's Play step: Doom on the fast interpreter of our ISA (doom/player.ts), with what the
// machine is doing shown live (the running function, time per function, the instruction mix, the
// last instructions) and, paused, stepped instruction by instruction with Back. Nothing large is
// fetched until the learner starts: the program image (400 KB) on open, the WAD (Freedoom, 29 MB,
// or their own file) on Play.

import { ABI } from '../riscv/isa';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import type { DoomImage, DoomSymbol } from '../doom/image';
import type { DoomPlayer } from '../doom/player';

const W = 320, H = 200;
/** The system CPU's cycles per second on the gates in the page (cycle engine, docs/ROADMAP.md). */
const GATE_HZ = 2400;
const PANEL_MS = 250;
const FREEDOOM = 'doom/freedoom1.wad';

const fmt = (n: number) => Math.round(n).toLocaleString('en');
const hex = (n: number, d = 8) => (n >>> 0).toString(16).padStart(d, '0');
const dur = (s: number) => (s < 60 ? `${s.toFixed(0)} s` : s < 3600 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s` : `${(s / 3600).toFixed(1)} h`);

interface Loaded {
  image: DoomImage;
  syms: DoomSymbol[];
  mod: typeof import('../doom/player');
  keys: typeof import('../doom/keys');
}

async function loadProgram(): Promise<Loaded> {
  const [img, syms, mod, keys, imageMod] = await Promise.all([
    fetch('doom/doom.img').then((r) => { if (!r.ok) throw new Error(`doom.img: ${r.status}`); return r.arrayBuffer(); }),
    fetch('doom/doom.syms.json').then((r) => { if (!r.ok) throw new Error(`doom.syms.json: ${r.status}`); return r.json() as Promise<DoomSymbol[]>; }),
    import('../doom/player'), import('../doom/keys'), import('../doom/image'),
  ]);
  return { image: imageMod.parseImage(img), syms, mod, keys };
}

/** Fetch with a progress callback (bytes so far, total or 0). */
async function fetchBytes(url: string, progress: (got: number, total: number) => void): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`${url}: ${r.status}`);
  const total = Number(r.headers.get('content-length') ?? 0);
  const reader = r.body.getReader(), parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length; progress(got, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** A WAD's header: IWAD or PWAD. */
function wadProblem(b: Uint8Array): string | null {
  const id = String.fromCharCode(...b.subarray(0, 4));
  if (id !== 'IWAD') return id === 'PWAD' ? 'a PWAD is an add-on: it needs an IWAD (doom1.wad, doom.wad or freedoom1.wad) under it' : 'not a WAD file (it does not start with IWAD)';
  return null;
}

export function doomPlay(): Widget {
  const canvas = h('canvas', { width: W, height: H, class: 'doom-screen', tabindex: 0, 'aria-label': 'Doom: click here, then play with the keyboard' });
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(W, H);
  const status = h('div', { class: 'doom-status' }, 'Loading the program…');
  const startRow = h('div', { class: 'doom-row' });
  const playRow = h('div', { class: 'doom-row' });
  const stats = h('div', { class: 'doom-kv' });
  const side = h('div', { class: 'doom-side' });
  const keysHint = h('div', { class: 'doom-keys' });
  const el = h('div', { class: 'doom' },
    h('div', { class: 'doom-main' }, h('div', { class: 'doom-bezel' }, canvas), status, startRow, playRow, stats, keysHint),
    side);

  let loaded: Loaded | null = null;
  let player: DoomPlayer | null = null;
  let raf = 0, last = 0, lastPanel = 0, alive = true, shownFlips = -1;
  let frameCycles = 0, flipMt = 0;
  const held = new Set<string>();

  // ---- painting ----
  const paint = (live: boolean) => {
    if (!player) return;
    player.dev.rgba(img.data, live);
    g.putImageData(img, 0, 0);
  };

  // ---- the side panel: playing or paused ----
  const bars = (rows: { name: string; share: number }[]) => {
    const top = rows.slice(0, 7), max = top[0]?.share || 1;
    return h('div', { class: 'doom-prof' }, top.map((r) => [
      h('span', { class: 'k' }, r.name), h('span', { class: 't' }, h('i', { style: `width:${(100 * r.share) / max}%` })), h('span', { class: 'v' }, `${Math.round(100 * r.share)} %`),
    ]));
  };

  const renderSide = () => {
    if (!player || !loaded) return;
    const p = player, cpu = p.cpu, at = p.where();
    if (!p.paused) {
      const rec = p.recent().slice(-10);
      side.replaceChildren(
        h('h4', null, 'Running now'),
        h('div', { class: 'doom-now' }, h('b', { class: 'mono' }, at?.name ?? '?'), h('span', { class: 'mono muted' }, ` 0x${hex(cpu.pc)}`)),
        h('h4', null, 'Time per function, last second ', h('span', { class: 'muted' }, '(sampled)')),
        p.profile.length ? bars(p.profile) : h('p', { class: 'muted' }, 'Measuring…'),
        h('h4', null, 'Instruction mix, last second'),
        h('div', { class: 'doom-mix' }, loaded.mod.CLASSES.map((c, i) => h('span', null, `${c} `, h('b', null, `${Math.round(100 * (p.mix[i] ?? 0))} %`)))),
        h('h4', null, 'Last instructions'),
        h('div', { class: 'doom-trace mono' }, rec.map((pc) => { const l = p.listing(pc, 0, 0)[0]; return h('div', null, h('b', null, hex(pc, 5)), `  ${l?.[2] ?? ''}`); })),
      );
      return;
    }
    const rows = p.listing(cpu.pc, 5, 7);
    const regs = h('div', { class: 'doom-regs mono' }, ABI.map((n, i) => h('span', null, `${n} `, h('b', null, hex(cpu.x[i])))));
    const zoom = h('canvas', { width: 48, height: 30, class: 'doom-zoom', 'aria-label': 'The frame buffer around the last pixel stored, magnified' });
    side.replaceChildren(
      h('h4', null, `Paused · frame ${fmt(p.dev.flips)}, ${fmt(cpu.retired)} instructions since power-on`),
      h('div', { class: 'doom-listing mono' },
        h('div', { class: 'fn' }, at ? `${at.name} + 0x${at.offset.toString(16)}` : 'no symbol'),
        rows.map(([a, , text]) => {
          const fn = p.where(a);
          const head = fn && fn.offset === 0 && a !== rows[0][0] ? h('div', { class: 'fn' }, fn.name) : null;
          return [head, h('div', { class: a === cpu.pc ? 'pc' : null }, h('span', null, hex(a, 5)), h('span', null, text))];
        })),
      regs,
      h('div', { class: 'doom-pix' }, zoom, h('p', null, p.dev.lastPixel < 0 ? 'No pixel stored yet.' : `Last pixel stored: (${p.dev.lastPixel % W}, ${Math.floor(p.dev.lastPixel / W)}) = colour ${p.dev.fb[p.dev.lastPixel]}. Doom draws walls in columns, top to bottom, and floors in rows.`)),
    );
    if (p.dev.lastPixel >= 0) {
      const z = zoom.getContext('2d')!, x = p.dev.lastPixel % W, y = Math.floor(p.dev.lastPixel / W);
      z.imageSmoothingEnabled = false;
      z.drawImage(canvas, Math.max(0, Math.min(W - 48, x - 24)), Math.max(0, Math.min(H - 30, y - 15)), 48, 30, 0, 0, 48, 30);
      z.strokeStyle = '#ffd400'; z.lineWidth = 1;
      z.strokeRect(x - Math.max(0, Math.min(W - 48, x - 24)) + 0.5 - 1, y - Math.max(0, Math.min(H - 30, y - 15)) + 0.5 - 1, 2, 2);
    }
  };

  const renderStats = () => {
    if (!player) return;
    const p = player;
    const kv: [string, string][] = [
      ['Engine', p.paused ? 'interpreter · paused' : `interpreter · ${p.mips.toFixed(0)} MIPS`],
      ['Frame', fmt(p.dev.flips)],
      ['Cycles, last frame', frameCycles ? fmt(frameCycles) : '…'],
      ['Game speed', p.paused ? 'paused' : `${p.speed.toFixed(2)} × real time`],
      ['That frame on the gates', frameCycles ? `≈ ${dur(frameCycles / GATE_HZ)}` : '…'],
    ];
    stats.replaceChildren(...kv.flatMap(([k, v]) => [h('span', null, k), h('span', null, v)]));
  };

  const renderControls = () => {
    if (!player) return;
    const p = player;
    const btn = (label: string, run: () => void, primary = false, disabled = false) =>
      h('button', { type: 'button', class: primary ? 'btn primary' : 'btn', disabled, onclick: () => { run(); afterStep(); } }, label);
    playRow.replaceChildren(...(p.paused
      ? [btn('▶ Resume', () => { p.resume(); canvas.focus(); }, true), btn('◀ Back', () => p.back(), false, !p.canGoBack), btn('Step', () => p.step()),
        btn('Step 100', () => p.stepN(100)), btn('To next pixel', () => p.toNextPixel()), btn('To end of frame', () => p.toFrameEnd())]
      : [btn('❚❚ Pause', () => { releaseAll(); p.pause(); }, true), h('span', { class: 'muted' }, 'The game freezes at the exact instruction.')]));
  };

  const afterStep = () => {
    if (!player) return;
    paint(player.paused);
    renderControls(); renderStats(); renderSide();
  };

  // ---- the loop ----
  const loop = (now: number) => {
    if (!alive || !player) return;
    raf = requestAnimationFrame(loop);
    const dt = last ? now - last : 16;
    last = now;
    if (!player.paused) {
      player.advance(dt, 12, now);
      if (player.dev.flips !== shownFlips) { shownFlips = player.dev.flips; paint(false); }
      if (player.cpu.halted) { status.textContent = `The program stopped. ${player.cpu.console.trim().split('\n').pop() ?? ''}`; player.pause(); renderControls(); }
    }
    if (now - lastPanel >= PANEL_MS) { lastPanel = now; renderStats(); if (!player.paused) renderSide(); }
  };

  // ---- keys: only while the screen has focus ----
  const releaseAll = () => {
    if (player && loaded) for (const code of held) { const k = loaded.keys.doomKey(code); if (k !== null) player.dev.key(k, false); }
    held.clear();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!player || !loaded || player.paused) return;
    const k = loaded.keys.doomKey(e.code);
    if (k === null) return;
    e.preventDefault();
    e.stopPropagation();
    const down = e.type === 'keydown';
    if (down && (e.repeat || held.has(e.code))) return;
    if (down) held.add(e.code); else held.delete(e.code);
    player.dev.key(k, down);
  };
  canvas.addEventListener('keydown', onKey);
  canvas.addEventListener('keyup', onKey);
  canvas.addEventListener('blur', releaseAll);

  // ---- starting ----
  const start = (wad: Uint8Array, name: string) => {
    if (!loaded) return;
    const problem = wadProblem(wad);
    if (problem) { status.textContent = `${name}: ${problem}.`; return; }
    player = new loaded.mod.DoomPlayer(loaded.image, wad, loaded.syms);
    player.dev.onFlip = () => { frameCycles = (player!.cpu.mtime - flipMt) >>> 0; flipMt = player!.cpu.mtime; };
    status.textContent = `${name} · click the screen, then play with the keyboard.`;
    startRow.replaceChildren();
    keysHint.replaceChildren(...loaded.keys.DOOM_CONTROLS.flatMap(([k, what]) => [h('kbd', null, k), ` ${what} · `]));
    renderControls();
    canvas.focus();
    raf = requestAnimationFrame(loop);
  };

  const file = h('input', { type: 'file', accept: '.wad,.WAD', class: 'doom-file', 'aria-label': 'Load your own WAD file' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (f) start(new Uint8Array(await f.arrayBuffer()), f.name);
  });
  const playFree = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    playFree.setAttribute('disabled', '');
    try {
      const wad = await fetchBytes(FREEDOOM, (got, total) => { status.textContent = `Downloading Freedoom: ${(got / 1e6).toFixed(1)}${total ? ` of ${(total / 1e6).toFixed(1)}` : ''} MB…`; });
      if (alive) start(wad, 'Freedoom: Phase 1');
    } catch {
      status.textContent = 'Freedoom is not part of this build (the deploy adds it; locally: node scripts/doom/fetch-wad.mjs). You can load your own WAD instead.';
      playFree.removeAttribute('disabled');
    }
  } }, 'Play Freedoom (29 MB)');

  loadProgram().then((l) => {
    if (!alive) return;
    loaded = l;
    status.textContent = `Doom for RV32IM: ${fmt(l.image.text.length)} instruction words, ${fmt(l.syms.length)} functions. Choose the game data:`;
    startRow.replaceChildren(playFree, h('label', { class: 'btn' }, 'Load your own WAD…', file),
      h('span', { class: 'muted' }, 'Freedoom is free (BSD licence); doom1.wad (shareware) or doom.wad work too.'));
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  }).catch((e: unknown) => { status.textContent = `Could not load the program: ${String(e)}`; });

  return {
    el,
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      releaseAll();
    },
  };
}
