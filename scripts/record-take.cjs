// Records one full demo take against prod: typed answers, simulate, Guard, stress test, SERV rebalance, moves.
// Frames come from the CDP screencast (JPEG q95, 1920x1080: a 1280x720 page at a forced 1.5x scale); markers log each beat.
const fs = require('fs');
const path = require('path');
// Usage: PLAYWRIGHT=<path to a playwright package> CHROME=<Chrome for Testing binary> node scripts/record-take.cjs <outdir>
// Playwright is not a project dependency; any install works. Encode: ffmpeg -f concat -safe 0 -i <outdir>/frames.ffconcat
//   -vf "fps=30,format=yuv420p" -c:v libx264 -crf 16 <outdir>/take.mp4
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const EXE = process.env.CHROME;
const BASE = process.env.BASE || 'https://serv-t1000.vercel.app';
const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node record-take.cjs <outdir>');
fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });

const CURSOR = () => {
  const install = () => {
    const c = document.createElement('div');
    c.id = 'rec-cursor';
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2.5l6.8 18.2 2.4-7.4 7.3-2.6z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-200px,-200px)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.6))' });
    const ring = document.createElement('div');
    Object.assign(ring.style, { position: 'fixed', zIndex: '2147483646', pointerEvents: 'none', width: '34px', height: '34px', borderRadius: '50%', border: '2px solid #fff', opacity: '0', transform: 'translate(-200px,-200px)', transition: 'opacity .35s, width .35s, height .35s' });
    document.body.append(ring, c);
    document.addEventListener('mousemove', (e) => { c.style.transform = `translate(${e.clientX - 4}px, ${e.clientY - 3}px)`; }, true);
    document.addEventListener('mousedown', (e) => {
      ring.style.transition = 'none'; ring.style.opacity = '0.9'; ring.style.width = ring.style.height = '14px';
      ring.style.transform = `translate(${e.clientX - 7}px, ${e.clientY - 7}px)`;
      requestAnimationFrame(() => { ring.style.transition = 'opacity .4s, width .4s, height .4s, transform .4s'; ring.style.opacity = '0'; ring.style.width = ring.style.height = '44px'; ring.style.transform = `translate(${e.clientX - 22}px, ${e.clientY - 22}px)`; });
    }, true);
  };
  if (document.body) install(); else document.addEventListener('DOMContentLoaded', install);
};

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--headless=new', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars', '--force-device-scale-factor=1.5', '--window-size=1280,807'] });
  // Real 1.5x device scale (the emulated one is ignored by the screencast): 1280x720 page -> 1920x1080 frames.
  const ctx = await browser.newContext({ viewport: null });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);

  const frames = [];
  const markers = [];
  let t0 = null;
  const mark = (label, extra) => { const t = Date.now() / 1000 - (t0 ?? Date.now() / 1000); markers.push({ t: +t.toFixed(3), label, ...extra }); console.log(`[${t.toFixed(1)}s] ${label}`, extra ? JSON.stringify(extra) : ''); };
  cdp.on('Page.screencastFrame', async (f) => {
    const ts = f.metadata.timestamp ?? Date.now() / 1000;
    if (t0 == null) t0 = ts;
    const file = `f_${String(frames.length).padStart(6, '0')}.jpg`;
    frames.push({ file, t: ts - t0 });
    fs.writeFile(path.join(OUT, 'frames', file), Buffer.from(f.data, 'base64'), () => {});
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
  });

  let mx = 900, my = 600;
  const moveTo = async (x, y, steps = 22) => { await page.mouse.move(x, y, { steps }); mx = x; my = y; };
  const click = async (locator, pause = 250) => {
    await locator.scrollIntoViewIfNeeded();
    const b = await locator.boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await moveTo(x, y);
    await page.waitForTimeout(pause);
    await page.mouse.click(x, y);
  };
  const type = async (text) => { await page.keyboard.type(text, { delay: 55 }); await page.waitForTimeout(300); await page.keyboard.press('Enter'); };
  const waitText = (text, timeout = 120000) => page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });

  await page.goto(`${BASE}/?intro=0`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await page.mouse.move(mx, my);
  await page.waitForTimeout(2000);

  mark('scan');
  await click(page.getByRole('button', { name: 'Scan wallet' }));
  await waitText('in idle stablecoins');
  await page.waitForTimeout(900);

  mark('profile');
  await click(page.getByRole('button', { name: 'UK', exact: true }));
  await waitText('How much of your idle stables');
  await page.waitForTimeout(600);
  await click(page.getByLabel('Your answer'));
  await type('all is fine');
  await waitText('How long can the money stay put?');
  await page.waitForTimeout(600);
  await click(page.getByLabel('Your answer'));
  await type('about half a year');
  await waitText('Might you need it back instantly?');
  await page.waitForTimeout(600);
  await click(page.getByRole('button', { name: 'No, it can wait' }));
  await page.waitForTimeout(500);
  await click(page.getByRole('button', { name: 'A mix' }));
  await page.waitForTimeout(500);
  await click(page.getByRole('button', { name: 'Medium' }));
  await waitText('Anything else about your goal?');
  await page.waitForTimeout(500);
  await click(page.getByLabel('Your answer'));
  await type("Park it for 6 months, I'd like about 10% in ETH for upside");

  mark('decide');
  const simRun = page.getByRole('button', { name: 'Simulate the run (no funds move)' });
  await simRun.waitFor({ state: 'visible', timeout: 180000 });
  const legs = await page.$$eval('.msg-plan .plan-row', (els) => els.map((e) => e.innerText.replace(/\n/g, ' ')));
  mark('plan', { legs });
  await page.waitForTimeout(3500);

  mark('simulate');
  await click(simRun);
  await waitText('Guard mode is on', 180000);
  mark('guard');
  await page.waitForTimeout(6000);

  const stress = page.getByRole('button', { name: /Stress test: ETH/ });
  if (!(await stress.isVisible())) { mark('no-eth-leg'); }
  else {
    mark('stress', { label: await stress.innerText() });
    await click(stress);
    await page.getByRole('button', { name: 'Ask SERV for a rebalance' }).waitFor({ state: 'visible', timeout: 60000 });
    mark('drift');
    await page.waitForTimeout(4500);
    mark('propose');
    await click(page.getByRole('button', { name: 'Ask SERV for a rebalance' }));
    const simMoves = page.getByRole('button', { name: 'Simulate the moves (no funds move)' });
    await simMoves.waitFor({ state: 'visible', timeout: 180000 });
    mark('proposal');
    await page.waitForTimeout(3500);
    mark('moves');
    await click(simMoves);
    await waitText('Rebalanced ·', 180000);
    mark('guard2');
    await page.waitForTimeout(6000);
  }
  mark('end');
  await cdp.send('Page.stopScreencast');
  await page.waitForTimeout(500);
  await browser.close();

  // VFR frames -> concat list with real durations (last frame held 0.5s).
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => { const next = frames[i + 1]?.t ?? f.t + 0.5; lines.push(`file frames/${f.file}`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`); });
  lines.push(`file frames/${frames.at(-1).file}`);
  fs.writeFileSync(path.join(OUT, 'frames.ffconcat'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'markers.json'), JSON.stringify({ markers, frames: frames.length, duration: frames.at(-1).t }, null, 2));
  console.log(`frames ${frames.length}, ${frames.at(-1).t.toFixed(1)}s`);
})().catch((e) => { console.error('TAKE FAILED:', e.message.split('\n')[0]); process.exit(1); });
