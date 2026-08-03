import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.js';
import './styles.css';
import 'katex/dist/katex.min.css';
import './vault/vault.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
