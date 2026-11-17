import { useEffect, useState } from 'react';
import { appConfig } from '../config.js';
import { getHealth } from '../api.js';

/**
 * 'semaphore' | 'legacy' | null (still resolving). Fixed by VITE_ISSUANCE_MODE, or, when that is
 * 'auto' (default), reported by the backend's /health. If the backend is unreachable it falls back
 * to 'semaphore' (the backend's default) so the flow can still show its own errors.
 */
export function useIssuanceMode() {
  const fixed = appConfig.issuanceMode === 'semaphore' || appConfig.issuanceMode === 'legacy' ? appConfig.issuanceMode : null;
  const [mode, setMode] = useState(fixed);

  useEffect(() => {
    if (fixed) return undefined;
    let alive = true;
    getHealth()
      .then((h) => alive && setMode(h.issuanceMode === 'legacy' ? 'legacy' : 'semaphore'))
      .catch(() => alive && setMode('semaphore'));
    return () => {
      alive = false;
    };
  }, [fixed]);

  return mode;
}
