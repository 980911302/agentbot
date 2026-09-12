import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/01-tokens.css';
import './styles/02-base.css';
import './styles/03-layout.css';
import './styles/04-sidebar.css';
import './styles/05-chat.css';
import './styles/06-panels.css';
import './styles/07-dialog.css';
import './styles/08-animations.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root element is missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
