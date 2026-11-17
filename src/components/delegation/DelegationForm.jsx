import { PERMISSIONS, PERMISSION_KEYS } from '../../lib/constants.js';

/**
 * Presentational form: all state lives in the container (DelegationPanel).
 *
 * @param {object} props
 * @param {{ service: string, agent: string, ttlHours: string, permissions: string[] }} props.values
 * @param {(patch: object) => void} props.onChange
 * @param {() => void} props.onSubmit
 * @param {boolean} props.busy
 * @param {number} props.maxTtlHours  largest lifetime offered (from the contract's maxTtl)
 * @param {{ service?: string, agent?: string, ttlHours?: string, permissions?: string }} props.errors
 */
export function DelegationForm({ values, onChange, onSubmit, busy, maxTtlHours, errors }) {
  const togglePermission = (key) =>
    onChange({
      permissions: values.permissions.includes(key) ? values.permissions.filter((k) => k !== key) : [...values.permissions, key],
    });

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <Field label="Service scope" hint="Free text agreed with the service, used verbatim (e.g. service:shop.example.org). It is hashed to the scope; your nullifier differs per scope." error={errors.service}>
        <input className="input" value={values.service} onChange={(e) => onChange({ service: e.target.value })} placeholder="service:shop.example.org" disabled={busy} spellCheck="false" />
      </Field>

      <Field label="Agent address" error={errors.agent}>
        <input className="input input--mono" value={values.agent} onChange={(e) => onChange({ agent: e.target.value })} placeholder="0x…" disabled={busy} spellCheck="false" />
      </Field>

      <Field label="Permissions" error={errors.permissions}>
        <div className="checks">
          {PERMISSION_KEYS.map((key) => (
            <label className="check" key={key}>
              <input type="checkbox" checked={values.permissions.includes(key)} onChange={() => togglePermission(key)} disabled={busy} />
              <span>
                <strong>{PERMISSIONS[key].label}</strong>
                <span className="check__desc">{PERMISSIONS[key].description}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>

      <Field label="Expires in (hours)" hint={`Maximum ${maxTtlHours} h (${(maxTtlHours / 24).toFixed(1)} days), limited by the registry.`} error={errors.ttlHours}>
        <input className="input" type="number" min="1" max={maxTtlHours} step="1" value={values.ttlHours} onChange={(e) => onChange({ ttlHours: e.target.value })} disabled={busy} />
      </Field>

      <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
        Delegate to agent
      </button>
    </form>
  );
}

function Field({ label, hint, error, children }) {
  return (
    <div className="field">
      <label className="field__label">{label}</label>
      {children}
      {hint && !error && <div className="field__hint">{hint}</div>}
      {error && <div className="field__error">{error}</div>}
    </div>
  );
}
