/**
 * main.tsx — application entry point (Vite/React)
 *
 * Placeholder root: routing (BrowserRouter -> RoleRouter -> shells) is a
 * separate, larger slice to be implemented against the verified contract in
 * docs/ui-baseline.md. This exists so the app is buildable while individual
 * hooks/components are implemented and tested independently.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';

function App() {
  return <div>Field Compliance Manager — rebuild in progress</div>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
