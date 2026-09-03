/**
 * main.tsx — application entry point (Vite/React)
 *
 * The rebuild restores the real app shell and routing contract expected by
 * docs/ui-baseline.md, while keeping the codebase lightweight and testable.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/global.css';
import './styles/theme.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
