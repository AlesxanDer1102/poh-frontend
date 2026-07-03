import { useState } from 'react';
import { useAccount } from 'wagmi';
import { FaceCapture } from './FaceCapture.jsx';
import { validate, verify } from '../api.js';

export function ValidationFlow() {
  const { address, isConnected } = useAccount();
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleBiometric({ faceDescriptor, livenessPassed }) {
    setError(null);
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

  if (!isConnected) return <p>Conectá tu wallet para iniciar la validación de humanidad.</p>;

  return (
    <div>
      <h2>Validación de humanidad</h2>
      <FaceCapture onResult={handleBiometric} />
      {busy && <p>Registrando prueba on-chain…</p>}
      <button onClick={checkStatus} style={{ marginTop: 8 }}>
        Verificar estado
      </button>
      {result && (
        <pre style={{ background: '#f4f4f4', padding: 12, overflowX: 'auto' }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
      {error && (
        <pre style={{ background: '#fde8e8', padding: 12, overflowX: 'auto' }}>
          {JSON.stringify(error, null, 2)}
        </pre>
      )}
    </div>
  );
}
