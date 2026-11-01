// screenshots of the three features (untracked): node shots/shoot.cjs
const puppeteer = require('C:/Users/USER/AppData/Local/Temp/claude/e--MOSFET-to-RISCV/d00397af-4c14-48f3-8900-698d39b9c4eb/scratchpad/node_modules/puppeteer-core');
const out = 'E:/MOSFET-qolstage/shots/';
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] });
  const base = 'http://localhost:4403/';
  for (const theme of ['light', 'dark']) {
    const p = await b.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    await p.evaluateOnNewDocument((t) => { try { localStorage.setItem('mosfet2riscv:v1', JSON.stringify({ theme: t })); } catch {} }, theme);
    // coach: chapter 5-ish step
    await p.goto(base + '#/c/gates/2', { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1800));
    await p.screenshot({ path: out + `coach-stage-${theme}.png` });
    await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight');
    await new Promise((r) => setTimeout(r, 400));
    await p.screenshot({ path: out + `coach-stage2-${theme}.png` });
    await p.close();
    // sandbox coach + minimap
    const q = await b.newPage();
    await q.setViewport({ width: 1280, height: 800 });
    await q.evaluateOnNewDocument((t) => { try { localStorage.setItem('mosfet2riscv:v1', JSON.stringify({ theme: t })); } catch {} }, theme);
    await q.goto(base + '#/sandbox', { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1800));
    await q.screenshot({ path: out + `coach-sandbox-${theme}.png` });
    await q.close();
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
