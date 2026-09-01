import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The dev server proxies `/api` and `/socket.io` to the backend so the browser
 * sees one origin during development. That matters for more than convenience:
 * the refresh token is an httpOnly cookie the server scopes to
 * `/api/v1/auth`, and a same-origin dev setup means the cookie behaves exactly
 * as it will in production instead of needing SameSite=None locally.
 *
 * In production the admin is served from `ADMIN_ORIGIN`, which the server
 * already allowlists for CORS with credentials, and `VITE_API_URL` points at
 * the API's real origin.
 */
export default defineConfig(({ mode }) => {
  const target = process.env.VITE_DEV_API_PROXY ?? 'http://localhost:4000'

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5174,
      proxy: {
        '/api': { target, changeOrigin: false },
        '/socket.io': { target, ws: true, changeOrigin: false },
        // The dev storage stand-in. `STORAGE_PROVIDER=local` hands back upload
        // URLs pointing at the API's own /local-storage routes; proxying them
        // keeps the whole upload same-origin in development, exactly as a real
        // provider's signed URL would be cross-origin in production.
        '/local-storage': { target, changeOrigin: false },
      },
    },
    build: {
      sourcemap: mode !== 'production',
      outDir: 'dist',
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: true,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html'],
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx'],
      },
    },
  }
})
