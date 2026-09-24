# T1000

**An agent for idle stablecoins.** It decides where they should live, deploys them across three chains from *your own wallet*, and then keeps guarding them.

Built for the [OpenServ](https://www.openserv.ai) SERV Hackathon (Edition 01, Open Track). Try it at **[serv-t1000.vercel.app](https://serv-t1000.vercel.app)**.

## Try it

- **With your own wallet.** Click **Use your own wallet** in the chat, connect MetaMask, Rabby, Brave or Coinbase Wallet, and scan it.
  - T1000 only plans with what you already hold on each chain.
  - You confirm every transaction in your wallet.
  - Runs are capped at $500 during the beta.
- **Without a wallet.** **Try the demo** runs the same flow as a full simulation against live mainnet state. Nothing is sent.

| Chain | What you need | Where it goes |
|---|---|---|
| Base | USDC + a little ETH for gas | Base USDC lending: Gauntlet USDC Prime on Morpho (instant withdrawal) |
| Avalanche | $100+ USDC + a little AVAX | IXS RWA vault, IXHYB (a regulated bond vault, ERC-7540, settles T+1) |
| Robinhood Chain | USDG + a little ETH | ETH via Uniswap v3 (only if you opt into volatile assets) |

There's no bridging: each venue only gets what you already hold on its chain. Robinhood Stock Tokens show up in the scan, but they're blocked for UK users by the rulebook.

## How it works

1. **Scan.** Reads your idle stablecoins and gas on Base, Avalanche and Robinhood Chain.
2. **Tell it in your own words.** Jev by TypeSafe classifies free-text answers ("about half a year" becomes "3–12 months") and scores each venue.
3. **Live signals.** Morpho APY and TVL, IXS vault rules (paused, whitelist, NAV, fees, minimum), the ETH pool price and depth, and the Stock Token market session.
4. **SERV Reasoning decides the split.**
   - A fast Multipath draft goes first.
   - Then a verified pass with **Prompt Guard** and the **Shadow Agent** checks that draft against every constraint.
5. **Rules in code, not in the prompt.** The rulebook blocks what you can't touch (jurisdiction, minimums, no funds or no gas on a chain), caps volatility, and keeps a 20% instant-liquidity buffer on Base. `enforce()` and `checkExecutable()` re-apply every ceiling after the model. The model picks the split, and code holds the limits.
6. **Execute.** Plans are HMAC-signed and bound to your address.
   - The server builds unsigned transactions for your wallet and pre-flight-simulates every one from your address with `eth_call`. Nothing is sent unless they all pass.
   - Your wallet then asks you to confirm each approval and deposit or swap, switching chains as needed (it adds Robinhood Chain once).
7. **Guard.** After deploying, T1000 re-checks your positions every minute.
   - It flags drift over 5pp, a shrinking IXS-vs-Base yield gap, IXS vault rule changes, and new idle cash.
   - When something fires, SERV proposes the fewest same-chain moves, the Shadow Agent verifies them, and you sign them in your wallet.
   - A labelled stress test (for example "ETH +70%") shows what it would do.

## Safety model

- **Keys:** your keys never leave your wallet. The server never signs for you.
- **Checks before signing:** every transaction is simulated from your address before you're asked to sign.
- **Plan tokens:** they expire after 15 minutes and only verify for the wallet they were made for.
- **Caps and kill switches:** a $500 public cap per run (`PUBLIC_MAX_RUN_USD`) and a kill switch (`PUBLIC_WALLET_ENABLED=false`).
- **IXS vault:** deposits settle T+1, exits cost 0.5%, and IXS can reject a request, in which case the USDC is refunded.
- **ETH is volatile.** This is a hackathon beta and not financial advice.
- **Operator mode:** the team's own agent wallet (Coinbase AgentKit) can run the same plans live behind a passcode, with its own kill switch. That's how the first live run happened: $150 across IXS, Base and Robinhood Chain.

## Run it yourself

```bash
git clone https://github.com/Robinhill85/serv-t1000 && cd serv-t1000
npm install
cp .env.example .env.local   # fill in the keys below
npm run dev                  # http://localhost:3000
```

| Env | Needed for |
|---|---|
| `SERV_API_KEY` | SERV Reasoning ([docs.openserv.ai](https://docs.openserv.ai)) |
| `TYPESAFE_API_KEY` | Jev scoring and free-text classification |
| `ALCHEMY_API_KEY` | Reads on Base, Avalanche and Robinhood Chain (public RPC fallbacks exist) |
| `PLAN_SECRET` | Signing plans (32+ random characters) |
| `AGENT_ADDRESS` | The demo wallet (simulations run from it) |
| `PUBLIC_WALLET_ENABLED`, `PUBLIC_MAX_RUN_USD` | "My wallet" mode switch and cap |
| `AGENT_PRIVATE_KEY`, `LIVE_PASSCODE`, `EXECUTION_ENABLED`, `MAX_RUN_USD` | Operator live mode only. **Never put the key on a public deployment.** |

Deploying to Vercel works as is (`vercel deploy`). `npm test` runs the rulebook, guard and wallet-mode tests. `scripts/test-wallet-flow.cjs` runs the whole wallet flow in a browser against a mock wallet, and nothing is broadcast.

## Stack

Next.js 16, SERV Reasoning (OpenAI-compatible API), Jev by TypeSafe, viem, wagmi, Coinbase AgentKit (operator wallet), the IXS vault agent SDK, and Three.js for the liquid vaults.
