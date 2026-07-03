const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

/** POST /api/validate — send biometric result, register proof on-chain. */
export async function validate({ address, faceDescriptor, livenessPassed, faceDistance }) {
  const res = await fetch(`${API_URL}/api/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, faceDescriptor, livenessPassed, faceDistance }),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error ?? 'validate_failed'), { data });
  return data;
}

/** GET /api/verify/:address — read verification status. */
export async function verify(address) {
  const res = await fetch(`${API_URL}/api/verify/${address}`);
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error ?? 'verify_failed'), { data });
  return data;
}
