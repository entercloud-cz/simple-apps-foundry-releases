import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// The app's theme: theme/theme.css at the repository root sets the --brand-* colours, fonts and
// corner radius that styles.css uses. A glob import, so the app builds without the file too
// (neutral look). See the ui-and-brand skill.
import.meta.glob('../../theme/theme.css', { eager: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
