const puppeteer = require('C:/Users/USER/AppData/Local/Temp/claude/e--MOSFET-to-RISCV/d00397af-4c14-48f3-8900-698d39b9c4eb/scratchpad/node_modules/puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] });
  for (const [name, port] of [['main', 4404], ['sliced', 4403], ['main', 4404], ['sliced', 4403], ['main', 4404], ['sliced', 4403]]) {
    const p = await b.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    await p.evaluateOnNewDocument(() => {
      localStorage.setItem('mosfet2riscv:v1', JSON.stringify({ theme: 'light', coachDone: { stage: true, sandbox: true } }));
      window.__t = {};
      new MutationObserver(() => { if (!window.__t.run && document.querySelector('.stage .ctl-run')) window.__t.run = Math.round(performance.now()); if (!window.__t.first && document.querySelector('.stage')) window.__t.first = Math.round(performance.now()); }).observe(document, { childList: true, subtree: true });
    });
    await p.goto(`http://localhost:${port}/#/c/graphics/4`, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.__t.run, { timeout: 60000, polling: 100 });
    const t = await p.evaluate(() => window.__t);
    console.log(name, 'stage in DOM', t.first, 'ms, circuit built', t.run, 'ms (from navigation start)');
    await p.close();
  }
  await b.close();
})();
