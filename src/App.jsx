import { WalletConnect } from './components/WalletConnect.jsx';
import { ValidationFlow } from './components/ValidationFlow.jsx';

export function App() {
  return (
    <main style={{ maxWidth: 640, margin: '2rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Proof of Humanity</h1>
      <p>Sistema híbrido de validación de usuarios humanos sobre Ethereum Sepolia.</p>
      <WalletConnect />
      <hr style={{ margin: '1.5rem 0' }} />
      <ValidationFlow />
    </main>
  );
}
