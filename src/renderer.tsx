import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { initStore } from './store/store';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');
initStore();
createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
