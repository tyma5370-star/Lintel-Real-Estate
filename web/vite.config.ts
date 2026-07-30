import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The API is proxied rather than called cross-origin, so the front end only ever
 * talks to its own origin and there is one URL to change if the port moves.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.BRIDGE_API ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
