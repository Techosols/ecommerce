import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    // `@/features/catalogue/…` rather than `../../../features/catalogue/…`.
    // The same alias the admin uses, so moving between the two apps does not
    // mean re-learning how an import is written.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },

  server: {
    port: 5173,
    // The API is same-origin as far as the browser is concerned, which is what
    // makes the guest cart cookie work in development: a cookie set by
    // localhost:4000 would not be sent to localhost:5173, and every basket
    // would be a new one. Proxying keeps one origin.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },

  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
  },
})
