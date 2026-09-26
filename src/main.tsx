import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/ui/App';
import { bootstrapApplication } from '@/application/bootstrap';
import '@/i18n'; // Phase 5: Initialize i18next before first render
import '@/styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root container in index.html');
}

// The bootstrap is awaited *before* the first render, so the subject, progression,
// preferences, shortcut, and session stores are hydrated when the Welcome screen
// first paints. It is a memoized promise, and `App` awaits the same one, so a
// StrictMode double-invoke cannot run a second migration. A bootstrap that fails
// resolves to a degraded result rather than rejecting: the app then starts on the
// legacy repository with its documented defaults instead of showing nothing.
void bootstrapApplication().finally(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
