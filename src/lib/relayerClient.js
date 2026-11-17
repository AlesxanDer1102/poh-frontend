/**
 * Client of the backend relayer (POST /api/relay/*). The holder never sends delegate/revoke from
 * their own wallet: msg.sender would link the holder's address to the nullifier on-chain.
 * Plain module: the API base URL is passed in, so it also works from Node.
 */

async function post(apiUrl, path, body) {
  const res = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.reason ?? data.error ?? 'relay_failed'), { status: res.status, code: data.error, data });
  }
  return data; // { txHash, blockNumber, gasUsed }
}

/** Proof with every value as a JSON-safe string (proofs hold bigints). */
export function serializeProof(p) {
  return {
    merkleTreeDepth: Number(p.merkleTreeDepth),
    merkleTreeRoot: String(p.merkleTreeRoot),
    nullifier: String(p.nullifier),
    message: String(p.message),
    scope: String(p.scope),
    points: p.points.map(String),
  };
}

/** @returns {Promise<{ txHash: string, blockNumber: number, gasUsed: string }>} */
export function relayDelegate(apiUrl, { proof, agent, expiry, permissions, erc8004Id = 0n }) {
  return post(apiUrl, '/api/relay/delegate', {
    proof: serializeProof(proof),
    agent,
    expiry: String(expiry),
    permissions,
    erc8004Id: String(erc8004Id),
  });
}

/** @returns {Promise<{ txHash: string, blockNumber: number, gasUsed: string }>} */
export function relayRevoke(apiUrl, { proof, agent }) {
  return post(apiUrl, '/api/relay/revoke', { proof: serializeProof(proof), agent });
}
