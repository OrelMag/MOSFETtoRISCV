const puppeteer = require('C:/Users/USER/AppData/Local/Temp/claude/e--MOSFET-to-RISCV/d00397af-4c14-48f3-8900-698d39b9c4eb/scratchpad/node_modules/puppeteer-core');
const out = 'E:/MOSFET-qolstage/shots/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] });
  const base = 'http://localhost:4403/';
  const step = process.argv[2] || '3';
  for (const theme of ['light', 'dark']) {
    const p = await b.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    await p.evaluateOnNewDocument((t) => { localStorage.setItem('mosfet2riscv:v1', JSON.stringify({ theme: t, coachDone: { stage: true, sandbox: true } })); window.__seen = []; new MutationObserver(() => { const c = document.querySelector('.load-card'); if (c) window.__seen.push(performance.now() | 0); }).observe(document, { childList: true, subtree: true }); }, theme);
    const t0 = Date.now();
    await p.goto(base + '#/c/graphics/' + step, { waitUntil: 'domcontentloaded' });
    let shot = false;
    for (let i = 0; i < 40 && !shot; i++) {
      await sleep(250);
      const t = await p.evaluate(() => { const c = document.querySelector('.load-card'); return c ? c.textContent : null; }).catch(() => null);
      if (t) { await sleep(1700); await p.screenshot({ path: out + `loading-${theme}.png` }); console.log('shot at', Date.now() - t0, t.slice(0, 220)); shot = true; }
    }
    await p.waitForFunction(() => document.querySelector('.stage .crumbs') && !document.querySelector('.load-card'), { timeout: 90000 });
    console.log(theme, 'done at', Date.now() - t0, 'card mutations', await p.evaluate(() => window.__seen.length));
    await p.close();
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
