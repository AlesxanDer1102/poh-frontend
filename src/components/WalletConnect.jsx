import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { injected } from 'wagmi/connectors';

export function WalletConnect() {
  const { address, isConnected } = useAccount();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected) {
    return (
      <div>
        <span>Conectado: {address.slice(0, 6)}…{address.slice(-4)}</span>{' '}
        <button onClick={() => disconnect()}>Desconectar</button>
      </div>
    );
  }

  return <button onClick={() => connect({ connector: injected() })}>Conectar wallet</button>;
}
