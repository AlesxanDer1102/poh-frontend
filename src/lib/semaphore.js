/**
 * Semaphore identity + delegation logic. Plain module (no React, no `import.meta.env`) so the UI
 * and the Node integration script (e2e/delegation-lib.mjs) run exactly the same code.
 *
 * Chain access uses viem `PublicClient`s passed in by the caller; configuration is an explicit
 * `cfg` object ({ issuer, registry, semaphore?, startBlock?, logChunkBlocks? }, addresses as 0x strings).
 */
import { getAddress, hexToBigInt, isHex, keccak256, pad, parseAbi, size, toBytes, toHex } from 'viem';
import { Identity } from '@semaphore-protocol/identity';
import { Group } from '@semaphore-protocol/group';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { IDENTITY_MESSAGE_V1, PERMISSIONS, PERMISSION_KEYS, MIN_TTL_SECONDS, TTL_MARGIN_SECONDS } from './constants.js';

export { IDENTITY_MESSAGE_V1 };

// ----------------------------------------------------------------------------------------------
// ABIs
// ----------------------------------------------------------------------------------------------

const PROOF = '(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points)';

export const issuerAbi = parseAbi([
  'function groupId() view returns (uint256)',
  'function semaphore() view returns (address)',
  'function isMember(uint256 commitment) view returns (bool)',
]);

export const semaphoreAbi = parseAbi([
  'function getMerkleTreeRoot(uint256 groupId) view returns (uint256)',
  'event MemberAdded(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot)',
  'event MembersAdded(uint256 indexed groupId, uint256 startIndex, uint256[] identityCommitments, uint256 merkleTreeRoot)',
  'event MemberUpdated(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 newIdentityCommitment, uint256 merkleTreeRoot)',
  'event MemberRemoved(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot)',
]);

export const registryAbi = parseAbi([
  'function maxTtl() view returns (uint64)',
  'function maxActiveDelegations() view returns (uint256)',
  'function nonces(uint256 nullifier) view returns (uint256)',
  'function delegationMessage(address agent, uint64 expiry, bytes32 permissions, uint256 erc8004Id, uint256 nonce) view returns (uint256)',
  'function revocationMessage(address agent, uint256 nonce) view returns (uint256)',
  'function activeAgents(uint256 scope, uint256 nullifier) view returns (address[])',
  'function getDelegation(uint256 scope, address agent) view returns (bool active, uint256 nullifier, bytes32 permissions, uint64 expiry, uint256 erc8004Id)',
]);
// Re-exported for tests that want to assert the proof tuple shape the relayer expects.
export const SEMAPHORE_PROOF_TUPLE = PROOF;

// ----------------------------------------------------------------------------------------------
// Holder identity
// ----------------------------------------------------------------------------------------------

/**
 * Derive the holder's Semaphore identity from a wallet signature over {@link IDENTITY_MESSAGE_V1}.
 *
 * Tradeoff: the identity secret is a deterministic function of the wallet key, so it is never
 * stored or backed up (sign again to recover it), but whoever controls the wallet key can also
 * re-derive the identity: a wallet compromise is an identity compromise. Requires a wallet whose
 * signatures are deterministic (RFC 6979 ECDSA: MetaMask and most EOAs); smart-contract wallets
 * (ERC-1271) are not supported. The secret must stay in memory only and never be sent anywhere.
 *
 * @param {string} signature 65-byte 0x-hex personal_sign signature of IDENTITY_MESSAGE_V1
 * @returns {Identity}
 */
export function deriveIdentity(signature) {
  if (!isHex(signature) || size(signature) !== 65) throw new Error('invalid_signature: expected a 65-byte hex signature');
  return new Identity(signature);
}

/** Ask a signer for the derivation signature and derive the identity. `sign(message) => Promise<hex>`. */
export async function unlockIdentity(sign) {
  return deriveIdentity(await sign(IDENTITY_MESSAGE_V1));
}

// ----------------------------------------------------------------------------------------------
// Scope, permissions, nullifier
// ----------------------------------------------------------------------------------------------

/**
 * Service scope (uint256) from a human-readable service string: keccak256 of its UTF-8 bytes.
 * This is exactly how the backend e2e derives it (`keccak256(toUtf8Bytes('service:...'))`); the
 * string is used verbatim (no trimming or case folding), so services must agree on the exact text.
 */
export function deriveScope(service) {
  if (typeof service !== 'string' || service.length === 0) throw new Error('scope: service string is required');
  return hexToBigInt(keccak256(toBytes(service)));
}

/** bytes32 permissions value from permission keys (see PERMISSIONS in constants.js). */
export function permissionsToBytes32(keys) {
  let value = 0n;
  for (const key of keys) {
    const p = PERMISSIONS[key];
    if (!p) throw new Error(`unknown permission: ${key}`);
    value |= 1n << BigInt(p.bit);
  }
  return pad(toHex(value), { size: 32 });
}

/** Inverse of {@link permissionsToBytes32}: `{ keys, unknownBits }` (bits outside the convention). */
export function bytes32ToPermissions(bytes32) {
  const value = hexToBigInt(bytes32);
  const keys = PERMISSION_KEYS.filter((k) => (value >> BigInt(PERMISSIONS[k].bit)) & 1n);
  const known = keys.reduce((acc, k) => acc | (1n << BigInt(PERMISSIONS[k].bit)), 0n);
  return { keys, unknownBits: value & ~known };
}

/** Semaphore v4 hashes `scope` before feeding the circuit: keccak256(uint256) >> 8. */
export function hashToField(value) {
  return hexToBigInt(keccak256(pad(toHex(BigInt(value)), { size: 32 }))) >> 8n;
}

/**
 * The holder's per-scope nullifier. Semaphore v4 circuit: `nullifier = Poseidon2(hash(scope), secretScalar)`
 * where `hash(scope) = keccak256(scope) >> 8` (verified against `generateProof`'s public signal in
 * test/semaphore.test.js and in the integration script). Lets the UI read nonces and agents without
 * generating a proof first.
 */
export function computeNullifier(identity, scope) {
  return poseidon2([hashToField(scope), identity.secretScalar]);
}

// ----------------------------------------------------------------------------------------------
// Group reconstruction from on-chain events
// ----------------------------------------------------------------------------------------------

export class GroupOutOfSyncError extends Error {
  constructor(local, onChain) {
    super(`group_out_of_sync: local root ${local} != on-chain root ${onChain}`);
    this.name = 'GroupOutOfSyncError';
  }
}

/**
 * Apply Semaphore group events in chain order and return the resulting Group. Pure function:
 * `events` are `{ eventName, args }` already sorted by (blockNumber, logIndex).
 * Semaphore v4 removal sets the leaf to 0 (the index is kept), exactly like `Group#removeMember`.
 */
export function replayGroupEvents(events) {
  const group = new Group();
  for (const { eventName, args } of events) {
    switch (eventName) {
      case 'MemberAdded':
        group.addMember(args.identityCommitment);
        break;
      case 'MembersAdded':
        group.addMembers([...args.identityCommitments]);
        break;
      case 'MemberUpdated':
        group.updateMember(Number(args.index), args.newIdentityCommitment);
        break;
      case 'MemberRemoved':
        group.removeMember(Number(args.index));
        break;
      default:
        throw new Error(`unexpected group event: ${eventName}`);
    }
  }
  return group;
}

/** Resolve the Semaphore contract (config override, else the issuer's `semaphore()`) and group id. */
export async function resolveGroup(client, cfg) {
  const issuer = getAddress(cfg.issuer);
  const [groupId, semaphore] = await Promise.all([
    client.readContract({ address: issuer, abi: issuerAbi, functionName: 'groupId' }),
    cfg.semaphore
      ? getAddress(cfg.semaphore)
      : client.readContract({ address: issuer, abi: issuerAbi, functionName: 'semaphore' }),
  ]);
  return { groupId, semaphore };
}

async function getLogsChunked(client, params, fromBlock, toBlock, chunk) {
  if (!chunk || chunk <= 0) return client.getLogs({ ...params, fromBlock, toBlock });
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += BigInt(chunk)) {
    const to = from + BigInt(chunk) - 1n < toBlock ? from + BigInt(chunk) - 1n : toBlock;
    out.push(...(await client.getLogs({ ...params, fromBlock: from, toBlock: to })));
  }
  return out;
}

/**
 * Rebuild the issuer's Semaphore group from MemberAdded / MembersAdded / MemberUpdated /
 * MemberRemoved events and check the result against the contract's current Merkle root.
 * (`@semaphore-protocol/data` would do the same through a subgraph/RPC wrapper; reading the events
 * directly keeps the dependency set small and works against any RPC, including a local anvil.)
 *
 * Public RPCs often cap `eth_getLogs` ranges: set `cfg.startBlock` to the issuer's deployment block
 * and `cfg.logChunkBlocks` to the provider's maximum range.
 *
 * @returns {Promise<{ group: Group, groupId: bigint, semaphore: string, root: bigint }>}
 * @throws {GroupOutOfSyncError} if the rebuilt root differs from the on-chain root
 */
export async function fetchGroup(client, cfg) {
  const { groupId, semaphore } = await resolveGroup(client, cfg);
  const toBlock = await client.getBlockNumber();
  const fromBlock = BigInt(cfg.startBlock ?? 0);

  const eventNames = ['MemberAdded', 'MembersAdded', 'MemberUpdated', 'MemberRemoved'];
  const perEvent = await Promise.all(
    eventNames.map((name) =>
      getLogsChunked(
        client,
        { address: semaphore, event: semaphoreAbi.find((i) => i.type === 'event' && i.name === name), args: { groupId } },
        fromBlock,
        toBlock,
        cfg.logChunkBlocks,
      ),
    ),
  );
  const logs = perEvent.flat().sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
  const group = replayGroupEvents(logs);

  const root = await client.readContract({ address: semaphore, abi: semaphoreAbi, functionName: 'getMerkleTreeRoot', args: [groupId] });
  if (BigInt(group.root) !== root) throw new GroupOutOfSyncError(group.root, root);
  return { group, groupId, semaphore, root };
}

/** Is `commitment` currently a member of the issuer's group? */
export function isMember(client, cfg, commitment) {
  return client.readContract({ address: getAddress(cfg.issuer), abi: issuerAbi, functionName: 'isMember', args: [BigInt(commitment)] });
}

// ----------------------------------------------------------------------------------------------
// Registry reads
// ----------------------------------------------------------------------------------------------

const registryRead = (client, cfg, functionName, args = []) =>
  client.readContract({ address: getAddress(cfg.registry), abi: registryAbi, functionName, args });

/** `{ maxTtl, maxActiveDelegations }` from the registry (maxTtl in seconds). */
export async function readRegistryLimits(client, cfg) {
  const [maxTtl, maxActive] = await Promise.all([registryRead(client, cfg, 'maxTtl'), registryRead(client, cfg, 'maxActiveDelegations')]);
  return { maxTtl: Number(maxTtl), maxActiveDelegations: Number(maxActive) };
}

export const readNonce = (client, cfg, nullifier) => registryRead(client, cfg, 'nonces', [BigInt(nullifier)]);

export const delegationMessage = (client, cfg, { agent, expiry, permissions, erc8004Id = 0n, nonce }) =>
  registryRead(client, cfg, 'delegationMessage', [getAddress(agent), BigInt(expiry), permissions, BigInt(erc8004Id), BigInt(nonce)]);

export const revocationMessage = (client, cfg, { agent, nonce }) =>
  registryRead(client, cfg, 'revocationMessage', [getAddress(agent), BigInt(nonce)]);

/**
 * Active agents of (scope, nullifier) with their delegation data.
 * @returns {Promise<Array<{ agent: string, active: boolean, permissions: string, expiry: number, erc8004Id: bigint }>>}
 */
export async function listDelegations(client, cfg, scope, nullifier) {
  const agents = await registryRead(client, cfg, 'activeAgents', [BigInt(scope), BigInt(nullifier)]);
  const rows = await Promise.all(
    agents.map(async (agent) => {
      const [active, , permissions, expiry, erc8004Id] = await registryRead(client, cfg, 'getDelegation', [BigInt(scope), agent]);
      return { agent, active, permissions, expiry: Number(expiry), erc8004Id };
    }),
  );
  return rows;
}

/**
 * Largest TTL the UI offers: the contract's `maxTtl` minus a safety margin so the expiry is still
 * valid by the time the proof is generated and the relayer's transaction is mined.
 */
export function maxOfferedTtl(maxTtl) {
  return Math.max(MIN_TTL_SECONDS, Number(maxTtl) - TTL_MARGIN_SECONDS);
}

// ----------------------------------------------------------------------------------------------
// Proving
// ----------------------------------------------------------------------------------------------

/**
 * Circuit artifacts for a tree depth, served from `baseUrl` (e.g. '/semaphore' => files fetched
 * by `npm run artifacts`, or the PSE CDN). Returns `{ wasm, zkey }` URLs/paths accepted by snarkjs.
 */
export function artifactsFrom(baseUrl, version = '4.0.0') {
  const base = baseUrl.replace(/\/$/, '');
  return (depth) => ({ wasm: `${base}/semaphore-${depth}.wasm`, zkey: `${base}/semaphore-${depth}.zkey` });
}

/** CDN fallback used by @semaphore-protocol/proof when no artifacts are given (documented in the README). */
export const PSE_ARTIFACTS_URL = 'https://snark-artifacts.pse.dev/semaphore/4.0.0';

/** Tree depth the circuit must be compiled for: Merkle path length of the holder's leaf (min 1). */
export function proofDepth(group, identity) {
  const index = group.indexOf(identity.commitment);
  if (index < 0) throw new Error('not_a_member: the identity commitment is not in the group');
  return Math.max(1, group.generateMerkleProof(index).siblings.length);
}

/**
 * Generate the Groth16 proof in this process (browser or Node).
 * @param {object} p
 * @param {(depth:number)=>{wasm:string,zkey:string}} [p.artifacts] resolver; omitted = library default (PSE CDN)
 */
export async function proveMessage({ identity, group, message, scope, artifacts }) {
  const depth = proofDepth(group, identity);
  // Loaded lazily: snarkjs is large and only needed when a proof is actually generated.
  const { generateProof } = await import('@semaphore-protocol/proof');
  return generateProof(identity, group, BigInt(message), BigInt(scope), depth, artifacts?.(depth));
}

// ----------------------------------------------------------------------------------------------
// High-level flows (used by the UI and by the integration script)
// ----------------------------------------------------------------------------------------------

/**
 * Delegate the holder's credential to `agent` for `service`.
 *
 * Steps: rebuild the group, read the per-nullifier nonce, derive the message from the contract,
 * prove in-process, hand the proof to `relay` (the backend relayer submits the transaction so the
 * holder's wallet never touches the registry).
 *
 * @param {object} p
 * @param {import('viem').PublicClient} p.client
 * @param {object} p.cfg
 * @param {Identity} p.identity
 * @param {string} p.service         service string (hashed to the scope)
 * @param {string} p.agent           agent address
 * @param {number} p.ttlSeconds      lifetime; must be <= registry maxTtl
 * @param {string[]} p.permissionKeys keys of PERMISSIONS
 * @param {bigint} [p.erc8004Id]
 * @param {(args:object)=>Promise<object>} p.relay   `({ proof, agent, expiry, permissions, erc8004Id }) => { txHash }`
 * @param {(depth:number)=>{wasm:string,zkey:string}} [p.artifacts]
 * @param {(stage:'syncing-group'|'proving'|'relaying', info?:object)=>void} [p.onProgress]
 */
export async function createDelegation({ client, cfg, identity, service, agent, ttlSeconds, permissionKeys, erc8004Id = 0n, relay, artifacts, onProgress = () => {} }) {
  const agentAddress = getAddress(agent);
  const scope = deriveScope(service);
  const { maxTtl } = await readRegistryLimits(client, cfg);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS) throw new Error('ttl_too_short');
  if (ttlSeconds > maxTtl) throw new Error('ttl_exceeds_max');

  onProgress('syncing-group');
  const { group } = await fetchGroup(client, cfg);
  const nullifier = computeNullifier(identity, scope);
  const nonce = await readNonce(client, cfg, nullifier);

  // Expiry is relative to the CHAIN clock (the contract compares against block.timestamp).
  const block = await client.getBlock();
  const expiry = block.timestamp + BigInt(ttlSeconds);
  const permissions = permissionsToBytes32(permissionKeys);
  const message = await delegationMessage(client, cfg, { agent: agentAddress, expiry, permissions, erc8004Id, nonce });

  onProgress('proving', { depth: proofDepth(group, identity), members: group.members.length });
  const proof = await proveMessage({ identity, group, message, scope, artifacts });
  if (BigInt(proof.nullifier) !== nullifier) throw new Error('nullifier_mismatch: local nullifier formula disagrees with the circuit');

  onProgress('relaying');
  const receipt = await relay({ proof, agent: agentAddress, expiry, permissions, erc8004Id });
  return { receipt, scope, nullifier, expiry, permissions, proof };
}

/** Revoke the delegation of `agent` in `service`'s scope through the relayer. Same shape as {@link createDelegation}. */
export async function revokeDelegation({ client, cfg, identity, service, agent, relay, artifacts, onProgress = () => {} }) {
  const agentAddress = getAddress(agent);
  const scope = deriveScope(service);

  onProgress('syncing-group');
  const { group } = await fetchGroup(client, cfg);
  const nullifier = computeNullifier(identity, scope);
  const nonce = await readNonce(client, cfg, nullifier);
  const message = await revocationMessage(client, cfg, { agent: agentAddress, nonce });

  onProgress('proving', { depth: proofDepth(group, identity), members: group.members.length });
  const proof = await proveMessage({ identity, group, message, scope, artifacts });

  onProgress('relaying');
  const receipt = await relay({ proof, agent: agentAddress });
  return { receipt, scope, nullifier, proof };
}
