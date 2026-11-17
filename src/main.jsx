import React from 'react';
import ReactDOM from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { wagmiConfig } from './wagmi.js';
import { App } from './App.jsx';
import { HolderIdentityProvider } from './context/HolderIdentity.jsx';
import './styles/theme.css';

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <HolderIdentityProvider>
          <App />
        </HolderIdentityProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
