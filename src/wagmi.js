import { http, createConfig } from 'wagmi';
import { foundry, mainnet, sepolia } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';
import { defineChain } from 'viem';
import { appConfig } from './config.js';

// Chain selected with VITE_CHAIN_ID (default Sepolia; 31337 = local anvil). Unknown ids need
// VITE_RPC_URL and are exposed as a generic chain.
const known = [sepolia, foundry, mainnet].find((c) => c.id === appConfig.chainId);
export const chain =
  known ??
  defineChain({
    id: appConfig.chainId,
    name: `Chain ${appConfig.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [appConfig.rpcUrl ?? ''] } },
  });

// Injected connector (MetaMask and compatible EVM wallets). Web3Modal/WalletConnect can be
// added later with a WalletConnect projectId if broader wallet support is required.
export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected()],
  transports: {
    [chain.id]: http(appConfig.rpcUrl),
  },
});
