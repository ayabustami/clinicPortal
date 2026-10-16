import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

// Fade out the static boot splash from index.html once React has painted the
// app shell. No artificial delay: this runs on the first committed frame.
function dismissBootSplash() {
  const splash = document.getElementById('boot-splash');
  if (!splash) return;
  splash.classList.add('done');
  setTimeout(() => splash.remove(), 400);
}
requestAnimationFrame(() => requestAnimationFrame(dismissBootSplash));
