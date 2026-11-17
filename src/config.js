/**
 * Runtime configuration from Vite env vars (see .env.example). The only module that reads
 * `import.meta.env`; the logic in src/lib receives these values explicitly.
 */
import { PSE_ARTIFACTS_URL, artifactsFrom } from './lib/semaphore.js';

const env = import.meta.env;
const addr = (v) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : undefined);

const artifactsSetting = (env.VITE_SEMAPHORE_ARTIFACTS_URL ?? '/semaphore').trim();

export const appConfig = {
  apiUrl: env.VITE_API_URL ?? 'http://localhost:4000',
  chainId: Number(env.VITE_CHAIN_ID ?? 11155111),
  rpcUrl: env.VITE_RPC_URL || undefined,
  /** 'semaphore' | 'legacy' | 'auto' (ask the backend's /health). */
  issuanceMode: (env.VITE_ISSUANCE_MODE ?? 'auto').toLowerCase(),
  /** Passed to src/lib/semaphore.js as `cfg`. */
  chain: {
    issuer: addr(env.VITE_HUMANITY_ISSUER_ADDRESS),
    registry: addr(env.VITE_DELEGATION_REGISTRY_ADDRESS),
    semaphore: addr(env.VITE_SEMAPHORE_ADDRESS),
    startBlock: Number(env.VITE_SEMAPHORE_START_BLOCK ?? 0),
    logChunkBlocks: Number(env.VITE_LOG_CHUNK_BLOCKS ?? 0),
  },
  explorerUrl: env.VITE_EXPLORER_URL ?? (Number(env.VITE_CHAIN_ID ?? 11155111) === 11155111 ? 'https://sepolia.etherscan.io' : undefined),
  /** Circuit artifacts resolver: local files by default, `cdn` = PSE CDN, or any base URL. */
  artifacts: artifactsFrom(artifactsSetting === 'cdn' ? PSE_ARTIFACTS_URL : artifactsSetting),
};

/** True when the delegation feature has the addresses it needs. */
export const delegationConfigured = Boolean(appConfig.chain.issuer && appConfig.chain.registry);
