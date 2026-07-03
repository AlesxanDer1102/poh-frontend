import { http, createConfig } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';

// Injected connector (MetaMask and compatible EVM wallets). Web3Modal/WalletConnect can be
// added later with a WalletConnect projectId if broader wallet support is required.
export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [injected()],
  transports: {
    [sepolia.id]: http(),
  },
});
