import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.js';
import { applyMirroredTheme } from './lib/theme.js';
import './styles.css';
import 'katex/dist/katex.min.css';
import './vault/vault.css';

// Before the first paint, and before the main process has had a chance to tell
// us what the person actually chose: whatever they were last looking at.
applyMirroredTheme();

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
