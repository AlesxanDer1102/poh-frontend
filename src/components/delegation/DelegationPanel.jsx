import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { isAddress } from 'viem';
import { appConfig, delegationConfigured } from '../../config.js';
import { useHolderIdentity } from '../../context/HolderIdentity.jsx';
import { MIN_TTL_SECONDS } from '../../lib/constants.js';
import {
  computeNullifier,
  createDelegation,
  deriveScope,
  isMember,
  listDelegations,
  maxOfferedTtl,
  readRegistryLimits,
  revokeDelegation,
} from '../../lib/semaphore.js';
import { relayDelegate, relayRevoke } from '../../lib/relayerClient.js';
import { DelegationForm } from './DelegationForm.jsx';
import { DelegationList } from './DelegationList.jsx';

/** User-facing text for relayer rejections (decoded DelegationRegistry custom errors) and local errors. */
const ERROR_MESSAGES = {
  InvalidMessage: 'The delegation state changed while the proof was generated. Try again.',
  InvalidProof: 'The proof was rejected by the contract. Reload the page and try again.',
  ExpiryTooFar: 'The expiry exceeds the maximum lifetime allowed by the registry.',
  ExpiryInPast: 'The expiry is already in the past.',
  CapReached: 'You reached the maximum number of active agents for this service. Revoke one first.',
  AgentAlreadyDelegated: 'This agent is already delegated by another holder in this scope.',
  NotDelegated: 'That agent has no delegation in this scope.',
  AlreadyRevoked: 'That delegation is already revoked.',
  NullifierMismatch: 'That delegation belongs to a different holder.',
  ZeroAddress: 'The agent address cannot be the zero address.',
  rate_limited: 'Too many requests from your network. Please wait a minute and try again.',
  relayer_not_configured: 'The backend relayer is not configured.',
  group_out_of_sync: 'The group changed while it was being read. Try again.',
  not_a_member: 'Your identity is not in the humanity group yet. Complete the verification first.',
  ttl_exceeds_max: 'The expiry exceeds the maximum lifetime allowed by the registry.',
  signature_rejected: 'You rejected the signature request in your wallet.',
};

const STAGES = {
  'syncing-group': 'Reading the humanity group from the chain…',
  proving: 'Generating the zero-knowledge proof in your browser…',
  relaying: 'Submitting through the relayer (your wallet is not used)…',
};

function describe(err) {
  const rejected = err?.name === 'UserRejectedRequestError' || err?.cause?.name === 'UserRejectedRequestError';
  const code = rejected ? 'signature_rejected' : err?.status === 429 ? 'rate_limited' : err?.data?.reason ?? err?.code ?? '';
  const key = Object.keys(ERROR_MESSAGES).find((k) => code === k || String(err?.message ?? '').startsWith(k));
  return key ? ERROR_MESSAGES[key] : err?.shortMessage ?? err?.message ?? 'Something went wrong.';
}

/**
 * Container: delegation of the holder's credential to AI agents. All chain/proof logic lives in
 * src/lib/semaphore.js; the identity secret stays in memory (HolderIdentityProvider) and only the
 * proof is sent to the relayer.
 */
export function DelegationPanel() {
  const { isConnected } = useAccount();
  const client = usePublicClient();
  const { identity, unlock, deriving } = useHolderIdentity();

  const [limits, setLimits] = useState(null);
  const [member, setMember] = useState(null); // null = unknown
  const [values, setValues] = useState({ service: '', agent: '', ttlHours: '24', permissions: ['READ'] });
  const [errors, setErrors] = useState({});
  const [stage, setStage] = useState(null);
  const [busyAgent, setBusyAgent] = useState(null);
  const [status, setStatus] = useState(null); // { kind: 'ok'|'error', text, txHash? }
  const [listing, setListing] = useState({ delegations: [], nullifier: null, service: null });

  const busy = stage !== null;
  const maxTtlHours = limits ? Math.floor(maxOfferedTtl(limits.maxTtl) / 3600) : 24;

  useEffect(() => {
    if (!isConnected || !delegationConfigured) return;
    readRegistryLimits(client, appConfig.chain).then(setLimits).catch((e) => setStatus({ kind: 'error', text: describe(e) }));
  }, [client, isConnected]);

  useEffect(() => {
    setMember(null);
    if (!identity) return;
    isMember(client, appConfig.chain, identity.commitment).then(setMember).catch(() => setMember(null));
  }, [client, identity]);

  const refresh = useCallback(
    async (service = values.service) => {
      if (!identity || !service) return;
      const scope = deriveScope(service);
      const nullifier = computeNullifier(identity, scope);
      const delegations = await listDelegations(client, appConfig.chain, scope, nullifier);
      setListing({ delegations, nullifier: nullifier.toString(), service });
    },
    [client, identity, values.service],
  );

  const validate = useMemo(
    () => () => {
      const e = {};
      if (!values.service) e.service = 'Enter the service scope.';
      else if (values.service !== values.service.trim()) e.service = 'Remove leading/trailing spaces: the text is hashed verbatim.';
      if (!isAddress(values.agent)) e.agent = 'Enter a valid agent address.';
      if (values.permissions.length === 0) e.permissions = 'Select at least one permission.';
      const hours = Number(values.ttlHours);
      if (!Number.isInteger(hours) || hours * 3600 < MIN_TTL_SECONDS || hours > maxTtlHours) e.ttlHours = `Enter a whole number of hours between 1 and ${maxTtlHours}.`;
      return e;
    },
    [values, maxTtlHours],
  );

  async function onDelegate() {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    setStatus(null);
    try {
      const { receipt } = await createDelegation({
        client,
        cfg: appConfig.chain,
        identity,
        service: values.service,
        agent: values.agent,
        ttlSeconds: Number(values.ttlHours) * 3600,
        permissionKeys: values.permissions,
        relay: (args) => relayDelegate(appConfig.apiUrl, args),
        artifacts: appConfig.artifacts,
        onProgress: setStage,
      });
      setStatus({ kind: 'ok', text: 'Delegation registered.', txHash: receipt.txHash });
      await refresh();
    } catch (err) {
      setStatus({ kind: 'error', text: describe(err) });
    } finally {
      setStage(null);
    }
  }

  async function onRevoke(agent) {
    setStatus(null);
    setBusyAgent(agent);
    try {
      const { receipt } = await revokeDelegation({
        client,
        cfg: appConfig.chain,
        identity,
        service: listing.service ?? values.service,
        agent,
        relay: (args) => relayRevoke(appConfig.apiUrl, args),
        artifacts: appConfig.artifacts,
        onProgress: setStage,
      });
      setStatus({ kind: 'ok', text: 'Delegation revoked.', txHash: receipt.txHash });
      await refresh(listing.service ?? values.service);
    } catch (err) {
      setStatus({ kind: 'error', text: describe(err) });
    } finally {
      setStage(null);
      setBusyAgent(null);
    }
  }

  async function onUnlock() {
    setStatus(null);
    try {
      await unlock();
    } catch (err) {
      setStatus({ kind: 'error', text: describe(err) });
    }
  }

  if (!isConnected) return null;

  let body;
  if (!delegationConfigured) {
    body = <div className="field__hint">Delegation is not configured: set VITE_HUMANITY_ISSUER_ADDRESS and VITE_DELEGATION_REGISTRY_ADDRESS.</div>;
  } else if (!identity) {
    body = (
      <div className="stack">
        <div className="field__hint">Unlock your holder identity with a wallet signature. It is derived locally, kept in memory only and never sent to any server.</div>
        <button className="btn btn--primary btn--block" onClick={onUnlock} disabled={deriving}>
          {deriving ? 'Waiting for your wallet…' : 'Unlock holder identity'}
        </button>
      </div>
    );
  } else if (member === false) {
    body = <div className="field__hint">This wallet's holder identity is not in the humanity group yet. Complete the face verification above first.</div>;
  } else {
    body = (
      <div className="stack">
        <DelegationForm values={values} onChange={(patch) => setValues((v) => ({ ...v, ...patch }))} onSubmit={onDelegate} busy={busy} maxTtlHours={maxTtlHours} errors={errors} />
        {values.service && listing.service !== values.service && (
          <button className="btn btn--ghost btn--sm" onClick={() => refresh().catch((e) => setStatus({ kind: 'error', text: describe(e) }))} disabled={busy}>
            Show active agents for this service
          </button>
        )}
        {listing.service && (
          <>
            <hr className="divider" />
            <DelegationList
              delegations={listing.delegations}
              nullifier={listing.nullifier}
              busyAgent={busyAgent}
              disabled={busy}
              onRevoke={onRevoke}
              onRefresh={() => refresh(listing.service).catch((e) => setStatus({ kind: 'error', text: describe(e) }))}
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="card__title">Delegate to an AI agent</h2>
      <p className="card__hint">
        Authorize an agent address to act for you in a service without revealing who you are. The proof is generated in your browser and submitted by a relayer, so your wallet
        address is never linked to the delegation on-chain.
      </p>
      {body}
      {busy && (
        <span className="pill pill--info pill--busy mt-1">
          <span className="pill__dot" />
          {STAGES[stage]}
        </span>
      )}
      {status && (
        <div className={`result ${status.kind === 'ok' ? 'result--ok' : 'result--error'} mt-1`}>
          <div className="result__head">
            <div className="result__icon">{status.kind === 'ok' ? '✓' : '✕'}</div>
            <div>
              <div className="result__title">{status.text}</div>
              {status.txHash && <div className="result__subtitle">Relayer transaction: <code>{status.txHash}</code></div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
