import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    host: true,
    allowedHosts: true,
    /**
     * Same-origin in dev. Without this the app calls the API cross-site and the
     * session cookie needs SameSite=None + Secure, which localhost cannot have.
     * `/app` is safe to forward: every SPA route is /home, /login, /setup, /h.
     */
    proxy: {
      '/auth': { target: 'http://localhost:8000', changeOrigin: true },
      '/app': { target: 'http://localhost:8000', changeOrigin: true },
      // Prescription reading. Forwarded for the same reason as the two above, and
      // because the alternative — an absolute origin in VITE_EXTRACT_API_BASE —
      // lives in a gitignored .env that nobody has on a fresh clone.
      '/extract': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
})
