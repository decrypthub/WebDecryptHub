import { marked } from 'marked';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';

marked.setOptions({ breaks: true, gfm: true });

export function renderMd(text) {
  try { return marked.parse(text || '', { async: false }); }
  catch { return (text || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
}
export function highlightHtml(root) {
  if (!root) return;
  root.querySelectorAll('pre code:not(.hljs)').forEach(el => { try { hljs.highlightElement(el); } catch {} });
}
