// End-to-end test of "My wallet" mode with a mock EIP-1193 wallet: nothing is signed or broadcast.
// The mock records every wallet request and returns fake tx hashes; RPC lookups for those hashes (receipts) and for
// allowances are answered in the test, everything else goes to the real chains (plans and pre-flight are real).
// Usage: PLAYWRIGHT=<pkg> CHROME=<Chrome for Testing> BASE=http://localhost:3200 node scripts/test-wallet-flow.cjs
//   REJECT_AT=2  the wallet declines its 2nd transaction; the test then clicks "Finish the remaining steps" and checks
//                that no confirmed transaction is sent twice.
//   FLOW=withdraw USER_WALLET=<a wallet holding a T1000 position>: scan it, withdraw from the positions card.
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const BASE = process.env.BASE || "http://localhost:3200";
const USER = process.env.USER_WALLET || "0x2C12CF9dcb6C4958216e7eCe4c71a2Ebc3db358a"; // a funded wallet, read-only here

const MOCK = ({ user, rejectAt }) => {
  const listeners = {};
  const calls = [];
  let chainId = "0x2105"; // Base
  const known = new Set(["0x2105", "0xa86a"]); // the wallet doesn't know Robinhood Chain until it is added
  let n = 0;
  const emit = (ev, v) => (listeners[ev] || []).forEach((f) => f(v));
  const provider = {
    isMetaMask: false,
    request: async ({ method, params }) => {
      calls.push({ method, params, chainId });
      switch (method) {
        case "eth_requestAccounts": window.__authorized = true; return [user];
        case "eth_accounts": return window.__authorized ? [user] : []; // like a real wallet: nothing until connected
        case "eth_chainId": return chainId;
        case "net_version": return String(parseInt(chainId, 16));
        case "wallet_switchEthereumChain": {
          const id = params[0].chainId.toLowerCase();
          if (!known.has(id)) { const e = new Error("Unrecognized chain"); e.code = 4902; throw e; }
          chainId = id; emit("chainChanged", id); return null;
        }
        case "wallet_addEthereumChain": { const id = params[0].chainId.toLowerCase(); known.add(id); chainId = id; emit("chainChanged", id); return null; }
        case "eth_sendTransaction": {
          n += 1;
          if (n === rejectAt) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
          return "0x" + "ab".repeat(30) + n.toString(16).padStart(4, "0");
        }
        case "eth_getTransactionReceipt": return { status: "0x1", transactionHash: params[0] }; // the wallet's own RPC
        case "wallet_getPermissions": case "wallet_requestPermissions": return [{ parentCapability: "eth_accounts" }];
        default: throw Object.assign(new Error(`mock: ${method} unsupported`), { code: 4200 });
      }
    },
    on: (ev, f) => { (listeners[ev] = listeners[ev] || []).push(f); },
    removeListener: (ev, f) => { listeners[ev] = (listeners[ev] || []).filter((x) => x !== f); },
  };
  window.__walletCalls = calls;
  window.ethereum = provider;
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
    detail: Object.freeze({ info: { uuid: "0b6c-mock", name: "Mock Wallet", rdns: "test.mock.wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'/>" }, provider }),
  }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
};

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME, args: ["--headless=new"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const rejectAt = Number(process.env.REJECT_AT || 0);
  await ctx.addInitScript(MOCK, { user: USER, rejectAt });
  // Fake receipts for the fake hashes, and a max allowance so the approval wait doesn't stall; the rest is real.
  // RECEIPT_VIA_WALLET=1: public RPCs fail receipt lookups (like Base publicnode on 24 Sep); only the wallet answers.
  const viaWallet = process.env.RECEIPT_VIA_WALLET === "1";
  await ctx.route(/publicnode\.com|mainnet\.base\.org|api\.avax\.network|rpc\.mainnet\.chain\.robinhood\.com/, async (route) => {
    const body = route.request().postDataJSON?.();
    const one = (m) => {
      if (m?.method === "eth_getTransactionReceipt" && viaWallet) return { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "Invalid parameters were provided to the RPC method." } };
      if (m?.method === "eth_getTransactionReceipt" && String(m.params?.[0]).startsWith("0x" + "ab".repeat(30))) {
        return { jsonrpc: "2.0", id: m.id, result: {
          transactionHash: m.params[0], transactionIndex: "0x0", blockHash: "0x" + "11".repeat(32), blockNumber: "0x1", from: USER, to: USER,
          cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, logs: [], logsBloom: "0x" + "00".repeat(256), status: "0x1", type: "0x2",
        } };
      }
      if (m?.method === "eth_call" && String(m.params?.[0]?.data ?? m.params?.[0]?.input).startsWith("0xdd62ed3e")) return { jsonrpc: "2.0", id: m.id, result: "0x" + "ff".repeat(32) };
      return null;
    };
    const faked = Array.isArray(body) ? body.map(one) : one(body);
    if (faked && (!Array.isArray(faked) || faked.every(Boolean))) return route.fulfill({ contentType: "application/json", body: JSON.stringify(faked) });
    return route.fallback();
  });
  const page = await ctx.newPage();
  const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
  const t0 = Date.now();
  await page.goto(`${BASE}/?intro=0`, { waitUntil: "load" });

  const walletBtn = page.locator(".wallet-box .chips button", { hasText: /Mock Wallet|Browser wallet/ }).first();
  log("connect via:", await walletBtn.innerText());
  await walletBtn.click();
  await page.getByRole("button", { name: "Scan my wallet" }).click();
  await page.getByText("Your wallet holds").first().waitFor({ timeout: 60000 });
  log("scan:", (await page.getByText("Your wallet holds").first().innerText()).slice(0, 220));
  const sends = () => page.evaluate(() => window.__walletCalls.filter((c) => c.method === "eth_sendTransaction").map((c) => `${c.params[0].to}:${c.params[0].data.slice(0, 74)}`));

  if (process.env.FLOW === "withdraw") {
    await page.getByText(/Your T1000 positions/).first().waitFor({ timeout: 60000 });
    log("positions:", await page.$$eval(".msg-plan .plan-row", (els) => els.map((e) => e.innerText.replace(/\n/g, " "))));
    const btn = page.locator(".withdraw .chips button").first();
    log("withdraw via:", await btn.innerText());
    await btn.click();
    await page.getByText(/Withdraw · your wallet · live · (all confirmed|stopped)/).first().waitFor({ timeout: 120000 });
    log("withdraw:", await page.$$eval(".exec-step", (els) => els.map((e) => e.innerText.replace(/\n/g, " ").slice(0, 110))));
    log("sent:", JSON.stringify(await sends()));
    await page.getByText(/Withdrawn · your wallet/).first().waitFor({ timeout: 30000 }).then(async () => log("summary:", await page.getByText(/Withdrawn · your wallet/).first().locator("..").innerText())).catch(() => log("no withdraw summary"));
    await page.screenshot({ path: process.env.SHOT || "/tmp/wallet-flow.png" });
    await browser.close();
    return;
  }
  for (const label of ["UK", /All of it/, "3–12 months", "No, it can wait", "A mix", "Medium", "Skip"]) {
    await page.locator(".chips button", { hasText: label }).first().click();
    await page.waitForTimeout(400);
  }
  await page.locator(".msg-plan .plan-row").first().waitFor({ timeout: 180000 });
  await page.getByText(/Deploy from my wallet|can't fund|Not verified/).first().waitFor({ timeout: 180000 });
  log("plan:", await page.$$eval(".msg-plan .plan-row", (els) => els.map((e) => e.innerText.replace(/\n/g, " "))));

  await page.getByRole("button", { name: /Check it first/ }).click();
  await page.getByText(/every step passes|stopped/).first().waitFor({ timeout: 120000 });
  log("check:", await page.$$eval(".exec-step", (els) => els.map((e) => e.innerText.replace(/\n/g, " ").slice(0, 90))));

  await page.locator(".risk input").check();
  await page.getByRole("button", { name: "Deploy from my wallet" }).click();
  await page.getByText(/all confirmed|stopped/).first().waitFor({ timeout: 180000 });
  if (rejectAt) {
    log("stopped:", await page.$$eval(".exec-step", (els) => els.map((e) => e.innerText.replace(/\n/g, " ").slice(0, 90))));
    const before = await sends();
    log("sent before resume:", before.length, "(incl. the declined one)");
    await page.locator(".msg-plan .exec-actions button", { hasText: "Finish the remaining steps" }).last().click();
    await page.getByText(/Deploy · your wallet · live · all confirmed/).first().waitFor({ timeout: 180000 });
    const all = await sends();
    const accepted = all.filter((_, i) => i + 1 !== rejectAt);
    const dupes = accepted.filter((x, i) => accepted.indexOf(x) !== i);
    log("sent after resume:", all.length, dupes.length ? `DUPLICATES: ${dupes.join(", ")}` : "no transaction sent twice");
    if (dupes.length) throw new Error("a confirmed transaction was sent twice");
  }
  const calls = await page.evaluate(() => window.__walletCalls.filter((c) => !["eth_chainId", "eth_accounts", "net_version"].includes(c.method)).map((c) => ({ m: c.method, chain: c.chainId, arg: c.method === "eth_sendTransaction" ? `${c.params[0].to}:${c.params[0].data.slice(0, 10)}` : c.params?.[0]?.chainId })));
  log("wallet calls:", JSON.stringify(calls));
  log("deploy:", await page.$$eval(".exec-step", (els) => els.slice(-4).map((e) => e.innerText.replace(/\n/g, " ").slice(0, 90))));
  await page.getByText(/Guard mode is on/).first().waitFor({ timeout: 30000 }).then(() => log("handed off to Guard")).catch(() => log("no Guard hand-off"));
  await page.getByText(/your wallet, onchain/i).first().waitFor({ timeout: 60000 }).then(() => log("Guard reads the user's wallet onchain")).catch(() => log("Guard label missing"));
  await page.screenshot({ path: process.env.SHOT || "/tmp/wallet-flow.png" });
  await browser.close();
})().catch((e) => { console.error("TEST FAILED:", e.message.split("\n")[0]); process.exit(1); });
