import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Group } from '@semaphore-protocol/group';
import {
  IDENTITY_MESSAGE_V1,
  bytes32ToPermissions,
  computeNullifier,
  deriveIdentity,
  deriveScope,
  hashToField,
  maxOfferedTtl,
  permissionsToBytes32,
  replayGroupEvents,
  unlockIdentity,
} from '../src/lib/semaphore.js';
import { MIN_TTL_SECONDS, PERMISSIONS } from '../src/lib/constants.js';
import { serializeProof } from '../src/lib/relayerClient.js';

// Anvil's well-known test keys.
const KEY_A = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KEY_B = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const signer = (key) => {
  const account = privateKeyToAccount(key);
  return (message) => account.signMessage({ message });
};

describe('deriveScope', () => {
  it('is keccak256 of the UTF-8 string, as in the backend e2e', () => {
    const service = 'service:e2e.example.org';
    expect(deriveScope(service)).toBe(BigInt(keccak256(toBytes(service))));
    // Pinned vector: a change here silently re-scopes every existing delegation.
    expect(deriveScope(service)).toBe(BigInt('0x4fdd27e0de591abb8d5bd33ea130843560f202fed102b9e225ba9e8c19e8a191'));
  });
  it('is verbatim (case and whitespace matter) and rejects empty input', () => {
    expect(deriveScope('a')).not.toBe(deriveScope('A'));
    expect(deriveScope('a')).not.toBe(deriveScope('a '));
    expect(() => deriveScope('')).toThrow();
    expect(() => deriveScope(undefined)).toThrow();
  });
});

describe('permissions bitmask', () => {
  it('maps READ|WRITE to 0x...03 (the value used by the e2e)', () => {
    expect(permissionsToBytes32(['READ', 'WRITE'])).toBe(`0x${'00'.repeat(31)}03`);
  });
  it('maps every key to its documented bit and back', () => {
    for (const [key, { bit }] of Object.entries(PERMISSIONS)) {
      const hex = permissionsToBytes32([key]);
      expect(BigInt(hex)).toBe(1n << BigInt(bit));
      expect(bytes32ToPermissions(hex)).toEqual({ keys: [key], unknownBits: 0n });
    }
    expect(permissionsToBytes32([])).toBe(`0x${'00'.repeat(32)}`);
    const all = permissionsToBytes32(Object.keys(PERMISSIONS));
    expect(bytes32ToPermissions(all).keys).toEqual(Object.keys(PERMISSIONS));
  });
  it('rejects unknown keys and reports reserved bits on decode', () => {
    expect(() => permissionsToBytes32(['ROOT'])).toThrow(/unknown permission/);
    expect(bytes32ToPermissions(`0x${'00'.repeat(30)}0101`)).toEqual({ keys: ['READ'], unknownBits: 0x100n });
  });
});

describe('identity derivation', () => {
  it('is deterministic for the same wallet and message', async () => {
    const a1 = await unlockIdentity(signer(KEY_A));
    const a2 = await unlockIdentity(signer(KEY_A));
    expect(a1.commitment).toBe(a2.commitment);
    expect(a1.secretScalar).toBe(a2.secretScalar);
  });
  it('differs per wallet', async () => {
    const a = await unlockIdentity(signer(KEY_A));
    const b = await unlockIdentity(signer(KEY_B));
    expect(a.commitment).not.toBe(b.commitment);
  });
  it('is bound to the versioned message text', async () => {
    const sign = signer(KEY_A);
    const v1 = deriveIdentity(await sign(IDENTITY_MESSAGE_V1));
    const other = deriveIdentity(await sign(IDENTITY_MESSAGE_V1.replace('(v1)', '(v2)')));
    expect(IDENTITY_MESSAGE_V1).toContain('(v1)');
    expect(v1.commitment).not.toBe(other.commitment);
  });
  it('asks the signer for exactly IDENTITY_MESSAGE_V1', async () => {
    let seen;
    await unlockIdentity(async (m) => {
      seen = m;
      return signer(KEY_A)(m);
    });
    expect(seen).toBe(IDENTITY_MESSAGE_V1);
  });
  it('rejects malformed signatures', () => {
    expect(() => deriveIdentity('0x1234')).toThrow(/invalid_signature/);
    expect(() => deriveIdentity('not hex')).toThrow(/invalid_signature/);
  });
});

describe('nullifier', () => {
  it('is deterministic, scope-specific and holder-specific', async () => {
    const a = await unlockIdentity(signer(KEY_A));
    const b = await unlockIdentity(signer(KEY_B));
    const s1 = deriveScope('service:one');
    const s2 = deriveScope('service:two');
    expect(computeNullifier(a, s1)).toBe(computeNullifier(a, s1));
    expect(computeNullifier(a, s1)).not.toBe(computeNullifier(a, s2));
    expect(computeNullifier(a, s1)).not.toBe(computeNullifier(b, s1));
  });
  it('hashToField is keccak256(uint256) >> 8 and stays inside the field', () => {
    const h = hashToField(deriveScope('service:one'));
    expect(h < 1n << 248n).toBe(true);
  });
});

describe('replayGroupEvents', () => {
  const ev = (eventName, args) => ({ eventName, args });
  it('rebuilds the same tree as direct Group operations (add, batch add, update, remove)', () => {
    const direct = new Group([11n]);
    direct.addMembers([22n, 33n]);
    direct.updateMember(1, 44n);
    direct.removeMember(0);
    direct.addMember(55n);

    const replayed = replayGroupEvents([
      ev('MemberAdded', { index: 0n, identityCommitment: 11n }),
      ev('MembersAdded', { startIndex: 1n, identityCommitments: [22n, 33n] }),
      ev('MemberUpdated', { index: 1n, identityCommitment: 22n, newIdentityCommitment: 44n }),
      ev('MemberRemoved', { index: 0n, identityCommitment: 11n }),
      ev('MemberAdded', { index: 3n, identityCommitment: 55n }),
    ]);
    expect(replayed.root).toBe(direct.root);
    expect(replayed.members).toEqual(direct.members);
  });
  it('an empty history is the empty group; unknown events are rejected', () => {
    expect(replayGroupEvents([]).members).toEqual([]);
    expect(() => replayGroupEvents([ev('Other', {})])).toThrow(/unexpected group event/);
  });
});

describe('ttl and relayer payload', () => {
  it('maxOfferedTtl leaves a margin below maxTtl but never goes under the minimum', () => {
    expect(maxOfferedTtl(30 * 86400)).toBeLessThan(30 * 86400);
    expect(maxOfferedTtl(30 * 86400)).toBeGreaterThan(29 * 86400);
    expect(maxOfferedTtl(10)).toBe(MIN_TTL_SECONDS);
  });
  it('serializeProof yields JSON-safe strings (no bigint)', () => {
    const body = serializeProof({ merkleTreeDepth: 2, merkleTreeRoot: 1n, nullifier: 2n, message: '3', scope: 4n, points: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] });
    expect(() => JSON.stringify(body)).not.toThrow();
    expect(body.points).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(body.merkleTreeDepth).toBe(2);
  });
});
