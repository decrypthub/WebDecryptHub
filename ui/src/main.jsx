import './transport.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './style.css';
// 主题初始化
const saved = localStorage.getItem('jsra_theme') || 'dark';
document.documentElement.setAttribute('data-theme', saved);
createRoot(document.getElementById('root')).render(<App />);
