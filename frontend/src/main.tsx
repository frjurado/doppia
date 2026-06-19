import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/base.css';
// Initialise i18next (side-effect import) before the app renders so the first
// paint already has the resolved language and its resource bundles.
import './i18n';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
