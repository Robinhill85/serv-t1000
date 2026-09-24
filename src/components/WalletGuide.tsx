"use client";
// "Use your own wallet": what a visitor needs before T1000 can deploy their stablecoins, and what they will sign.
export function WalletGuide({ onClose, walletMaxRunUsd }: { onClose: () => void; walletMaxRunUsd: number | null }) {
  return (
    <div className="guide" role="dialog" aria-label="Use your own wallet">
      <div className="guide-head">
        <strong>Use your own wallet</strong>
        <button className="chat-reset" onClick={onClose}>Close</button>
      </div>
      <div className="guide-body">
        <p>T1000 plans with what your wallet holds and you confirm every transaction in your wallet. It never holds your keys or your funds.</p>
        <h4>What you need (any one chain is enough)</h4>
        <ul>
          <li><b>Base:</b> USDC, plus a little ETH for gas. Goes to Base USDC lending (Morpho, instant withdrawal).</li>
          <li><b>Avalanche:</b> at least $100 USDC, plus a little AVAX for gas. Goes to the IXS RWA vault (a regulated bond vault).</li>
          <li><b>Robinhood Chain:</b> USDG, plus a little ETH for gas. A small slice buys ETH (only if you opt into volatile assets).</li>
        </ul>
        <p>No bridging: each venue only gets what you already hold on its chain. Runs are capped at ${walletMaxRunUsd ?? 500} during the beta.</p>
        <h4>How a run goes</h4>
        <ol>
          <li>Connect a browser wallet (MetaMask, Rabby, Brave, Coinbase Wallet) and scan it.</li>
          <li>Answer a few questions in your own words. SERV drafts the split, the Shadow Agent checks it, and hard rules in code cap it.</li>
          <li>Press <b>Check it first</b> to simulate every transaction from your wallet (nothing is sent), then <b>Deploy from my wallet</b>.</li>
          <li>Your wallet asks you to confirm each step: an approval and a deposit (or swap) per venue. It may ask to switch network, and to add Robinhood Chain once.</li>
          <li>Guard then watches your positions and proposes rebalances, which you sign too.</li>
        </ol>
        <h4>Know before you go</h4>
        <ul>
          <li>This is a hackathon beta. It can have bugs, and nothing here is financial advice.</li>
          <li>IXS deposits settle T+1, exits cost 0.5%, and IXS can reject a request (you get the USDC back).</li>
          <li>ETH is volatile. Base lending can be withdrawn any time, straight from Morpho.</li>
        </ul>
        <p>No wallet? Try the demo: the same flow as a full simulation against live mainnet.</p>
      </div>
    </div>
  );
}
