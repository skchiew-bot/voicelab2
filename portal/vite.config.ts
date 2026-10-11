import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The client portal, a separate app from the staff console. Built output is served by the API at /portal/.
export default defineConfig({
  base: '/portal/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: Object.fromEntries(['/client', '/health'].map((p) => [p, 'http://localhost:3000'])) },
});
