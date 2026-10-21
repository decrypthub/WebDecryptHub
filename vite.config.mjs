import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const dir = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root: path.join(dir, 'ui'),
  base: './',
  plugins: [react()],
  build: { outDir: path.join(dir, 'ui-dist'), emptyOutDir: true },
});
