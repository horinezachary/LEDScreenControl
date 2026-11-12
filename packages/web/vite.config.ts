import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the dashboard runs on Vite's port and talks to the server on 8080.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
