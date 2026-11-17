// Integration check of the frontend logic (src/lib/semaphore.js, src/lib/relayerClient.js) against a
// LOCAL anvil chain and the real poh-backend app (semaphore mode + relayer). Not part of `npm test`.
//
//   1. anvil                                         (terminal 1)
//   2. cd ../poh-contracts && npm run deploy:local   (writes deployments/local.json)
//   3. cd ../poh-frontend  && npm run artifacts      (circuit artifacts, once)
//   4. npm run e2e
//
// The SAME functions the UI calls are used here: identity derivation from a wallet signature,
// admission through POST /api/validate, group reconstruction from events, in-process Groth16
// proving, submission through the relayer (POST /api/relay/*), registry reads.
// Stubbed: the Postgres biometric registry (in-memory stand-in) and the camera (synthetic descriptors).
// NOT covered: the React UI and in-browser proving (see README "Browser proving").
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createPublicClient, http, getAddress } from 'viem';
import { foundry } from 'viem/chains';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import {
  computeNullifier,
  createDelegation,
  deriveScope,
  fetchGroup,
  isMember,
  listDelegations,
  permissionsToBytes32,
  readRegistryLimits,
  revokeDelegation,
  unlockIdentity,
} from '../src/lib/semaphore.js';
import { relayDelegate, relayRevoke } from '../src/lib/relayerClient.js';

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(process.env.BACKEND_DIR ?? resolve(here, '../../poh-backend'));
const deployment = JSON.parse(readFileSync(process.env.DEPLOYMENT_FILE ?? resolve(here, '../../poh-contracts/deployments/local.json'), 'utf8'));
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';

// Anvil default accounts (public mnemonic): 1..3 validators (registered by DeployLocal.s.sol),
// 4 = relayer, 5 = the human holder's wallet.
const mnemonic = 'test test test test test test test test test test test junk';
const anvilAccount = (i) => mnemonicToAccount(mnemonic, { addressIndex: i });
const anvilKey = (i) => `0x${Buffer.from(anvilAccount(i).getHdKey().privateKey).toString('hex')}`;
const holderWallet = anvilAccount(5);
const relayerAccount = anvilAccount(4);

Object.assign(process.env, {
  NODE_ENV: 'test',
  ISSUANCE_MODE: 'semaphore',
  RPC_URL,
  HUMANITY_ISSUER_ADDRESS: deployment.humanityIssuer,
  DELEGATION_REGISTRY_ADDRESS: deployment.delegationRegistry,
  VALIDATOR_PRIVATE_KEYS: [1, 2, 3].map(anvilKey).join(','),
  RELAYER_PRIVATE_KEY: anvilKey(4),
  SIWE_CHAIN_ID: String(deployment.chainId),
});
const backend = (p) => import(pathToFileURL(resolve(backendDir, p)).href);
const { config } = await backend('src/config.js');
const { createApp } = await backend('src/app.js');
const { NonceStore } = await backend('src/services/nonceStore.js');
const { AttemptLimiter } = await backend('src/services/attempts.js');
const { findNearest } = await backend('src/services/identity.js');
const { createSemaphoreChainFromConfig } = await backend('src/services/semaphoreChain.js');
const { createRelayerFromConfig } = await backend('src/services/relayer.js');

// ---- in-memory biometric registry (same uniqueness semantics as the Postgres one) ---------------
const humans = [];
const identityService = {
  async registerExclusive({ commitment, template, register }) {
    if (humans.some((h) => h.commitment === commitment)) return { status: 'already_registered' };
    const { match, nearestDistance, registrySize } = findNearest(template, humans, config.faceMatchThreshold);
    if (match) return { status: 'duplicate_human', nearestDistance, registrySize, matchingMs: 0 };
    const result = await register(null);
    humans.push({ commitment, template });
    return { status: 'registered', humanityHash: null, result, nearestDistance, registrySize, matchingMs: 0 };
  },
};

const relayer = createRelayerFromConfig(config);
assert.ok(relayer, 'relayer must be configured');
const app = createApp({
  config,
  chainConfigured: () => true,
  dbReady: () => true,
  logger: false,
  nonceStore: new NonceStore({ ttlMs: config.siwe.nonceTtlMs }),
  agentNonceStore: new NonceStore({ ttlMs: config.siwe.nonceTtlMs }),
  attemptLimiter: new AttemptLimiter(config.attempts),
  identity: identityService,
  chain: {},
  semaphoreChain: createSemaphoreChainFromConfig(config),
  validations: { record: async () => {}, summary: async () => ({}) },
  relayer,
});
const server = await new Promise((res) => {
  const s = app.listen(0, '127.0.0.1', () => res(s));
});
const apiUrl = `http://127.0.0.1:${server.address().port}`;
const post = async (path, body) => {
  const res = await fetch(apiUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

const client = createPublicClient({ chain: foundry, transport: http(RPC_URL) });
const cfg = { issuer: deployment.humanityIssuer, registry: deployment.delegationRegistry };
// Circuit artifacts downloaded by `npm run artifacts` (local files, no CDN).
const artifactDir = resolve(here, '../public/semaphore');
const artifacts = (depth) => ({ wasm: `${artifactDir}/semaphore-${depth}.wasm`, zkey: `${artifactDir}/semaphore-${depth}.zkey` });

const step = (msg) => console.log(`[e2e] ${msg}`);
const timed = async (label, fn) => {
  const t0 = Date.now();
  const out = await fn();
  step(`${label}: ${Date.now() - t0} ms`);
  return out;
};
const sign = (message) => holderWallet.signMessage({ message });

let failed = false;
try {
  // ---- 1. Identity from a wallet signature (deterministic, nothing stored) ------------------------
  const identity = await unlockIdentity(sign);
  const again = await unlockIdentity(sign);
  assert.equal(identity.commitment, again.commitment, 'identity derivation must be deterministic');
  const commitment = identity.commitment.toString();
  step(`identity derived deterministically, commitment ${commitment.slice(0, 12)}...`);

  // ---- 2. Issuance through POST /api/validate (what ValidationFlow sends) ------------------------
  assert.equal(await isMember(client, cfg, commitment), false);
  const face = Array.from({ length: 128 }, () => Math.random() - 0.5);
  const ch = await post('/api/auth/challenge', { address: holderWallet.address });
  assert.equal(ch.status, 200);
  await new Promise((r) => setTimeout(r, ch.body.liveness.minDurationMs + 200));
  const samples = [0, 1, 2].map((i) => ({ descriptor: face.map((x) => x + (Math.random() - 0.5) * 0.01), t: 400 * (i + 1) }));
  const validate = await post('/api/validate', {
    address: holderWallet.address,
    message: ch.body.message,
    signature: await sign(ch.body.message),
    nonce: ch.body.nonce,
    samples,
    identityCommitment: commitment,
  });
  assert.equal(validate.status, 201, JSON.stringify(validate.body));
  assert.equal(validate.body.admitted, true);
  assert.equal(await isMember(client, cfg, commitment), true);
  step(`admitted by ${validate.body.approvals} validators (${validate.body.metrics.confirmationMs} ms on-chain)`);

  // ---- 3. Group from on-chain events -------------------------------------------------------------
  const { group, root } = await fetchGroup(client, cfg);
  assert.ok(group.members.includes(identity.commitment));
  assert.equal(BigInt(group.root), root);
  step(`group rebuilt from events: ${group.members.length} member(s), root matches the contract`);

  // ---- 4. Delegate through the relayer ------------------------------------------------------------
  const service = 'service:e2e.example.org';
  const scope = deriveScope(service);
  const agent = getAddress(privateKeyToAccount(generatePrivateKey()).address);
  const permissionKeys = ['READ', 'WRITE'];
  const limits = await readRegistryLimits(client, cfg);
  assert.equal(limits.maxTtl, 30 * 24 * 3600);

  await assert.rejects(
    createDelegation({ client, cfg, identity, service, agent, ttlSeconds: limits.maxTtl + 1, permissionKeys, relay: async () => assert.fail('must not relay'), artifacts }),
    /ttl_exceeds_max/,
  );

  const stages = [];
  const delegated = await timed('delegation (group sync + proof + relay)', () =>
    createDelegation({
      client,
      cfg,
      identity,
      service,
      agent,
      ttlSeconds: 24 * 3600,
      permissionKeys,
      relay: (args) => relayDelegate(apiUrl, args),
      artifacts,
      onProgress: (s, info) => stages.push(info ? `${s}${JSON.stringify(info)}` : s),
    }),
  );
  step(`stages: ${stages.join(' -> ')}`);
  assert.equal(delegated.nullifier, computeNullifier(identity, scope));
  assert.equal(BigInt(delegated.proof.nullifier), delegated.nullifier, 'local nullifier formula == circuit public signal');

  const registryAbi = [
    {
      type: 'function',
      name: 'getDelegation',
      stateMutability: 'view',
      inputs: [{ name: 'scope', type: 'uint256' }, { name: 'agent', type: 'address' }],
      outputs: [{ type: 'bool' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'uint256' }],
    },
  ];
  const [active, nu, perms, expiry] = await client.readContract({ address: deployment.delegationRegistry, abi: registryAbi, functionName: 'getDelegation', args: [scope, agent] });
  assert.equal(active, true);
  assert.equal(nu, delegated.nullifier);
  assert.equal(perms, permissionsToBytes32(permissionKeys));
  assert.equal(expiry, delegated.expiry);

  // Privacy: the delegate tx was sent by the relayer, never by the holder wallet.
  const tx = await client.getTransaction({ hash: delegated.receipt.txHash });
  assert.equal(tx.from.toLowerCase(), relayerAccount.address.toLowerCase(), 'delegate tx must come from the relayer');
  assert.notEqual(tx.from.toLowerCase(), holderWallet.address.toLowerCase());
  step('getDelegation active=true; tx sender is the relayer, not the holder wallet');

  const listed = await listDelegations(client, cfg, scope, delegated.nullifier);
  assert.deepEqual(listed.map((d) => d.agent), [agent]);
  assert.equal(listed[0].permissions, perms);

  // The relayer refuses a proof whose message does not match the request (simulation reverts, no gas spent).
  const tampered = await post('/api/relay/delegate', {
    proof: { ...delegated.proof, points: delegated.proof.points.map(String), merkleTreeRoot: String(delegated.proof.merkleTreeRoot), nullifier: String(delegated.proof.nullifier), message: String(delegated.proof.message), scope: String(delegated.proof.scope) },
    agent,
    expiry: String(delegated.expiry),
    permissions: permissionsToBytes32(['READ', 'WRITE', 'TRANSACT']),
  });
  assert.equal(tampered.status, 422, JSON.stringify(tampered.body));
  step(`relayer rejects a tampered request: ${tampered.body.reason}`);

  // ---- 5. Revoke through the relayer ----------------------------------------------------------------
  const revoked = await timed('revocation (group sync + proof + relay)', () =>
    revokeDelegation({ client, cfg, identity, service, agent, relay: (args) => relayRevoke(apiUrl, args), artifacts }),
  );
  const after = await client.readContract({ address: deployment.delegationRegistry, abi: registryAbi, functionName: 'getDelegation', args: [scope, agent] });
  assert.equal(after[0], false, 'delegation must be inactive after revoke');
  assert.deepEqual(await listDelegations(client, cfg, scope, delegated.nullifier), []);
  const rtx = await client.getTransaction({ hash: revoked.receipt.txHash });
  assert.equal(rtx.from.toLowerCase(), relayerAccount.address.toLowerCase());
  step('revoke relayed -> getDelegation active=false, active list empty');

  console.log('[e2e] PASS');
} catch (err) {
  failed = true;
  console.error('[e2e] FAIL', err);
} finally {
  await new Promise((r) => server.close(r));
  process.exit(failed ? 1 : 0);
}
