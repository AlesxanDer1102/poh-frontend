import { useRef, useState } from 'react';
import { useAccount, usePublicClient, useSignMessage } from 'wagmi';
import { FaceCapture } from './FaceCapture.jsx';
import { requestChallenge, validate, verify } from '../api.js';
import { appConfig } from '../config.js';
import { useHolderIdentity } from '../context/HolderIdentity.jsx';
import { useIssuanceMode } from '../hooks/useIssuanceMode.js';
import { isMember } from '../lib/semaphore.js';

const EXPLORER = appConfig.explorerUrl;
const explorerLink = (kind, value) => (EXPLORER && value ? `${EXPLORER}/${kind}/${value}` : undefined);

/** User-facing text for backend error codes (`error` field). */
const ERROR_MESSAGES = {
  rate_limited: 'Too many requests from your network. Please wait a minute and try again.',
  nonce_expired: 'The challenge expired. Press Restart to begin a new verification.',
  nonce_invalid: 'This challenge was already used or is unknown. Press Restart to begin a new verification.',
  message_mismatch: 'The signed message does not match the challenge. Press Restart to try again.',
  invalid_signature: 'The wallet signature could not be verified for this address.',
  duplicate_human: 'This person is already registered under a different wallet. One human can hold only one proof.',
  already_registered: 'This wallet or identity already holds a humanity proof.',
  invalid_commitment: 'The holder identity commitment was rejected by the server. Reload the page and try again.',
  db_unavailable: 'The backend database is unavailable. Try again later.',
  signature_rejected: 'You rejected the signature request in your wallet.',
};

/** User-facing text for `validation_failed` reasons. */
const REASON_MESSAGES = {
  inconsistent_samples:
    'The face captured during the challenge was not consistent. Keep the same face in frame and try again.',
  samples_count_out_of_range: 'Not enough face samples were captured. Please try again.',
  invalid_descriptor: 'The face data was malformed. Please try again.',
  descriptor_out_of_range: 'The face data was malformed. Please try again.',
  invalid_timestamps: 'The challenge timing was invalid. Please try again.',
  timestamps_out_of_window: 'The challenge was completed too fast or too slowly. Please try again.',
  invalid_samples: 'The face data was malformed. Please try again.',
};

/** Normalise any thrown error into the { error, reason } shape ErrorCard renders. */
function describeError(err) {
  const data = err.data ?? {};
  const rejected = err.name === 'UserRejectedRequestError' || err.cause?.name === 'UserRejectedRequestError';
  const code = rejected ? 'signature_rejected' : data.error ?? err.message ?? 'error';

  let reason;
  if (code === 'validation_failed') {
    reason = REASON_MESSAGES[data.reason] ?? data.reason;
  } else if (code === 'too_many_attempts') {
    const minutes = Math.max(1, Math.ceil((data.retryAfterSec ?? 60) / 60));
    reason = `Too many failed attempts for this address. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  } else {
    reason = ERROR_MESSAGES[code] ?? data.reason ?? err.shortMessage ?? err.message;
  }
  return { error: code, reason };
}

function truncate(value, head = 10, tail = 8) {
  if (!value || value.length <= head + tail) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Mono key/value row with a copy button. */
function CopyRow({ label, value, href }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="kv">
      <span className="kv__key">{label}</span>
      <span className="kv__val">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            <span>{truncate(value)}</span>
          </a>
        ) : (
          <span>{truncate(value)}</span>
        )}
        <button className="icon-btn" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? '✓' : '⧉'}
        </button>
      </span>
    </div>
  );
}

function Metrics({ metrics }) {
  if (!metrics) return null;
  const tiles = [
    { label: 'Off-chain validation', value: metrics.validationMs != null ? `${metrics.validationMs} ms` : '—' },
    { label: 'On-chain confirmation', value: metrics.confirmationMs != null ? `${metrics.confirmationMs} ms` : '—' },
    { label: 'Gas used', value: metrics.gasUsed != null ? Number(metrics.gasUsed).toLocaleString() : '—' },
  ];
  return (
    <div className="metrics">
      {tiles.map((t) => (
        <div className="metric" key={t.label}>
          <div className="metric__value">{t.value}</div>
          <div className="metric__label">{t.label}</div>
        </div>
      ))}
    </div>
  );
}

function ResultCard({ result }) {
  // Semaphore membership check (see checkStatus)
  if ('member' in result) {
    return result.member ? (
      <div className="result result--ok">
        <div className="result__head">
          <div className="result__icon">✓</div>
          <div>
            <div className="result__title">Verified human</div>
            <div className="result__subtitle">Your holder identity is a member of the humanity group.</div>
          </div>
        </div>
        <div className="result__body">
          <CopyRow label="Identity commitment" value={result.commitment} />
        </div>
      </div>
    ) : (
      <div className="result result--warn">
        <div className="result__head">
          <div className="result__icon">!</div>
          <div>
            <div className="result__title">Not a member yet</div>
            <div className="result__subtitle">This wallet's holder identity has not been admitted. Complete the verification above.</div>
          </div>
        </div>
      </div>
    );
  }

  // Semaphore validate() response shape: the identity commitment was sent to the validators.
  if ('identityCommitment' in result) {
    const onChain = result.onChain === true;
    return (
      <div className={`result ${onChain ? 'result--ok' : 'result--warn'}`}>
        <div className="result__head">
          <div className="result__icon">{onChain ? '✓' : '!'}</div>
          <div>
            <div className="result__title">{onChain ? 'Admitted to the humanity group' : 'Validated off-chain'}</div>
            <div className="result__subtitle">
              {onChain
                ? 'Your anonymous identity commitment was admitted on-chain. You can now delegate to AI agents.'
                : result.note ?? 'Biometric validation passed but the commitment was not issued.'}
            </div>
          </div>
        </div>
        <div className="result__body">
          <CopyRow label="Identity commitment" value={result.identityCommitment} />
          {(result.txHashes ?? []).map((tx, i) => (
            <CopyRow key={tx} label={`Approval tx ${i + 1}`} value={tx} href={explorerLink('tx', tx)} />
          ))}
          <Metrics metrics={result.metrics} />
          <RawPayload data={result} />
        </div>
      </div>
    );
  }

  // verify() response shape
  if ('verified' in result && !('onChain' in result)) {
    if (result.verified) {
      const proof = result.proof ?? {};
      return (
        <div className="result result--ok">
          <div className="result__head">
            <div className="result__icon">✓</div>
            <div>
              <div className="result__title">Verified human</div>
              <div className="result__subtitle">This address holds a valid humanity proof on-chain.</div>
            </div>
          </div>
          <div className="result__body">
            <CopyRow label="Humanity hash" value={proof.humanityHash} />
            <CopyRow label="Validator" value={proof.validator} href={explorerLink('address', proof.validator)} />
            {proof.timestamp ? (
              <div className="kv">
                <span className="kv__key">Registered</span>
                <span className="kv__val"><span>{new Date(proof.timestamp * 1000).toLocaleString()}</span></span>
              </div>
            ) : null}
            <RawPayload data={result} />
          </div>
        </div>
      );
    }
    return (
      <div className="result result--warn">
        <div className="result__head">
          <div className="result__icon">!</div>
          <div>
            <div className="result__title">No proof found</div>
            <div className="result__subtitle">This address has not been registered as a verified human yet.</div>
          </div>
        </div>
      </div>
    );
  }

  // validate() response shape
  const onChain = result.onChain === true;
  return (
    <div className={`result ${onChain ? 'result--ok' : 'result--warn'}`}>
      <div className="result__head">
        <div className="result__icon">{onChain ? '✓' : '!'}</div>
        <div>
          <div className="result__title">
            {onChain ? 'Humanity proof registered on-chain' : 'Validated off-chain'}
          </div>
          <div className="result__subtitle">
            {onChain
              ? 'Your proof is now permanently recorded on-chain.'
              : result.note ?? 'Biometric validation passed but the proof was not registered.'}
          </div>
        </div>
      </div>
      <div className="result__body">
        <CopyRow label="Humanity hash" value={result.humanityHash} />
        <CopyRow
          label="Transaction"
          value={result.txHash}
          href={explorerLink('tx', result.txHash)}
        />
        <Metrics metrics={result.metrics} />
        <RawPayload data={result} />
      </div>
    </div>
  );
}

function ErrorCard({ error }) {
  const code = error.error ?? 'error';
  const reason = error.reason ?? error.message;
  return (
    <div className="result result--error">
      <div className="result__head">
        <div className="result__icon">✕</div>
        <div>
          <div className="result__title">Validation could not complete</div>
          <div className="result__subtitle">{reason ?? code}</div>
        </div>
      </div>
      <div className="result__body">
        <div className="kv">
          <span className="kv__key">Code</span>
          <span className="kv__val"><span>{code}</span></span>
        </div>
      </div>
    </div>
  );
}

function RawPayload({ data }) {
  return (
    <details className="raw">
      <summary>View raw response</summary>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}

function Step({ index, label, state }) {
  return (
    <div className={`step ${state}`}>
      <span className="step__dot">{state === 'is-done' ? '✓' : index}</span>
      <span className="step__label">{label}</span>
    </div>
  );
}

export function ValidationFlow() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const client = usePublicClient();
  const mode = useIssuanceMode();
  const semaphoreMode = mode === 'semaphore';
  const { unlock } = useHolderIdentity();
  const challengeRef = useRef(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [phase, setPhase] = useState(null); // null | 'signing' | 'registering'
  const [captureStatus, setCaptureStatus] = useState('loading-models');
  const busy = phase !== null;

  // Step 1 of the flow: FaceCapture asks for the server challenge (SIWE message + liveness
  // parameters) right before it starts the camera. Errors are shown here and re-thrown so
  // FaceCapture aborts.
  async function getChallenge() {
    setError(null);
    setResult(null);
    try {
      // Semaphore mode: derive the holder identity first (one wallet signature, kept in memory only)
      // so the commitment is ready to be sent together with the face samples.
      if (semaphoreMode) {
        setPhase('deriving');
        await unlock();
        setPhase(null);
      }
      const challenge = await requestChallenge(address);
      challengeRef.current = challenge;
      return challenge;
    } catch (err) {
      setPhase(null);
      setError(describeError(err));
      throw err;
    }
  }

  // Step 2: samples were captured during the liveness challenge; sign the server's message
  // to prove wallet ownership, then submit everything.
  async function handleBiometric({ samples }) {
    setError(null);
    setResult(null);
    if (!samples) {
      setError({
        error: 'descriptor_missing',
        reason:
          'The face-api models are missing (public/models), so no face samples can be captured. The proof cannot be registered.',
      });
      return;
    }
    const challenge = challengeRef.current;
    setPhase('signing');
    try {
      const signature = await signMessageAsync({ message: challenge.message });
      setPhase('registering');
      const identity = semaphoreMode ? await unlock() : null;
      const res = await validate({
        address,
        message: challenge.message,
        signature,
        nonce: challenge.nonce,
        samples,
        // Only the PUBLIC commitment leaves the browser; the identity secret never does.
        ...(identity ? { identityCommitment: identity.commitment.toString() } : {}),
      });
      setResult(res);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPhase(null);
      challengeRef.current = null;
    }
  }

  async function checkStatus() {
    setError(null);
    try {
      if (semaphoreMode) {
        // No per-address proof exists in this mode: check the holder identity's group membership.
        const identity = await unlock();
        setResult({ member: await isMember(client, appConfig.chain, identity.commitment), commitment: identity.commitment.toString() });
        return;
      }
      setResult(await verify(address));
    } catch (err) {
      setError(describeError(err));
    }
  }

  // Stepper states
  const captured = captureStatus === 'done';
  const onChain = result?.onChain === true;
  const step0 = isConnected ? 'is-done' : 'is-active';
  const step1 = !isConnected ? '' : captured || onChain || busy ? 'is-done' : 'is-active';
  const step2 = busy ? 'is-active' : onChain ? 'is-done' : '';

  return (
    <div className="card">
      <div className="stepper">
        <Step index={1} label="Connect wallet" state={step0} />
        <Step index={2} label="Biometric check" state={step1} />
        <Step index={3} label="On-chain proof" state={step2} />
      </div>

      {!isConnected ? (
        <div className="empty">
          <div className="empty__icon">🔗</div>
          <p>Connect your wallet to begin the humanity validation.</p>
        </div>
      ) : (
        <div className="stack">
          <div>
            <h2 className="card__title">Face verification &amp; liveness</h2>
            <p className="card__hint">
              {semaphoreMode
                ? 'You sign one message to derive your anonymous holder identity (it never leaves this browser), a quick blink challenge proves you are a live person, you sign a second message to prove you own this wallet, then only your identity commitment is admitted on-chain.'
                : 'A quick blink challenge proves you are a live person, you sign a message to prove you own this wallet, then your proof is registered on-chain.'}
            </p>
            <FaceCapture getChallenge={getChallenge} onResult={handleBiometric} onStatus={setCaptureStatus} />
          </div>

          {busy && (
            <span className="pill pill--info pill--busy">
              <span className="pill__dot" />
              {phase === 'deriving'
                ? 'Waiting for the identity signature in your wallet…'
                : phase === 'signing'
                  ? 'Waiting for your wallet signature…'
                  : semaphoreMode
                    ? 'Admitting your identity on-chain…'
                    : 'Registering proof on-chain…'}
            </span>
          )}

          {result && <ResultCard result={result} />}
          {error && <ErrorCard error={error} />}

          <hr className="divider" />
          <button className="btn btn--ghost btn--block" onClick={checkStatus}>
            Check my on-chain status
          </button>
        </div>
      )}
    </div>
  );
}
