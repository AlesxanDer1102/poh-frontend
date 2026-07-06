import { WalletConnect } from './components/WalletConnect.jsx';
import { ValidationFlow } from './components/ValidationFlow.jsx';

export function App() {
  return (
    <div className="app-shell">
      <header className="navbar">
        <div className="container navbar__inner">
          <div className="brand">
            <span className="brand__mark" aria-hidden="true">
              ⬡
            </span>
            <span className="brand__name">
              Proof of Humanity
              <span className="brand__sub">Hybrid on-chain identity</span>
            </span>
          </div>
          <WalletConnect />
        </div>
      </header>

      <main className="container">
        <section className="hero">
          <span className="hero__eyebrow">
            <span className="net-badge__dot" aria-hidden="true" />
            Ethereum Sepolia · Testnet
          </span>
          <h1>Verify you are a unique human</h1>
          <p>
            A hybrid Proof of Humanity system: off-chain face verification and liveness,
            registered as a tamper-proof proof on the Ethereum blockchain.
          </p>
        </section>

        <ValidationFlow />
      </main>

      <footer className="footer">
        Reference implementation · Hybrid Proof of Humanity on Blockchain
      </footer>
    </div>
  );
}
