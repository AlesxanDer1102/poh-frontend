import { useState } from 'react';
import { useAccount } from 'wagmi';
import { FaceCapture } from './FaceCapture.jsx';
import { validate, verify } from '../api.js';

const EXPLORER = 'https://sepolia.etherscan.io';

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
            <CopyRow label="Validator" value={proof.validator} href={proof.validator ? `${EXPLORER}/address/${proof.validator}` : undefined} />
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
              ? 'Your proof is now permanently recorded on Ethereum Sepolia.'
              : result.note ?? 'Biometric validation passed but the proof was not registered.'}
          </div>
        </div>
      </div>
      <div className="result__body">
        <CopyRow label="Humanity hash" value={result.humanityHash} />
        <CopyRow
          label="Transaction"
          value={result.txHash}
          href={result.txHash ? `${EXPLORER}/tx/${result.txHash}` : undefined}
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
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [captureStatus, setCaptureStatus] = useState('loading-models');

  async function handleBiometric({ faceDescriptor, livenessPassed }) {
    setError(null);
    setResult(null);
    if (!faceDescriptor) {
      setError({
        error: 'descriptor_missing',
        reason:
          'Liveness passed but the face-api models are missing (public/models). No descriptor means the proof cannot be registered.',
      });
      return;
    }
    setBusy(true);
    try {
      const res = await validate({ address, faceDescriptor, livenessPassed, faceDistance: 0 });
      setResult(res);
    } catch (err) {
      setError(err.data ?? { error: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function checkStatus() {
    setError(null);
    try {
      setResult(await verify(address));
    } catch (err) {
      setError(err.data ?? { error: err.message });
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
              A quick blink challenge proves you are a live person, then your biometric
              signature is registered on-chain.
            </p>
            <FaceCapture onResult={handleBiometric} onStatus={setCaptureStatus} />
          </div>

          {busy && (
            <span className="pill pill--info pill--busy">
              <span className="pill__dot" />
              Registering proof on-chain…
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
