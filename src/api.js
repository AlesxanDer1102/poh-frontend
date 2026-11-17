const API_URL = import.meta.env?.VITE_API_URL ?? 'http://localhost:4000';

/** Fetch JSON; on a non-2xx response throw an Error carrying `data`, `status` and Retry-After. */
async function request(path, options, fallbackError) {
  const res = await fetch(`${API_URL}${path}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const retryAfter = Number(res.headers.get('Retry-After'));
    throw Object.assign(new Error(data.error ?? fallbackError), {
      status: res.status,
      data: { ...data, ...(retryAfter > 0 && data.retryAfterSec == null ? { retryAfterSec: retryAfter } : {}) },
    });
  }
  return data;
}

const postJson = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * POST /api/auth/challenge — get a single-use SIWE message plus the liveness challenge
 * parameters ({ requiredBlinks, minSamples, maxSamples, minDurationMs, maxDurationMs }).
 */
export function requestChallenge(address) {
  return request('/api/auth/challenge', postJson({ address }), 'challenge_failed');
}

/**
 * POST /api/validate — send the signed SIWE message and the descriptor samples captured
 * during the liveness challenge; the server registers the proof on-chain.
 * In semaphore issuance mode `identityCommitment` (decimal string) is required: the validators
 * admit it to the HumanityIssuer group. Omit it in legacy mode.
 */
export function validate({ address, message, signature, nonce, samples, identityCommitment }) {
  const body = { address, message, signature, nonce, samples };
  if (identityCommitment !== undefined) body.identityCommitment = identityCommitment;
  return request('/api/validate', postJson(body), 'validate_failed');
}

/** GET /health — backend status; `issuanceMode` is 'semaphore' | 'legacy'. */
export function getHealth() {
  return request('/health', undefined, 'health_failed');
}

/** GET /api/verify/:address — read verification status. */
export function verify(address) {
  return request(`/api/verify/${address}`, undefined, 'verify_failed');
}
