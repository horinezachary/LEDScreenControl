import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the dashboard runs on Vite's port and talks to the server on 6060.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:6060',
      '/ws': { target: 'ws://localhost:6060', ws: true },
    },
  },
});
