import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

import { ClerkProvider } from '@clerk/clerk-react';

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!PUBLISHABLE_KEY) {
  createRoot(document.getElementById('root')!).render(
    <div style={{ padding: 40, fontFamily: 'sans-serif', textAlign: 'center', color: '#ff4444' }}>
      <h1>Falta la clave de Clerk</h1>
      <p>Añade <strong>VITE_CLERK_PUBLISHABLE_KEY</strong> en tu archivo <code>.env.local</code> (y reinicia el servidor local) o en las variables de Vercel.</p>
    </div>
  );
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
        <App />
      </ClerkProvider>
    </StrictMode>,
  );
}
