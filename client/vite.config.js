import { fileURLToPath } from 'node:url'
import autoprefixer from 'autoprefixer'
import tailwindcss from 'tailwindcss'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const rootDir = fileURLToPath(new URL('./', import.meta.url))

export default defineConfig({
  root: rootDir,
  plugins: [react()],
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          content: [`${rootDir}index.html`, `${rootDir}src/**/*.{js,jsx,ts,tsx}`],
        }),
        autoprefixer(),
      ],
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    strictPort: true,
    hmr: {
      host: 'localhost',
      protocol: 'ws',
      clientPort: 5173,
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
