import { useState } from 'react';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { chain } from '../wagmi.js';

function shortAddress(addr) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletConnect() {
  const { address, isConnected } = useAccount();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [copied, setCopied] = useState(false);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  if (isConnected) {
    return (
      <div className="wallet-cluster">
        <span className="net-badge">
          <span className="net-badge__dot" aria-hidden="true" />
          {chain.name}
        </span>
        <span className="account-chip">
          <span className="account-chip__avatar" aria-hidden="true" />
          <span className="account-chip__addr">{shortAddress(address)}</span>
          <button
            className="icon-btn"
            onClick={copyAddress}
            title={copied ? 'Copied' : 'Copy address'}
            aria-label="Copy address"
          >
            {copied ? '✓' : '⧉'}
          </button>
          <button
            className="icon-btn"
            onClick={() => disconnect()}
            title="Disconnect"
            aria-label="Disconnect wallet"
          >
            ⏻
          </button>
        </span>
      </div>
    );
  }

  return (
    <button
      className="btn btn--primary"
      onClick={() => connect({ connector: injected() })}
      disabled={isPending}
    >
      {isPending ? 'Connecting…' : 'Connect wallet'}
    </button>
  );
}
