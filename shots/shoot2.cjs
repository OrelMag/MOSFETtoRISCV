const puppeteer = require('C:/Users/USER/AppData/Local/Temp/claude/e--MOSFET-to-RISCV/d00397af-4c14-48f3-8900-698d39b9c4eb/scratchpad/node_modules/puppeteer-core');
const out = 'E:/MOSFET-qolstage/shots/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] });
  const base = 'http://localhost:4403/';
  for (const theme of ['light', 'dark']) {
    const seed = (t) => { try { localStorage.setItem('mosfet2riscv:v1', JSON.stringify({ theme: t, coachDone: { stage: true, sandbox: true } })); } catch {} };
    // loading card
    const p = await b.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    await p.evaluateOnNewDocument(seed, theme);
    const t0 = Date.now();
    await p.goto(base + '#/c/graphics/3', { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      if (await p.$('.load-card')) { await sleep(300); await p.screenshot({ path: out + `loading-${theme}.png` }); console.log('card seen at', Date.now() - t0); break; }
    }
    await p.waitForSelector('.stage .crumbs', { timeout: 60000 });
    await p.waitForFunction(() => !document.querySelector('.load-card'), { timeout: 60000 });
    console.log(theme, 'loaded after', Date.now() - t0, 'ms');
    await p.close();
    // minimap
    const q = await b.newPage();
    await q.setViewport({ width: 1280, height: 800 });
    await q.evaluateOnNewDocument(seed, theme);
    await q.goto(base + '#/sandbox', { waitUntil: 'networkidle0' });
    const ex = await q.$$eval('button', (bs) => bs.findIndex((x) => x.textContent.trim().startsWith('Examples')));
    (await q.$$('button'))[ex].click();
    await sleep(300);
    const items = await q.$$('.sb-menu button');
    console.log('examples', items.length);
    // pick the computer
    const idx = await q.$$eval('.sb-menu button', (bs) => bs.findIndex((x) => /computer/i.test(x.textContent)));
    (await q.$$('.sb-menu button'))[Math.max(idx, 0)].click();
    await sleep(2500);
    await q.screenshot({ path: out + `minimap-fit-${theme}.png` });
    const c = await q.$('.sb-canvas');
    const box = await c.boundingBox();
    await q.mouse.move(box.x + box.width / 3, box.y + box.height / 3);
    for (let i = 0; i < 6; i++) { await q.mouse.wheel({ deltaY: -300 }); await sleep(60); }
    await sleep(500);
    await q.screenshot({ path: out + `minimap-zoom-${theme}.png` });
    console.log('minimap visible', await q.$eval('.sb-minimap', (e) => !e.hidden));
    await q.close();
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
