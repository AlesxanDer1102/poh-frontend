/**
 * Shared constants of the delegation feature. Plain module (no React, no Vite env) so it can be
 * used from tests and Node scripts.
 */

/**
 * Permission bitmask carried in `DelegationRegistry.delegate(..., bytes32 permissions, ...)`.
 *
 * The registry only stores the value; each SERVICE decides what the bits mean. This prototype
 * defines the following convention (bit index = position counted from the least-significant bit
 * of the bytes32, i.e. the value of the bit is `1 << bit` in the uint256 view):
 *
 *   bit 0  READ      read-only access to the service
 *   bit 1  WRITE     create/modify data in the service
 *   bit 2  TRANSACT  perform actions with side effects or cost (payments, on-chain transactions)
 *
 * Bits 3..255 are reserved. The on-chain value of `READ | WRITE` is therefore
 * 0x00...0003 (the same value the backend e2e uses).
 */
export const PERMISSIONS = Object.freeze({
  READ: { bit: 0, label: 'Read', description: 'Read-only access to the service.' },
  WRITE: { bit: 1, label: 'Write', description: 'Create or modify data in the service.' },
  TRANSACT: { bit: 2, label: 'Transact', description: 'Actions with cost or side effects (payments, transactions).' },
});

/** Keys of {@link PERMISSIONS} in bit order. */
export const PERMISSION_KEYS = Object.freeze(Object.keys(PERMISSIONS).sort((a, b) => PERMISSIONS[a].bit - PERMISSIONS[b].bit));

/**
 * Fixed, versioned, domain-separated message the holder signs to derive the Semaphore identity.
 * Changing a single character changes every holder's identity: bump the version (v2) instead of
 * editing this text, and keep v1 available if holders must be able to recover old identities.
 */
export const IDENTITY_MESSAGE_V1 = [
  'Proof of Humanity - Semaphore holder identity (v1)',
  '',
  'Signing this message derives your anonymous holder identity inside this app.',
  'It does not authorize any transaction and costs no gas.',
  'Only sign it on the official Proof of Humanity app: anyone who obtains this signature can act as your identity.',
].join('\n');

/** Smallest delegation lifetime offered by the UI (seconds). */
export const MIN_TTL_SECONDS = 60 * 60;
/** Safety margin subtracted from `maxTtl` so the expiry stays valid while the proof is generated and mined. */
export const TTL_MARGIN_SECONDS = 5 * 60;
