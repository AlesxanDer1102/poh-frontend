import { bytes32ToPermissions } from '../../lib/semaphore.js';
import { PERMISSIONS } from '../../lib/constants.js';

const short = (v, head = 8, tail = 6) => (v && v.length > head + tail + 1 ? `${v.slice(0, head)}…${v.slice(-tail)}` : v);

/**
 * Presentational list of the active agents of (scope, nullifier) with a revoke button each.
 *
 * @param {object} props
 * @param {Array<{ agent: string, permissions: string, expiry: number }>} props.delegations
 * @param {string|null} props.nullifier       the holder's per-scope pseudonym (shown for transparency)
 * @param {string|null} props.busyAgent       agent whose revocation is in progress
 * @param {boolean} props.disabled            another operation is running
 * @param {(agent: string) => void} props.onRevoke
 * @param {() => void} props.onRefresh
 */
export function DelegationList({ delegations, nullifier, busyAgent, disabled, onRevoke, onRefresh }) {
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h3 className="card__title">Active agents</h3>
          {nullifier && <div className="field__hint">Your nullifier in this scope: <code>{short(nullifier, 10, 8)}</code></div>}
        </div>
        <button className="btn btn--ghost btn--sm" onClick={onRefresh} disabled={disabled}>
          Refresh
        </button>
      </div>

      {delegations.length === 0 ? (
        <div className="field__hint">No active delegations for this service.</div>
      ) : (
        delegations.map((d) => {
          const { keys } = bytes32ToPermissions(d.permissions);
          return (
            <div className="agent" key={d.agent}>
              <div className="agent__main">
                <code className="agent__addr">{d.agent}</code>
                <div className="agent__meta">
                  {keys.length ? keys.map((k) => PERMISSIONS[k].label).join(', ') : 'No permissions'} · expires {new Date(d.expiry * 1000).toLocaleString()}
                </div>
              </div>
              <button className="btn btn--ghost btn--sm" onClick={() => onRevoke(d.agent)} disabled={disabled}>
                {busyAgent === d.agent ? 'Revoking…' : 'Revoke'}
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}
