import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@borealjs/grid-core/style.css';
import './app.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
