// Records the live-proof shots against prod at 1920x1080:
//   guard    Guard's onchain view of the agent wallet (the operator's resume link, session seeded like a live deploy)
//   explorer the IXS deposit request on Avalanche's explorer (subnets.avax.network)
// Usage: PLAYWRIGHT=<pkg> CHROME=<Chrome for Testing> node scripts/record-proof.cjs <outdir>
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const BASE = process.env.BASE || "https://serv-t1000.vercel.app";
const IXS_TX = process.env.IXS_TX || "0xfde6acee579dd1ba72c892cdd2818630f8fac66ebabc445b9becaa1095f2f818";
const OUT = process.argv[2];
if (!OUT) throw new Error("usage: node record-proof.cjs <outdir>");

// The first live deploy (24 Sep): 70/20/10 of $150, the same plan the demo shows.
const SESSION = {
  source: "live",
  profile: { residence: "UK", amountUsd: 150, horizon: "3_12m", risk: "medium", instantAccess: false, preference: "mixed", goal: "Park it for 6 months, I'd like about 10% in ETH for upside" },
  legs: [{ venue: "ixs", pct: 70, usd: 105 }, { venue: "base", pct: 20, usd: 30 }, { venue: "rh_eth", pct: 10, usd: 15 }],
  entry: { at: Date.parse("2026-09-24T10:30:00Z"), ethPriceUsd: 2670, idleUsd: null },
  scenario: null,
  deployedLive: true,
};

async function shot(browser, name, run) {
  const dir = path.join(OUT, name, "frames");
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: null });
  await ctx.addInitScript((s) => { try { localStorage.setItem("t1000.guard.v1", s); } catch {} }, JSON.stringify(SESSION));
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  let t0 = null, recording = false;
  cdp.on("Page.screencastFrame", async (f) => {
    if (recording) {
      const ts = f.metadata.timestamp ?? Date.now() / 1000;
      if (t0 == null) t0 = ts;
      const file = `f_${String(frames.length).padStart(6, "0")}.jpg`;
      frames.push({ file, t: ts - t0 });
      fs.writeFileSync(path.join(dir, file), Buffer.from(f.data, "base64"));
    }
    try { await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }); } catch {}
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: 1920, maxHeight: 1080 });
  await run(page, () => { recording = true; });
  await cdp.send("Page.stopScreencast");
  await ctx.close();
  const lines = ["ffconcat version 1.0"];
  frames.forEach((f, i) => { const next = frames[i + 1]?.t ?? f.t + 0.5; lines.push(`file frames/${f.file}`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`); });
  if (frames.length) lines.push(`file frames/${frames.at(-1).file}`);
  fs.writeFileSync(path.join(OUT, name, "frames.ffconcat"), lines.join("\n") + "\n");
  console.log(`${name}: ${frames.length} frames, ${(frames.at(-1)?.t ?? 0).toFixed(1)}s`);
}

(async () => {
  const browser = await chromium.launch({
    headless: true, executablePath: process.env.CHROME,
    args: ["--headless=new", "--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--hide-scrollbars", "--force-device-scale-factor=1.5", "--window-size=1280,807"],
  });

  await shot(browser, "guard", async (page, start) => {
    await page.goto(`${BASE}/?intro=0`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Operator: resume Guard on the live deployment" }).click();
    await page.getByText("agent wallet, onchain").first().waitFor({ timeout: 60000 });
    await page.getByText("Deposit requested; vault shares arrive").first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(1500);
    start();
    await page.waitForTimeout(7000);
  });

  await shot(browser, "explorer", async (page, start) => {
    // Avalanche's own explorer (Snowtrace/Routescan and Avascan refuse headless browsers). Cookie banner: reject.
    await page.goto(`https://subnets.avax.network/c-chain/tx/${IXS_TX}`, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(4000);
    const reject = page.getByRole("button", { name: "Reject" });
    if (await reject.isVisible().catch(() => false)) await reject.click();
    await page.getByText("Request Deposit").first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(1500);
    const title = await page.title();
    const body = (await page.innerText("body").catch(() => "")).slice(0, 400).replace(/\s+/g, " ");
    console.log(`explorer title: ${title} | ${body.slice(0, 200)}`);
    // A static page sends no screencast frames: keep a 1920x1080 still (the cut pushes in on it slowly).
    await page.screenshot({ path: path.join(OUT, "explorer.png") });
    start();
    await page.waitForTimeout(500);
  });

  await browser.close();
})().catch((e) => { console.error("PROOF FAILED:", e.message.split("\n")[0]); process.exit(1); });
