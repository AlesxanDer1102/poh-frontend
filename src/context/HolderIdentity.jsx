import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import { unlockIdentity } from '../lib/semaphore.js';

const HolderIdentityContext = createContext(null);

/**
 * Holds the holder's Semaphore identity IN MEMORY ONLY for the session: it is derived from a
 * wallet signature (see deriveIdentity in src/lib/semaphore.js), never written to localStorage,
 * cookies or the network, and dropped when the wallet account changes or disconnects.
 */
export function HolderIdentityProvider({ children }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [identity, setIdentity] = useState(null);
  const [deriving, setDeriving] = useState(false);
  const pending = useRef(null);

  // The identity belongs to one wallet: forget it if the account changes or disconnects.
  useEffect(() => {
    setIdentity(null);
    pending.current = null;
  }, [address]);

  /** Returns the identity, asking the wallet for the derivation signature if it is not unlocked yet. */
  const unlock = useCallback(async () => {
    if (identity) return identity;
    if (pending.current) return pending.current; // de-duplicate concurrent prompts
    setDeriving(true);
    const run = unlockIdentity((message) => signMessageAsync({ message }))
      .then((id) => {
        setIdentity(id);
        return id;
      })
      .finally(() => {
        pending.current = null;
        setDeriving(false);
      });
    pending.current = run;
    return run;
  }, [identity, signMessageAsync]);

  const lock = useCallback(() => setIdentity(null), []);

  const value = useMemo(
    () => ({ identity, commitment: identity ? identity.commitment.toString() : null, deriving, unlock, lock }),
    [identity, deriving, unlock, lock],
  );
  return <HolderIdentityContext.Provider value={value}>{children}</HolderIdentityContext.Provider>;
}

export function useHolderIdentity() {
  const ctx = useContext(HolderIdentityContext);
  if (!ctx) throw new Error('useHolderIdentity must be used inside <HolderIdentityProvider>');
  return ctx;
}
