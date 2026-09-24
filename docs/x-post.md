# X submission post (draft v1)

Thread of 5. Attach `assets/cut/t1000-demo-final.mp4` to tweet 1. All tweets fit 280 characters (links count as 23).
Optional image on tweet 3: the Guard onchain screenshot (`assets/takes/proof/guard.mp4` frame).

---

**1/ (video)**

Your idle stablecoins are sitting there doing nothing.

So I built T1000 for the @openservai SERV hackathon.

It decides where they should live, deploys them across 3 chains, then keeps guarding them.

$150 already went live on mainnet. Here's how it works:

**2/**

1. Tell it what you want in plain words. Jev by TypeSafe classifies each answer instantly.

2. SERV Reasoning drafts the split. A Shadow Agent checks it before any money moves.

3. AgentKit executes: IXS RWA vault (Avalanche), USDC lending (Base), ETH (Robinhood Chain).

**3/**

The part most "AI yield" tools skip: what happens after deploy.

T1000 re-checks every position each minute. Drift, a shrinking yield gap, vault rule changes, new cash.

Stress test: ETH +70%. SERV proposed the exact trim. Shadow Agent verified it. Back to 70/20/10.

**4/**

Biggest lesson building it:

Let the model reason. Let code enforce.

UK user? Stock tokens are blocked in code, not by a prompt. IXS $100 minimum, same. Every tx gets simulated before it's sent.

SERV picks the split. The rules can't be talked out of.

**5/**

Try it (free simulation, no wallet connect): https://serv-t1000.vercel.app
Code: https://github.com/Robinhill85/serv-t1000
Live proof, the $105 IXS deposit: https://snowtrace.io/tx/0xfde6acee579dd1ba72c892cdd2818630f8fac66ebabc445b9becaa1095f2f818
