import React from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import App from './App.jsx';

// /exam is a whole-window takeover with its own visual language, and it must not inherit a
// single house token: app.css pulls in fonts.css + tokens.css, so importing it statically
// here would put the brutalist theme on the exam route no matter what exam.css says. Vite
// splits a dynamic CSS import into its own chunk, so exactly one of these two sheets is
// ever fetched.
const isExam = typeof window !== 'undefined' && window.location.pathname === '/exam';

(isExam ? import('./exam/exam.css') : import('./app.css')).then(() => {
  createRoot(document.getElementById('root')).render(<App />);
});
