import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Built output is served by the API at /admin/. In dev, API calls proxy to :3000.
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: Object.fromEntries(['/me', '/internal', '/client', '/health'].map((p) => [p, 'http://localhost:3000'])),
  },
});
